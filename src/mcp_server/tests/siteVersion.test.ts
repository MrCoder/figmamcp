import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === "index.html" ? [path] : [];
  });
}

describe("site download button", () => {
  // /download always serves the latest GitHub release, so the label next to it must
  // name the version in package.json; a release bump that forgets the site goes red.
  it("shows the current version next to every Download button", () => {
    const withButton = pages(join(root, "site")).filter((p) => readFileSync(p, "utf8").includes('class="btn" href="/download"'));
    expect(withButton.length).toBeGreaterThan(0);
    for (const page of withButton) {
      const html = readFileSync(page, "utf8");
      const buttons = html.match(/<a class="btn" href="\/download">[^<]*<\/a>/g) ?? [];
      const labels = html.match(/<a class="btn" href="\/download">[^<]*<\/a> <span class="ver">Version ([0-9.]+)<\/span>/g) ?? [];
      expect(`${page.slice(root.length)}: ${labels.length}/${buttons.length}`).toBe(`${page.slice(root.length)}: ${buttons.length}/${buttons.length}`);
      for (const l of labels) expect(l).toContain(`Version ${version}<`);
    }
  });
});
