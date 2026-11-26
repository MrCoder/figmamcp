import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// Growth plan action 0c: the Figma MCP rate limit checker on /figma-mcp-rate-limit.
const root = join(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const html = read("site/figma-mcp-rate-limit/index.html");
const SOURCE = "https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/";
const checker = createRequire(import.meta.url)(join(root, "site/rate-limit-checker.js")) as {
  parseCalls(v: unknown): number;
  summarize(rows: { tool: string; counts: boolean; calls: number }[], plan: { limit: number; period: string; minute?: number | null }): {
    counted: number; exempt: number; limit: number; over: number; left: number; minute: number | null;
  };
  message(s: ReturnType<typeof checker.summarize>): string;
};

const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&rsquo;/g, "’").trim();
const section = html.slice(html.indexOf('<h2 id="checker">'), html.indexOf("<h2>What this means in practice</h2>"));
const toolRows = [...section.matchAll(/<tr data-tool="([^"]+)" data-kind="([^"]*)" data-counts="([^"]*)"><th scope="row">([\s\S]*?)<\/th><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><\/tr>/g)]
  .map((m) => ({ tool: m[1], kind: m[2], counts: m[3], name: text(m[4]), kindText: text(m[5]), countsText: text(m[6]) }));
const options = [...section.matchAll(/<option value="[^"]+" data-row="([^"]+)" data-limit="(\d+)" data-period="(month|day)"(?: data-minute="(\d+)")?>/g)]
  .map((m) => ({ row: m[1], limit: Number(m[2]), period: m[3], minute: m[4] ? Number(m[4]) : null }));
const limitsTable = html.slice(html.indexOf("<h2>The limits by plan</h2>"), html.indexOf("<h2>What counts and what does not</h2>"));
const proseRow = (header: string) => {
  const esc = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return limitsTable.match(new RegExp(`<tr><th scope="row">${esc}</th><td>([^<]*)</td>`))?.[1] ?? null;
};

describe("site rate limit checker: static table", () => {
  it("has the checker section with a static table of tools", () => {
    expect(section).toContain('<table id="rl-tools">');
    expect(toolRows.length).toBeGreaterThanOrEqual(30);
    expect([...section.matchAll(/<tr data-tool=/g)].length).toBe(toolRows.length);
  });

  it("gives every tool row a read or write kind and a counts or exempt value that its visible text states", () => {
    for (const r of toolRows) {
      const got = `${r.tool}: ${r.name} ${r.kind}/${r.kindText} ${r.counts}/${r.countsText.split(":")[0]}`;
      const kindText = r.kind === "read" ? "Read" : r.kind === "write" ? "Write" : "?";
      const countsText = r.counts === "yes" ? "Counts toward the limit" : r.counts === "no" ? "Exempt" : "?";
      expect(got).toBe(`${r.tool}: ${r.tool} ${r.kind}/${kindText} ${r.counts}/${countsText}`);
    }
  });

  it("marks write tools exempt and whoami, a read tool, exempt as Figma states", () => {
    for (const r of toolRows.filter((r) => r.kind === "write")) expect(`${r.tool}: ${r.counts}`).toBe(`${r.tool}: no`);
    expect(toolRows.find((r) => r.tool === "whoami")).toMatchObject({ kind: "read", counts: "no" });
    for (const t of ["get_design_context", "get_metadata", "get_screenshot"]) {
      expect(toolRows.find((r) => r.tool === t)).toMatchObject({ kind: "read", counts: "yes" });
    }
  });

  it("states the check date and links Figma's source next to the limits", () => {
    expect(section).toContain("checked 2026-11-22");
    expect(section).toContain(`href="${SOURCE}"`);
    const controls = section.slice(section.indexOf('<div id="rl-checker"'), section.indexOf('<div class="tablewrap">'));
    expect(controls).toContain("checked 2026-11-22");
    expect(controls).toContain(`href="${SOURCE}"`);
  });
});

describe("site rate limit checker: limits", () => {
  it("offers each plan with the same numbers as the limits table in the page prose", () => {
    expect(options.length).toBe(6);
    for (const o of options) {
      const cell = proseRow(o.row);
      const numbers = (cell?.match(/\d+/g) ?? []).map(Number);
      expect(`${o.row}: ${numbers.join(",")}`).toBe(`${o.row}: ${[o.limit, ...(o.minute ? [o.minute] : [])].join(",")}`);
      expect(`${o.row}: ${cell}`).toContain(`per ${o.period}`);
    }
  });

  it("keeps limit numbers out of the script, so the page is their one source", () => {
    expect(read("site/rate-limit-checker.js")).not.toMatch(/\b(20|200|600|10|15)\b/);
  });
});

describe("site rate limit checker: script and CSP", () => {
  it("loads the script from a file that exists, with no inline script or style added", () => {
    expect(html).toContain('<script src="/rate-limit-checker.js" defer></script>');
    expect(existsSync(join(root, "site/rate-limit-checker.js"))).toBe(true);
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1].trim());
    expect(inline.every((a) => a === 'type="application/ld+json"')).toBe(true);
    expect(html).not.toMatch(/<style\b|\sstyle="/);
  });

  it("keeps the controls hidden without JavaScript and announces the result", () => {
    expect(section).toMatch(/<div id="rl-checker" class="checker" hidden>/);
    expect(section).toMatch(/<label for="rl-plan">/);
    expect(section).toMatch(/<output id="rl-result"[^>]*aria-live="polite"[^>]*hidden>/);
    expect(read("site/style.css")).toContain(".rl-result[hidden]{display:none}");
  });
});

describe("site rate limit checker: logic", () => {
  const rows = [
    { tool: "get_metadata", counts: true, calls: 15 },
    { tool: "get_screenshot", counts: true, calls: 8 },
    { tool: "use_figma", counts: false, calls: 40 },
    { tool: "whoami", counts: false, calls: 2 },
  ];

  it("reads whole, non-negative call counts", () => {
    expect([checker.parseCalls("7"), checker.parseCalls("3.9"), checker.parseCalls("-4"), checker.parseCalls(""), checker.parseCalls("x")]).toEqual([7, 3, 0, 0, 0]);
  });

  it("adds only counted calls toward the limit and reports how far over", () => {
    const s = checker.summarize(rows, { limit: 20, period: "month" });
    expect(s).toMatchObject({ counted: 23, exempt: 42, over: 3, left: 0, minute: null });
    expect(checker.message(s)).toBe("23 calls count toward the limit; 42 calls are exempt. Your limit: 20 per month. That is 3 over the limit for one month.");
  });

  it("reports what is left and the separate per-minute limit for a daily plan", () => {
    const s = checker.summarize(rows, { limit: 200, period: "day", minute: 10 });
    expect(s).toMatchObject({ counted: 23, over: 0, left: 177, minute: 10 });
    expect(checker.message(s)).toBe("23 calls count toward the limit; 42 calls are exempt. Your limit: 200 per day. 177 left for this day. Separately, more than 10 counted calls in any one minute go over the per-minute limit.");
  });
});
