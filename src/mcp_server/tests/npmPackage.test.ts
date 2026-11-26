import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const pkg = JSON.parse(read("package.json"));

describe("published npm package", () => {
  it("ships only the files users run, not the private source", () => {
    expect([...pkg.files].sort()).toEqual([
      "LICENSE",
      "README.md",
      "dist/figmamcp.js",
      "dist/server.js",
      "dist/socket.js",
      "figma_plugin/code.js",
      "figma_plugin/manifest.json",
      "figma_plugin/ui.html",
      "icon.png",
      "skills",
    ]);
  });

  it("minifies the published bundles", () => {
    expect(read("tsup.config.ts")).toMatch(/minify:\s*true/);
  });

  it("points people at the public releases repository", () => {
    expect(pkg.repository.url).toContain("MrCoder/figmamcp-releases");
  });

  it("does not advertise a licence, but keeps the upstream notices", () => {
    expect(pkg.license).toBe("SEE LICENSE IN LICENSE");
    expect(read("README.md")).not.toMatch(/\bMIT\b/);
    expect(read("LICENSE")).toContain("sonnylazuardi");
    expect(read("LICENSE")).toContain("Neo Product LLC");
  });

  it("does not link the README to private repository pages", () => {
    expect(read("README.md")).not.toMatch(/github\.com\/MrCoder\/figmamcp\/|CONTRIBUTING\.md/);
  });
});
