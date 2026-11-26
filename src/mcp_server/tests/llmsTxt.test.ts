import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// llms.txt (llmstxt.org): a Markdown index of the site for AI agents, served as a static asset.
const root = join(import.meta.dir, "../../..");
const path = join(root, "site/llms.txt");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const llms = existsSync(path) ? readFileSync(path, "utf8") : "";
const locs = new Set([...read("site/sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));

// PRODUCT.md wording rules, same as the site pages.
const BANNED = /open[- ]?source|\bMIT\b|unlimited|bypass|workaround|\bnpx\b|\bnpm\b|\bbunx\b/i;

describe("site/llms.txt", () => {
  it("exists in the static asset directory and is not routed to the worker", () => {
    expect(existsSync(path)).toBe(true);
    const config = JSON.parse(read("wrangler.jsonc"));
    expect(config.assets.directory).toBe("./site");
    expect(config.assets.run_worker_first).toContain("!/llms.txt");
  });

  it("is served as UTF-8, since it names the locale homepages in their own scripts", () => {
    expect(read("site/_headers")).toMatch(/^\/llms\.txt\n  Content-Type: text\/plain; charset=utf-8$/m);
  });

  it("follows the llms.txt shape: H1, blockquote summary, H2 link sections", () => {
    expect(llms.startsWith("# FigmaMCP\n")).toBe(true);
    const summary = llms.split("\n").find((l) => l.startsWith("> "));
    // The blockquote reuses the homepage meta description word for word.
    const meta = /<meta name="description" content="([^"]+)">/.exec(read("site/index.html"))?.[1];
    expect(summary).toBe(`> ${meta}`);
    expect(llms).toMatch(/^## /m);
  });

  it("links the key pages with absolute URLs", () => {
    for (const p of ["/docs/setup", "/what-is-figma-mcp", "/how-figma-mcp-works", "/pricing", "/tools", "/compare", "/troubleshooting", "/use-cases", "/changelog", "/figma-mcp-source", "/privacy"]) {
      expect(llms).toContain(`(https://figmamcp.dev${p})`);
    }
    for (const [, href] of llms.matchAll(/\]\(([^)]+)\)/g)) expect(href).toMatch(/^https:\/\//);
  });

  it("only links pages the site serves", () => {
    for (const [, href] of llms.matchAll(/\]\((https:\/\/figmamcp\.dev[^)]*)\)/g)) {
      const pathname = new URL(href).pathname;
      const served = locs.has(href) || pathname === "/download" || existsSync(join(root, "site", pathname));
      expect(`${href}: ${served}`).toBe(`${href}: true`);
    }
  });

  it("carries none of the banned phrases or HTML entities", () => {
    expect(llms).not.toMatch(BANNED);
    expect(llms).not.toMatch(/&[a-z#0-9]+;/i);
  });
});
