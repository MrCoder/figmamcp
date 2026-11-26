import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const locs = [...read("site/sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

describe("site URLs", () => {
  it("serves pages at the URLs the sitemap lists, without a redirect", () => {
    const config = JSON.parse(read("wrangler.jsonc"));
    expect(config.assets.html_handling).toBe("drop-trailing-slash");
  });

  it("lists sitemap URLs without a trailing slash, except the home page", () => {
    expect(locs.length).toBeGreaterThan(0);
    for (const loc of locs) {
      if (loc !== "https://figmamcp.dev/") expect(loc.endsWith("/")).toBe(false);
    }
  });

  it("redirects the old Claude Code URL permanently and no longer lists it", () => {
    expect(read("site/_redirects")).toContain("/claude-code-edit-figma /integrations/claude-code 301");
    expect(existsSync(join(root, "site/claude-code-edit-figma/index.html"))).toBe(false);
    expect(locs).not.toContain("https://figmamcp.dev/claude-code-edit-figma");
  });

  it("only links to pages that exist", () => {
    const pages = new Set(locs.map((loc) => new URL(loc).pathname));
    const extra = new Set(["/download"]);
    for (const loc of locs) {
      const path = new URL(loc).pathname;
      const html = read(path === "/" ? "site/index.html" : `site${path}/index.html`);
      for (const [, href] of html.matchAll(/href="(\/[^"#]*)/g)) {
        if (/\.[a-z]+$/.test(href) || extra.has(href)) continue;
        expect(`${path} -> ${pages.has(href) ? "ok" : href}`).toBe(`${path} -> ok`);
      }
    }
  });

  it("does not offer a terminal install while the npm package is unpublished", () => {
    for (const loc of locs) {
      const path = new URL(loc).pathname;
      const html = read(path === "/" ? "site/index.html" : `site${path}/index.html`);
      expect(`${path}: ${/one terminal command|npx /.test(html)}`).toBe(`${path}: false`);
    }
  });

  it("uses the sitemap URL as the canonical URL of each page", () => {
    for (const loc of locs) {
      const path = new URL(loc).pathname;
      const html = read(path === "/" ? "site/index.html" : `site${path}/index.html`);
      expect(html).toContain(`<link rel="canonical" href="${loc}"`);
    }
  });
});
