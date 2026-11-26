import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// /pricing gets "figma mcp enterprise pricing" impressions (Search Console 2026-11-08..11-20: 10 at position 9.0)
// but had no answer for Enterprise beyond one table row. These guards keep the Enterprise answer and keep the
// pricing page's limits in step with the rate-limit page, which is the page rechecked against Figma's docs.
const root = join(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const PAGES = ["site/pricing/index.html", "site/ja/pricing/index.html", "site/zh/pricing/index.html"];

const faqJsonLd = (html: string): string[] => {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const data = JSON.parse(m[1]);
    if (data["@type"] === "FAQPage") return data.mainEntity.map((q: { name: string }) => q.name);
  }
  return [];
};
const summaries = (html: string): string[] =>
  [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map((m) =>
    m[1].replace(/&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/<[^>]+>/g, "").trim(),
  );

const rateLimitCheck = /checked (\d{4}-\d{2}-\d{2})/.exec(read("site/figma-mcp-rate-limit/index.html"))![1];

describe("/pricing answers the Enterprise question", () => {
  for (const page of PAGES) {
    const html = read(page);

    it(`${page} has an Enterprise FAQ entry in both the page and FAQPage JSON-LD`, () => {
      const visible = summaries(html).filter((s) => /Enterprise/.test(s));
      expect(visible.length).toBe(1);
      expect(faqJsonLd(html)).toContain(visible[0]);
    });

    it(`${page} Enterprise answer states 600 per day and links the rate-limit page`, () => {
      const details = [...html.matchAll(/<details>([\s\S]*?)<\/details>/g)].map((m) => m[1]);
      const ent = details.find((d) => /<summary>[^<]*Enterprise/.test(d)) ?? "";
      expect(ent).toMatch(/600/);
      expect(ent).toMatch(/href="\/(?:ja\/|zh\/)?figma-mcp-rate-limit"/);
    });
  }

  it("English /pricing limits table carries the same check date as the rate-limit page", () => {
    const html = read("site/pricing/index.html");
    const source = /Source: <a href="https:\/\/developers\.figma\.com\/docs\/figma-mcp-server\/rate-limits-access\/">[^<]*<\/a>, checked ([^.]+)\./.exec(
      html,
    )![1];
    expect(source).toBe(rateLimitCheck);
  });
});
