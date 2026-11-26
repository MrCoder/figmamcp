import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// Growth plan action 4: Japanese and Simplified Chinese versions of /figma-mcp-rate-limit.
// The English page is the source of truth; every fact below is parsed from it, not hard-coded.
const root = join(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const SITE = "https://figmamcp.dev";
const EN = "/figma-mcp-rate-limit";
const LOCALES = {
  "/ja": { kind: { read: "読み取り", write: "書き込み" }, counts: "上限に含まれる", exempt: "対象外", homeLink: "Figma MCP レート制限", canWrite: "公式サーバーはFigmaファイルに書き込めます" },
  "/zh": { kind: { read: "读取", write: "写入" }, counts: "计入限额", exempt: "不计入", homeLink: "Figma MCP 速率限制", canWrite: "官方服务器可以写入 Figma 文件" },
} as const;

const en = read(`site${EN}/index.html`);
const main = (html: string) => /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "";
const text = (s: string) => s.replace(/<[^>]+>/g, "").trim();
// The "Last updated" stamp is set from git by site:dates on every page edit (a version bump too); it is not a check date.
const body = (html: string) => main(html).replace(/<p class="measure fine updated">[\s\S]*?<\/p>/, "");
const description = (html: string) => /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? "";
// The first table on the page is the limits by plan: one number sequence per row.
const limitRows = (html: string) => {
  const table = /<table>([\s\S]*?)<\/table>/.exec(main(html))?.[1] ?? "";
  return [...table.matchAll(/<tr><th scope="row">[^<]*<\/th><td>([^<]*)<\/td>/g)].map((m) => [...m[1].matchAll(/\d+/g)].map((n) => Number(n[0])));
};
const toolRows = (html: string) =>
  [...main(html).matchAll(/<tr data-tool="([^"]+)" data-kind="([^"]+)" data-counts="([^"]+)"><th scope="row"><code>([^<]+)<\/code><\/th><td>([^<]*)<\/td><td>([^<]*)<\/td><\/tr>/g)].map((m) => ({
    tool: m[1], kind: m[2], counts: m[3], name: m[4], kindText: m[5], countsText: m[6],
  }));
