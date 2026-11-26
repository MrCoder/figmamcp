#!/bin/bash
# Builds the standalone macOS programs (no Node.js needed) with `bun build --compile`.
#
#   dist-bin/<arch>/figmamcp          setup / doctor / status
#   dist-bin/<arch>/figmamcp-server   the MCP server (stdio)
#   dist-bin/<arch>/figmamcp-relay    the local relay
#   dist-bin/<arch>/figma_plugin/     manifest.json, code.js, ui.html (copied; run `bun run plugin:build` first)
#   dist-bin/<arch>/skills/figmamcp/  the skill (SKILL.md, references/)
#   dist-bin/<arch>/package.json      version source for setup
#
# dist-bin/universal/ holds fat binaries for the Mac app.
# <arch> is arm64 and x64. Each folder is self-contained: `figmamcp setup` finds figma_plugin/ and
# skills/ next to itself (or via --resources <folder>) and installs copies into ~/.figmamcp.
#
# Usage: scripts/build-binaries.sh [arm64] [x64]      (default: both)
# Cross-compiling needs network access the first time: bun downloads the target runtime.
set -euo pipefail

cd "$(dirname "$0")/.."
ARCHES=("$@")
[ ${#ARCHES[@]} -eq 0 ] && ARCHES=(arm64 x64)

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || bun -e "console.log(require('./package.json').version)")"
for f in figma_plugin/manifest.json figma_plugin/code.js figma_plugin/ui.html skills/figmamcp/SKILL.md; do
  [ -f "$f" ] || { echo "Missing $f. Run: bun run build:all" >&2; exit 1; }
done

build() { # <arch> <entry> <outfile>
  local target="bun-darwin-$1"
  # Baseline runs on Intel Macs without AVX2 and under Rosetta.
  [ "$1" = x64 ] && target="bun-darwin-x64-baseline"
  bun build --compile --minify "--target=$target" \
    --define "__FIGMAMCP_VERSION__=\"$VERSION\"" \
    "$2" --outfile "$3"
}

for arch in "${ARCHES[@]}"; do
  case "$arch" in arm64|x64) ;; *) echo "Unknown arch $arch (use arm64 or x64)" >&2; exit 1 ;; esac
  out="dist-bin/$arch"
  rm -rf "$out"
  mkdir -p "$out/figma_plugin" "$out/skills"
  echo "== $arch (version $VERSION)"
  build "$arch" src/setup/entry-cli.ts "$out/figmamcp"
  build "$arch" src/setup/entry-server.ts "$out/figmamcp-server"
  build "$arch" src/setup/entry-relay.ts "$out/figmamcp-relay"
  cp figma_plugin/manifest.json figma_plugin/code.js figma_plugin/ui.html "$out/figma_plugin/"
  cp -R skills/figmamcp "$out/skills/figmamcp"
  cp package.json "$out/package.json"
  chmod +x "$out/figmamcp" "$out/figmamcp-server" "$out/figmamcp-relay"
done
# One folder with fat binaries for the Mac app, when both architectures were built.
if [ -d dist-bin/arm64 ] && [ -d dist-bin/x64 ]; then
  out=dist-bin/universal
  rm -rf "$out"; mkdir -p "$out"
  cp -R dist-bin/arm64/figma_plugin dist-bin/arm64/skills dist-bin/arm64/package.json "$out/"
  for b in figmamcp figmamcp-server figmamcp-relay; do
    lipo -create "dist-bin/arm64/$b" "dist-bin/x64/$b" -output "$out/$b"
  done
fi
echo "Built: $(ls -d dist-bin/*/ | tr '\n' ' ')"
