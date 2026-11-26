import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Homepage FAQ guard: the visible FAQ and the FAQPage JSON-LD must list the same questions in the same
// order, and the two questions added from the 2026-11-24 Product Hunt thread must be present everywhere.
const root = join(import.meta.dir, "../../..");
const PAGES = ["", "de", "fr", "pl", "uk", "ja", "ko", "zh", "zh-hant"].map((l) => (l ? `site/${l}/index.html` : "site/index.html"));

const plain = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:rsquo|lsquo);/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[‘’]/g, "'")
    .trim();

function faq(path: string) {
  const html = readFileSync(join(root, path), "utf8");
  const section = /<section[^>]*id="faq"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";
  const entries = [...section.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>\s*<div class="ans">([\s\S]*?)<\/div>\s*<\/details>/g)].map((m) => ({
    q: plain(m[1] ?? ""),
    aHtml: m[2] ?? "",
    a: plain(m[2] ?? ""),
  }));
  const ld = /<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org","@type":"FAQPage"[\s\S]*?)<\/script>/.exec(html)?.[1] ?? "{}";
  const names: string[] = (JSON.parse(ld).mainEntity ?? []).map((e: { name: string }) => plain(e.name));
  return { entries, names };
}

describe("homepage FAQ", () => {
  for (const page of PAGES) {
    describe(page, () => {
      const { entries, names } = faq(page);
      it("has 11 visible entries", () => expect(entries.length).toBe(11));
      it("JSON-LD names equal visible summaries in order", () => expect(names).toEqual(entries.map((e) => e.q)));
      it("links to the official-MCP comparison", () => expect(entries.some((e) => e.aHtml.includes('href="/compare/official-figma-mcp"'))).toBe(true));
    });
  }

  describe("English wording", () => {
    const { entries } = faq("site/index.html");
    it("Q1 compares with the official server and links the comparison", () => {
      expect(entries[1]?.q).toBe("How is it different from Figma's official MCP server?");
      expect(entries[1]?.aHtml).toContain('<a href="/compare/official-figma-mcp">full comparison</a>');
    });
    it("Q2 says whose Figma edits and how conflicts settle", () => {
      expect(entries[2]?.q).toBe("If two people have the same file open, whose Figma does the agent edit?");
      expect(entries[2]?.a).toMatch(/Mac where the agent runs/);
      expect(entries[2]?.a).toMatch(/last change wins/);
    });
  });
});
