import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const icns = join(root, "app/Resources/AppIcon.icns");

// Entry types inside an .icns file (4-byte type + 4-byte big-endian length each).
function icnsTypes(buf: Buffer): string[] {
  const types: string[] = [];
  for (let i = 8; i + 8 <= buf.length; ) {
    types.push(buf.toString("ascii", i, i + 4));
    const len = buf.readUInt32BE(i + 4);
    if (len < 8) break;
    i += len;
  }
  return types;
}

describe("Mac app icon", () => {
  // app/build.sh copies AppIcon.icns into the bundle only when it exists; without it
  // the app shows the generic macOS icon in Finder, the Dock and Command-Tab.
  it("ships an AppIcon.icns with Retina sizes up to 1024 px", () => {
    expect(existsSync(icns)).toBe(true);
    const buf = readFileSync(icns);
    expect(buf.toString("ascii", 0, 4)).toBe("icns");
    expect(icnsTypes(buf)).toEqual(expect.arrayContaining(["ic07", "ic08", "ic09", "ic10", "ic13", "ic14"]));
  });

  it("builds the bundle with that icon", () => {
    const build = readFileSync(join(root, "app/build.sh"), "utf8");
    expect(build).toContain('cp "$here/Resources/AppIcon.icns"');
    expect(build).toContain("CFBundleIconFile string AppIcon");
  });

  // Without .VolumeIcon.icns plus the volume's custom-icon flag, the mounted DMG shows a
  // generic disk icon in Finder.
  it("gives the mounted DMG the app icon", () => {
    const build = readFileSync(join(root, "app/build.sh"), "utf8");
    expect(build).toContain('"$mnt/.VolumeIcon.icns"');
    expect(build).toContain('SetFile -a C "$mnt"');
  });
});
