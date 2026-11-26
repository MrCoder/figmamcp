import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Product wording rule: FigmaMCP has "no call quota". Never say "no limit" / "unlimited" about calls.
// Scans every site page; the locale is the first path segment under site/ (anything else is English).
const root = join(import.meta.dir, "../../..");
const siteDir = join(root, "site");

const BANNED: Record<string, RegExp> = {
  en: /no call limits?\b|without (a )?call limits?\b|unlimited (tool )?calls\b|no limit on (tool )?calls\b|calls? (are|is) unlimited\b/i,
  de: /ohne (aufruf|call)?-?limit\b|unbegrenzte aufrufe|keine aufruflimits?\b/i,
  fr: /sans limite d['’]appels|appels illimités|illimité/i,
  pl: /bez limitu|brak limitu|nielimitowan|bez ograniczeń|bez ograniczen/i,
  uk: /без ліміт|без обмежен|необмежен|безліміт/i,
  ja: /制限なし|無制限|制限はありません/,
  ko: /제한 없|무제한|제한이 없/,
  zh: /无限|不限|没有限制|无限制/,
  "zh-hant": /無限|不限|沒有限制|無限制/,
};
const LOCALES = Object.keys(BANNED).filter((l) => l !== "en");

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? htmlFiles(p) : p.endsWith(".html") ? [p] : [];
  });
}

describe("site wording: no call quota, never no limit / unlimited", () => {
  for (const file of htmlFiles(siteDir)) {
    const rel = file.slice(root.length + 1);
    const seg = rel.split("/")[1] ?? "";
    const locale = LOCALES.includes(seg) ? seg : "en";
    it(rel, () => {
      const m = BANNED[locale]!.exec(readFileSync(file, "utf8"));
      expect(m?.[0] ?? null).toBeNull();
    });
  }
});