const dates = (s: string) => new Set([...s.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((m) => m[0]));
const options = (html: string) =>
  [...main(html).matchAll(/<option value="([^"]+)" data-row="([^"]+)" data-limit="(\d+)" data-period="(month|day)"(?: data-minute="(\d+)")?>/g)].map((m) => ({
    value: m[1], row: m[2], limit: Number(m[3]), period: m[4], minute: m[5] ? Number(m[5]) : null,
  }));
const hreflang = (html: string) => new Map([...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => [m[1], m[2]] as [string, string]));
// `sub` appears in `seq` in order, each as a whole number (the Japanese "1日200回" also carries a 1).
const inOrder = (seq: number[], sub: number[]) => {
  let i = 0;
  for (const n of seq) if (n === sub[i]) i++;
  return i === sub.length;
};

const enDate = /checked (\d{4}-\d{2}-\d{2})/.exec(main(en))?.[1];
const enLimits = limitRows(en);
const enTools = toolRows(en);

describe("rate limit page: English source facts", () => {
  it("parses the check date, six plan rows and the tool table from the English page", () => {
    expect(enDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(enLimits.length).toBe(6);
    expect(enTools.length).toBeGreaterThanOrEqual(30);
  });

  it("uses one check date in the English body and the same date in its meta description", () => {
    expect([...dates(text(body(en)))]).toEqual([enDate!]);
    expect([...dates(description(en))]).toEqual([enDate!]);
  });
});

for (const [prefix, words] of Object.entries(LOCALES)) {
  const path = `${prefix}${EN}`;
  const file = `site${path}/index.html`;

  describe(`rate limit page ${path}`, () => {
    const html = existsSync(join(root, file)) ? read(file) : "";

    it("exists, is in the sitemap and in llms.txt", () => {
      expect(html.length).toBeGreaterThan(0);
      expect(read("site/sitemap.xml")).toContain(`<loc>${SITE}${path}</loc>`);
      expect(read("site/llms.txt")).toContain(`(${SITE}${path})`);
    });

    it("carries the same limits, row by row, as the English page", () => {
      const rows = limitRows(html);
      expect(rows.length).toBe(enLimits.length);
      enLimits.forEach((want, i) => expect(`row ${i + 1}: ${rows[i]} has ${want}: ${inOrder(rows[i], want)}`).toBe(`row ${i + 1}: ${rows[i]} has ${want}: true`));
    });

    it("states the English check date, and no other date, in its body and description", () => {
      expect([...dates(text(body(html)))]).toEqual([enDate!]);
      expect([...dates(description(html))]).toEqual([enDate!]);
    });

    it("lists the same tools as English, each read or write and counted or exempt as English says, in its own words", () => {
      const rows = toolRows(html);
      expect(rows.map((r) => `${r.tool} ${r.kind} ${r.counts}`)).toEqual(enTools.map((r) => `${r.tool} ${r.kind} ${r.counts}`));
      for (const r of rows) {
        const shown = `${r.tool}: ${r.name} ${r.kindText} ${r.counts === "yes" ? r.countsText : r.countsText.split("：")[0]}`;
        expect(shown).toBe(`${r.tool}: ${r.tool} ${words.kind[r.kind as "read" | "write"]} ${r.counts === "yes" ? words.counts : words.exempt}`);
      }
    });

    it("runs the shared checker script, with controls hidden until it loads and no inline script or style", () => {
      expect(html).toContain('<script src="/rate-limit-checker.js" defer></script>');
      expect(main(html)).toMatch(/<div id="rl-checker" class="checker" hidden>/);
      expect(main(html)).toMatch(/<label for="rl-plan">/);
      expect(main(html)).toContain('<table id="rl-tools">');
      expect(main(html)).toMatch(/<output id="rl-result"[^>]*aria-live="polite"[^>]*hidden>/);
      const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1].trim());
      expect(inline.every((a) => a === 'type="application/ld+json"')).toBe(true);
      expect(html).not.toMatch(/<style\b|\sstyle="/);
      expect([...html.matchAll(/<main\b/g)].length).toBe(1);
    });

    it("offers the same six plans as English, each with the numbers of its own row in this page's limits table", () => {
      const got = options(html);
      expect(got.map((o) => `${o.value} ${o.limit} ${o.period} ${o.minute}`)).toEqual(options(en).map((o) => `${o.value} ${o.limit} ${o.period} ${o.minute}`));
      const rows = new Map([...(/<table>([\s\S]*?)<\/table>/.exec(main(html))?.[1] ?? "").matchAll(/<tr><th scope="row">([^<]*)<\/th><td>([^<]*)<\/td>/g)].map((m) => [m[1], m[2]] as [string, string]));
      for (const o of got) {
        const numbers = (rows.get(o.row)?.match(/\d+/g) ?? []).map(Number);
        const want = [o.limit, ...(o.minute ? [o.minute] : [])];
        expect(`${o.value}: ${o.row} has ${want}: ${inOrder(numbers, want)}`).toBe(`${o.value}: ${o.row} has ${want}: true`);
      }
    });

    it("has reciprocal hreflang with English and the other locale, a self canonical and x-default", () => {
      const set = hreflang(html);
      const enSet = hreflang(en);
      expect(JSON.stringify([...set].sort())).toBe(JSON.stringify([...enSet].sort()));
      expect(set.get("en")).toBe(`${SITE}${EN}`);
      expect(set.get("x-default")).toBe(`${SITE}${EN}`);
      expect([...set.values()]).toContain(`${SITE}${path}`);
      expect(html).toContain(`<link rel="canonical" href="${SITE}${path}">`);
      for (const other of Object.keys(LOCALES)) expect([...enSet.values()]).toContain(`${SITE}${other}${EN}`);
    });

    it("is linked from the body of its locale homepage", () => {
      expect(main(read(`site${prefix}/index.html`))).toContain(`<a href="${path}">${words.homeLink}</a>`);
    });

    it("keeps the statement that the official server can write; those calls do not use the allowance", () => {
      // English: "The official server can write to Figma files; those calls simply do not use the allowance."
      expect(main(en)).toContain("The official server can write to Figma files");
      expect(text(main(html))).toContain(words.canWrite);
    });
  });
}

describe("rate limit checker messages in Japanese and Chinese", () => {
  const checker = createRequire(import.meta.url)(join(root, "site/rate-limit-checker.js")) as {
    summarize(rows: { tool: string; counts: boolean; calls: number }[], plan: { limit: number; period: string; minute?: number | null }): any;
    message(s: any, lang?: string): string;
  };
  const rows = [
    { tool: "get_metadata", counts: true, calls: 15 },
    { tool: "get_screenshot", counts: true, calls: 8 },
    { tool: "use_figma", counts: false, calls: 40 },
    { tool: "whoami", counts: false, calls: 2 },
  ];
  const month = checker.summarize(rows, { limit: 20, period: "month" });
  const day = checker.summarize(rows, { limit: 200, period: "day", minute: 10 });

  it("picks the language from the page's lang attribute and falls back to English", () => {
    expect(checker.message(month, "en")).toBe(checker.message(month));
    expect(checker.message(month, "fr")).toBe(checker.message(month));
    expect(checker.message(month, "zh-CN")).toBe(checker.message(month, "zh"));
  });

  it("states counted, exempt, the limit and how far over in Japanese", () => {
    expect(checker.message(month, "ja")).toBe("23回が上限に含まれ、42回は対象外です。あなたの上限は1か月あたり20回です。1か月の上限を3回超えています。");
    expect(checker.message(day, "ja")).toBe("23回が上限に含まれ、42回は対象外です。あなたの上限は1日あたり200回です。この1日の残りは177回です。これとは別に、上限に含まれる呼び出しが1分間に10回を超えると、1分あたりの上限を超えます。");
  });

  it("states counted, exempt, the limit and how far over in Simplified Chinese", () => {
    expect(checker.message(month, "zh-CN")).toBe("23 次调用计入限额；42 次不计入。你的限额：每月 20 次。比每月的限额多出 3 次。");
    expect(checker.message(day, "zh-CN")).toBe("23 次调用计入限额；42 次不计入。你的限额：每天 200 次。当天还剩 177 次。另外，任意一分钟内计入限额的调用超过 10 次，就会超出每分钟限额。");
  });
});
