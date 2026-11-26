#!/bin/bash
# Render app/Resources/AppIcon.svg into AppIcon.icns (Mac app) and ../icon.png (npm, MCP manifest).
# Needs rsvg-convert (brew install librsvg) and iconutil (macOS).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
svg="$here/Resources/AppIcon.svg"
tmp="$(mktemp -d)"; set_dir="$tmp/AppIcon.iconset"; mkdir "$set_dir"
for s in 16 32 128 256 512; do
  rsvg-convert -w $s -h $s "$svg" -o "$set_dir/icon_${s}x${s}.png"
  rsvg-convert -w $((s*2)) -h $((s*2)) "$svg" -o "$set_dir/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$set_dir" -o "$here/Resources/AppIcon.icns"
cp "$set_dir/icon_512x512@2x.png" "$here/../icon.png"
rm -rf "$tmp"
echo "Wrote $here/Resources/AppIcon.icns and icon.png"
