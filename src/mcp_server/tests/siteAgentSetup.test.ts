import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

// Growth plan action 0d: a prompt a visitor pastes into Claude Code or Codex, and the agent installs FigmaMCP.
const root = join(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
// The zh and ja setup pages carry the same English prompt; the agent reads it as is.
const PAGES = ["site/docs/setup/index.html", "site/index.html", "site/zh/docs/setup/index.html", "site/ja/docs/setup/index.html"];
const DMG = "https://github.com/MrCoder/figmamcp-releases/releases/latest/download/FigmaMCP.dmg";
const CLI = "/Applications/FigmaMCP.app/Contents/Resources/bin/figmamcp";

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const prompt = (html: string) => {
  const m = /<pre id="agent-setup-text"><code>([\s\S]*?)<\/code><\/pre>/.exec(html);
  return m ? decode(m[1]) : null;
};

describe("agent setup prompt", () => {
  for (const page of PAGES) {
    it(`${page} shows the prompt with a copy button that app.js can wire`, () => {
      const html = read(page);
      expect(prompt(html)).not.toBeNull();
      expect(html).toContain('id="agent-setup"');
      const button = /<button type="button" class="copy" data-copy-target="agent-setup-text"[^>]*><span class="copy-label">Copy<\/span><\/button>/;
      expect(button.test(html)).toBe(true);
      expect(html).toContain('<script src="/app.js" defer></script>');
      // CSP has no 'unsafe-inline' for scripts, so nothing may rely on an inline handler.
      expect(/\son[a-z]+="/i.test(html)).toBe(false);
    });
  }

  it("is the same text on every page that shows it", () => {
    for (const page of PAGES.slice(1)) expect(`${page}: ${prompt(read(page)) === prompt(read(PAGES[0]))}`).toBe(`${page}: true`);
  });

  it("uses the stable download URL, the bundled command and only the agents that work today", () => {
    const text = prompt(read(PAGES[0]))!;
    expect(text).toContain(`curl -fL -o /tmp/FigmaMCP.dmg ${DMG}`);
    expect(text).toContain(`${CLI} setup`);
    expect(text).toContain("figmamcp doctor");
    expect(text).toContain("setup --restart-figma");
    expect(text).toContain("Plugins > Development > FigmaMCP");
    expect(text).toContain("claude --continue");
    expect(text).toContain("codex resume --last");
    expect(text).toContain("14 or later");
    expect(/cursor|windsurf|windows|linux/i.test(text)).toBe(false);
  });

  it("does not offer an npm route or banned claims", () => {
    for (const page of PAGES) {
      const text = prompt(read(page))!;
      const hits = text.match(/\bnpx\b|\bnpm\b|\bunlimited\b|\bbypass\w*|\bworkarounds?\b|\bopen[- ]source\b|\bMIT\b|\blicen[cs]e\b/gi);
      expect(`${page}: ${hits ?? "none"}`).toBe(`${page}: none`);
    }
  });

  it("keeps the CSP free of inline scripts", () => {
    const csp = /Content-Security-Policy: ([^\n]+)/.exec(read("site/_headers"))![1];
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).not.toContain("unsafe-inline");
  });
});

// Runs site/app.js against a minimal DOM: the copy button must copy the prompt's visible text,
// and select it for Cmd+C when the clipboard is unavailable.
function runCopy(clipboard: "ok" | "reject" | "none") {
  const label = { textContent: "Copy" };
  const target = { textContent: "the prompt text" };
  let click: (() => void) | null = null;
  const button = {
    querySelector: (s: string) => (s === ".copy-label" ? label : null),
    getAttribute: (a: string) => (a === "data-copy-target" ? "agent-setup-text" : null),
    addEventListener: (ev: string, fn: () => void) => { if (ev === "click") click = fn; },
  };
  const written: string[] = [];
  const selected: unknown[] = [];
  const document = {
    querySelectorAll: (s: string) => (s === "[data-copy-target]" ? [button] : []),
    querySelector: () => null,
    getElementById: (id: string) => (id === "agent-setup-text" ? target : null),
    addEventListener: () => {},
    createRange: () => ({ selectNodeContents: (n: unknown) => selected.push(n) }),
    readyState: "complete",
  };
  const navigator: Record<string, unknown> = { doNotTrack: "1" };
  if (clipboard !== "none") {
    navigator.clipboard = {
      writeText: (t: string) => { written.push(t); return clipboard === "ok" ? Promise.resolve() : Promise.reject(new Error("denied")); },
    };
  }
  const window = { getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }), addEventListener: () => {} };
  runInNewContext(read("site/app.js"), { document, navigator, window, setTimeout: () => 0 });
  return { click: () => click?.(), label, target, written, selected, wired: () => click !== null };
}

describe("copy button in app.js", () => {
  it("copies the target element's text with navigator.clipboard", async () => {
    const r = runCopy("ok");
    expect(r.wired()).toBe(true);
    r.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(r.written).toEqual(["the prompt text"]);
    expect(r.label.textContent).toBe("Copied");
    expect(r.selected).toEqual([]);
  });

  it("selects the text when the clipboard refuses", async () => {
    const r = runCopy("reject");
    r.click();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.selected).toEqual([r.target]);
    expect(r.label.textContent).toBe("Press Cmd+C");
  });

  it("selects the text when there is no clipboard API", () => {
    const r = runCopy("none");
    r.click();
    expect(r.selected).toEqual([r.target]);
    expect(r.label.textContent).toBe("Press Cmd+C");
  });
});

describe("/go/agent-setup short link", () => {
  it("redirects to the prompt on /docs/setup with UTM tags, like the other /go/ links", () => {
    const line = read("site/_redirects").split("\n").find((l) => l.startsWith("/go/agent-setup "));
    expect(line).toBe("/go/agent-setup /docs/setup?utm_source=agent-setup&utm_medium=share&utm_campaign=agent-setup-2611#agent-setup 302");
    expect(read("site/docs/setup/index.html")).toContain('<section id="agent-setup"');
  });
});
