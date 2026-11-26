#!/bin/bash
# Build, sign (hardened runtime) and package FigmaMCP.app as a DMG.
#
#   app/build.sh              build app + DMG into app/build/
#   app/build.sh notarize     notarize and staple the app, rebuild the DMG, notarize and staple the DMG (needs notarytool keychain profile "figmamcp")
#
# CI (see documentation/build-pipeline-options.md) sets these instead of using the owner's keychain:
#   SIGN_IDENTITY="-"           ad-hoc sign (no certificate). Used for unsigned dry runs; `notarize` refuses it.
#   NOTARY_KEY, NOTARY_KEY_ID, NOTARY_ISSUER
#                               App Store Connect team API key (.p8 path, key ID, issuer ID) for notarytool,
#                               used instead of the "figmamcp" keychain profile when all three are set.
#   NOTARY_TIMEOUT              notarytool --wait timeout (default 30m)
#
# Environment:
#   FIGMAMCP_BIN_DIR   folder holding figmamcp, figmamcp-server, figmamcp-relay (default: <repo>/dist-bin/universal)
#   SIGN_IDENTITY      codesign identity (default: Developer ID Application: Peng Xiao (V7P333H7L7))
#   VERSION            app version (default: version in ../package.json, else 0.0.0)
#   ARCHS              "arm64 x86_64" (default) or a single arch
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
out="$here/build"
app="$out/FigmaMCP.app"
identity="${SIGN_IDENTITY:-Developer ID Application: Peng Xiao (V7P333H7L7)}"
bindir="${FIGMAMCP_BIN_DIR:-$repo/dist-bin/universal}"
version="${VERSION:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$repo/package.json" 2>/dev/null | head -1)}"
version="${version:-0.0.0}"
dmg="$out/FigmaMCP-$version.dmg"
# A secure timestamp needs a real identity; ad-hoc signatures cannot carry one.
# (Expanded as ${ts[@]+...} because macOS bash 3.2 treats an empty array as unset under set -u.)
ts=(--timestamp); [ "$identity" = "-" ] && ts=()
# notarytool credentials: the owner's keychain profile, or an API key in CI.
if [ -n "${NOTARY_KEY:-}" ] && [ -n "${NOTARY_KEY_ID:-}" ] && [ -n "${NOTARY_ISSUER:-}" ]; then
  notary_auth=(--key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
else
  notary_auth=(--keychain-profile figmamcp)
fi
notary_timeout="${NOTARY_TIMEOUT:-30m}"

# Package $app as a signed DMG. Used by the build, and again by `notarize`
# after the app has its ticket stapled.
make_dmg() {
  echo "==> dmg $dmg"
  stage="$(mktemp -d)"; cp -R "$app" "$stage/"; ln -s /Applications "$stage/Applications"
  # Writable image first, so the volume can carry the app icon (.VolumeIcon.icns + custom-icon flag).
  rw="$out/FigmaMCP-rw.dmg"; rm -f "$rw"
  hdiutil create -volname "FigmaMCP" -srcfolder "$stage" -ov -format UDRW "$rw" >/dev/null
  rm -rf "$stage"
  if [ -f "$here/Resources/AppIcon.icns" ]; then
    mnt="$(mktemp -d)"
    hdiutil attach -nobrowse -noautoopen -mountpoint "$mnt" "$rw" >/dev/null
    cp "$here/Resources/AppIcon.icns" "$mnt/.VolumeIcon.icns"
    xcrun SetFile -a C "$mnt"
    hdiutil detach "$mnt" >/dev/null
  fi
  hdiutil convert "$rw" -format UDZO -ov -o "$dmg" >/dev/null
  rm -f "$rw"
  codesign --force ${ts[@]+"${ts[@]}"} --sign "$identity" "$dmg"
  codesign --verify --verbose=2 "$dmg"
}

if [ "${1:-}" = "notarize" ]; then
  [ -d "$app" ] && [ -f "$dmg" ] || { echo "No $app or $dmg. Run app/build.sh first."; exit 1; }
  [ "$identity" != "-" ] || { echo "Cannot notarize an ad-hoc signed app. Set SIGN_IDENTITY to a Developer ID identity."; exit 1; }
  if ! xcrun notarytool history "${notary_auth[@]}" >/dev/null 2>&1; then
    if [ -n "${NOTARY_KEY:-}" ]; then echo "notarytool rejected the API key (NOTARY_KEY, NOTARY_KEY_ID, NOTARY_ISSUER)."; exit 1; fi
    echo "Skipping notarization: no notarytool keychain profile named 'figmamcp'."
    echo "Create one with: xcrun notarytool store-credentials figmamcp"
    exit 0
  fi
  # 1. Notarize the app itself and staple its ticket, so the copy in /Applications
  #    passes Gatekeeper with no online ticket lookup (a stapled DMG does not cover it).
  zip="$out/FigmaMCP-$version.zip"; rm -f "$zip"
  ditto -c -k --keepParent "$app" "$zip"
  xcrun notarytool submit "$zip" "${notary_auth[@]}" --wait --timeout "$notary_timeout"
  rm -f "$zip"
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  # 2. Rebuild the DMG around the stapled app, then notarize and staple the DMG.
  make_dmg
  xcrun notarytool submit "$dmg" "${notary_auth[@]}" --wait --timeout "$notary_timeout"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  # 3. Check both the way Gatekeeper does.
  spctl -a -t open --context context:primary-signature -vv "$dmg"
  spctl -a -t exec -vv "$app"
  mnt="$(mktemp -d)"
  hdiutil attach -nobrowse -noautoopen -readonly -mountpoint "$mnt" "$dmg" >/dev/null
  rc=0; xcrun stapler validate "$mnt/FigmaMCP.app" || rc=$?
  hdiutil detach "$mnt" >/dev/null
  [ "$rc" -eq 0 ] || { echo "The app inside the DMG has no stapled ticket."; exit 1; }
  echo "Notarized and stapled: $app and $dmg"
  exit 0
fi

for b in figmamcp figmamcp-server figmamcp-relay; do
  [ -f "$bindir/$b" ] || { echo "Missing $bindir/$b. Build dist-bin first, or set FIGMAMCP_BIN_DIR."; exit 1; }
done

archs=(${ARCHS:-arm64 x86_64})
arch_flags=(); for a in "${archs[@]}"; do arch_flags+=(--arch "$a"); done
echo "==> swift build (release, ${archs[*]})"
(cd "$here" && swift build -c release "${arch_flags[@]}")
bin_path="$(cd "$here" && swift build -c release "${arch_flags[@]}" --show-bin-path)"

echo "==> assemble $app"
rm -rf "$out"; mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/bin"
cp "$bin_path/FigmaMCP" "$app/Contents/MacOS/FigmaMCP"
sed -e "s/__VERSION__/$version/" -e "s/__BUILD__/$(date +%Y%m%d%H%M)/" "$here/Resources/Info.plist" > "$app/Contents/Info.plist"
for b in figmamcp figmamcp-server figmamcp-relay; do
  cp "$bindir/$b" "$app/Contents/Resources/bin/$b"; chmod 755 "$app/Contents/Resources/bin/$b"
done
# `figmamcp setup` finds these next to the program and installs copies into ~/.figmamcp.
cp -R "$bindir/figma_plugin" "$bindir/skills" "$bindir/package.json" "$app/Contents/Resources/bin/"
# Any other resources (plugin files, skill, icon) shipped next to the binaries.
# The upstream MIT licence requires its notice in every copy we distribute.
cp "$here/../LICENSE" "$app/Contents/Resources/THIRD_PARTY_NOTICES.txt"
[ -d "$here/Resources/extra" ] && cp -R "$here/Resources/extra/." "$app/Contents/Resources/"
[ -f "$here/Resources/AppIcon.icns" ] && { cp "$here/Resources/AppIcon.icns" "$app/Contents/Resources/"; /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string AppIcon" "$app/Contents/Info.plist"; }

echo "==> codesign (hardened runtime) as: $identity"
# The compiled Bun programs need JIT under the hardened runtime.
# Inside-out: nested executables first, then the app. No --deep.
for b in "$app"/Contents/Resources/bin/figmamcp*; do
  codesign --force --options runtime ${ts[@]+"${ts[@]}"} --entitlements "$here/Resources/BunRuntime.entitlements" --sign "$identity" "$b"
done
codesign --force --options runtime ${ts[@]+"${ts[@]}"} --entitlements "$here/Resources/FigmaMCP.entitlements" --sign "$identity" "$app"
codesign --verify --deep --strict --verbose=2 "$app"
codesign -dvv "$app" 2>&1 | grep -E "Identifier|Authority|flags|TeamIdentifier|Timestamp"

make_dmg
echo "Done: $dmg"
echo "Next (optional): app/build.sh notarize"
