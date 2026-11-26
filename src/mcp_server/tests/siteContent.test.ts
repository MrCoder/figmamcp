import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Thin-content guards for figmamcp.dev (2026-11-19 SEO audit: thin leaf pages, thin locale homepages).
const root = join(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const fileFor = (pathname: string) => (pathname === "/" ? "site/index.html" : `site${pathname}/index.html`);
const locs = [...read("site/sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&(?:rsquo|lsquo);/g, "'")
    .replace(/&(?:rdquo|ldquo|quot);/g, '"')
    .replace(/&(?:mdash|ndash|middot|rarr|larr|hellip);/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#?[a-z0-9]+;/gi, " ");

// Text a reader sees in <main>: no head, nav, footer, scripts or styles, and no <pre> blocks. A <pre> holds
// commands or the agent setup prompt, which stay in English on every locale page and are not prose.
export function mainText(html: string): string {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? "";
  return decode(main.replace(/<(script|style|pre)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "));
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/g;
// Latin, Latin-extended and Cyrillic words; CJK characters are counted separately, one per character,
// because Chinese and Japanese do not separate words with spaces (a whitespace split reports /ja as ~200 words).
export function count(html: string): { words: number; cjk: number } {
  const text = mainText(html);
  const cjk = (text.match(CJK) ?? []).length;
  const words = (text.replace(CJK, " ").match(/[A-Za-z0-9À-ɏЀ-ӿ]+(?:['’-][A-Za-z0-9À-ɏЀ-ӿ]+)*/g) ?? []).length;
  return { words, cjk };
}

const LOCALES = ["/zh", "/zh-hant", "/ja", "/pl", "/fr", "/de", "/ko", "/uk"];

// Pages exempt from the word floor, each with its reason.
const FLOOR_EXEMPT = new Set([
  "/changelog", // a release list; it grows with each release, not with prose
]);
const LEAF_MIN_WORDS = 400;

// A translated leaf page lives under a locale prefix, e.g. /ja/figma-mcp-rate-limit.
const localeOf = (p: string) => LOCALES.find((l) => p.startsWith(`${l}/`));

describe("site leaf pages are not thin", () => {
  // Translated leaves are measured against their English page below, not by Latin word count.
  const leaves = locs.filter((p) => p !== "/" && !LOCALES.includes(p) && !localeOf(p) && !FLOOR_EXEMPT.has(p));

  it("covers the sitemap", () => {
    expect(leaves.length).toBeGreaterThan(40);
  });

  // The body counts below read <main>. Four pages had a second <main> nested in the first until
  // 2026-11-19; that is invalid HTML with two main landmarks.
  it("has exactly one <main> on every sitemap page", () => {
    const bad = locs.filter((p) => (read(fileFor(p)).match(/<main\b/g) ?? []).length !== 1);
    expect(bad).toEqual([]);
  });

  it(`has at least ${LEAF_MIN_WORDS} words of body text on every leaf page`, () => {
    const thin = leaves
      .map((p) => ({ p, words: count(read(fileFor(p))).words }))
      .filter(({ words }) => words < LEAF_MIN_WORDS)
      .map(({ p, words }) => `${p}: ${words}`);
    expect(thin).toEqual([]);
  });

  it("lists every /alternatives page in the sitemap and links them from /compare", () => {
    const compare = read("site/compare/index.html");
    for (const p of ["/alternatives/figma-console-mcp", "/alternatives/talk-to-figma-mcp", "/alternatives/framelink"]) {
      expect(locs).toContain(p);
      expect(`/compare links ${p}: ${compare.includes(`href="${p}"`)}`).toBe(`/compare links ${p}: true`);
    }
  });
});

describe("locale homepages match the English homepage", () => {
  const en = read("site/index.html");
  const enWords = count(en).words;
  const tags = (html: string, tag: string) =>
    ((/<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? "").match(new RegExp(`<${tag}\\b`, "g")) ?? []).length;

  // Body length relative to the English word count. A full, natural translation lands well above
  // these floors (measured 2026-11-19: de 0.93, fr 1.07, pl 0.91, uk 0.91 words per English word;
  // ja 2.38, ko 1.94, zh 1.96, zh-hant 2.08 characters per English word). A dropped section falls below.
  const FLOOR: Record<string, number> = {
    "/de": 0.8, "/fr": 0.8, "/pl": 0.8, "/uk": 0.8,
    "/ja": 1.9, "/ko": 1.6, "/zh": 1.6, "/zh-hant": 1.6,
  };
  const CJK_LOCALES = new Set(["/ja", "/ko", "/zh", "/zh-hant"]);

  for (const locale of LOCALES) {
    it(`${locale} has the same sections, FAQ and table rows as English`, () => {
      const html = read(fileFor(locale));
      for (const tag of ["h2", "h3", "details", "tr", "table"]) {
        expect(`${locale} <${tag}>: ${tags(html, tag) >= tags(en, tag)}`).toBe(`${locale} <${tag}>: true`);
      }
    });

    it(`${locale} body is as long as a full translation of the English body`, () => {
      const c = count(read(fileFor(locale)));
      const size = CJK_LOCALES.has(locale) ? c.cjk : c.words;
      const ratio = Math.round((size / enWords) * 100) / 100;
      expect(`${locale}: ${ratio >= FLOOR[locale] ? "ok" : `${ratio} < ${FLOOR[locale]}`}`).toBe(`${locale}: ok`);
    });
  }
});

describe("translated leaf pages match their English page", () => {
  const localeLeaves = locs.filter((p) => localeOf(p));
  const tags = (html: string, tag: string) =>
    ((/<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? "").match(new RegExp(`<${tag}\\b`, "g")) ?? []).length;
  // CJK characters per English word. The English page's word count is inflated by its 32-row tool table
  // (snake_case tool names split into several words, repeated cell text), so these ratios sit below the
  // homepage ones. Measured 2026-11-21 with the checker controls: ja 1.94, zh 1.22. Emptying the two
  // "How FigmaMCP differs" paragraphs falls below.
  // The five core pages added 2026-11-22, measured the same day (ja / zh): pricing 2.14 / 1.24,
  // setup 2.24 / 1.20, what-is 2.35 / 1.29, not-working 2.33 / 1.28, tutorial 2.09 / 1.20.
  // Each floor sits about 0.1 below, so dropping one section or table falls below.
  const FLOOR: Record<string, number> = {
    "/ja/figma-mcp-rate-limit": 1.8,
    "/zh/figma-mcp-rate-limit": 1.12,
    "/ja/pricing": 2.0,
    "/zh/pricing": 1.14,
    "/ja/docs/setup": 2.1,
    "/zh/docs/setup": 1.1,
    "/ja/what-is-figma-mcp": 2.2,
    "/zh/what-is-figma-mcp": 1.18,
    "/ja/troubleshooting/not-working": 2.2,
    "/zh/troubleshooting/not-working": 1.18,
    "/ja/tutorials/edit-figma-with-claude-code": 1.95,
    "/zh/tutorials/edit-figma-with-claude-code": 1.1,
  };

  it("covers the translated rate limit pages", () => {
    expect(localeLeaves).toContain("/ja/figma-mcp-rate-limit");
    expect(localeLeaves).toContain("/zh/figma-mcp-rate-limit");
    for (const path of Object.keys(FLOOR)) expect(localeLeaves).toContain(path);
  });

  for (const path of localeLeaves) {
    const english = path.slice(localeOf(path)!.length);

    it(`${path} has an English page and the same sections, lists, FAQ and table rows`, () => {
      expect(locs).toContain(english);
      const html = read(fileFor(path));
      const en = read(fileFor(english));
      for (const tag of ["h2", "h3", "details", "tr", "table", "li"]) {
        expect(`${path} <${tag}>: ${tags(html, tag) >= tags(en, tag)}`).toBe(`${path} <${tag}>: true`);
      }
    });

    it(`${path} body is as long as a full translation of ${english}`, () => {
      const floor = FLOOR[path];
      expect(`${path}: floor ${floor === undefined ? "missing" : "set"}`).toBe(`${path}: floor set`);
      const ratio = Math.round((count(read(fileFor(path))).cjk / count(read(fileFor(english))).words) * 100) / 100;
      expect(`${path}: ${ratio >= floor ? "ok" : `${ratio} < ${floor}`}`).toBe(`${path}: ok`);
    });
  }
});
