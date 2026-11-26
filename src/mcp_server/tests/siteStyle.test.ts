import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "../../../site/style.css"), "utf8");

// Colour declared by the last rule whose selector list contains `selector` exactly.
function colorOf(selector: string): string | undefined {
  let color: string | undefined;
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(",").map((s) => s.trim()).includes(selector)) continue;
    const m = body.match(/(?:^|;)\s*color\s*:\s*([^;]+)/);
    if (m) color = m[1].trim();
  }
  return color;
}

describe("site button", () => {
  it("keeps the Download label readable on hover", () => {
    // `a:hover` sets the accent colour and outranks `.btn`, so the label would match the
    // button's accent background. `.btn:hover` must restore the button's text colour.
    expect(colorOf("a:hover")).toBe("var(--accent)");
    expect(colorOf(".btn")).toBe("var(--accent-ink)");
    expect(colorOf(".btn:hover")).toBe("var(--accent-ink)");
  });
});

describe("site version note", () => {
  it("wraps on phones, so the step lists fit a 375px screen", () => {
    // `.ver` is nowrap on wide screens. Unwrapped, "macOS 14+ · Intel & Apple Silicon · ~155 MB" (longer in
    // zh and ja) widened the setup and tutorial step lists to 389-439px at 375px (measured 2026-11-22).
    const phone = /@media \(max-width:640px\)\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(phone).toMatch(/(^|\s)\.ver\{white-space:normal\}/);
  });
});
