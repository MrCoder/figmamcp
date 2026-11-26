import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const zh = readFileSync(join(import.meta.dir, "../../../zh/index.md"), "utf8");
// The credit line names the upstream project on purpose; every other line must not.
const body = zh.split("\n").filter((l) => !l.includes("Neo Product LLC")).join("\n");

// PRODUCT.md: no npx/npm until the package is published; never advertise MIT; Source stays private.
describe("Simplified Chinese page describes FigmaMCP, not the upstream project", () => {
  it("names the product and links the Mac download", () => {
    expect(zh).toContain("FigmaMCP");
    expect(zh).toContain("https://figmamcp.dev/download");
    expect(zh).toContain("https://github.com/MrCoder/figmamcp-releases/issues");
  });

  it("carries none of the upstream-only claims", () => {
    expect(body).not.toMatch(/Figma Edit MCP/i);
    expect(body).not.toMatch(/figma-edit/i);
    expect(body).not.toMatch(/\bnpx\b|\bnpm\b|\bbunx\b/i);
    expect(body).not.toMatch(/\bMIT\b/);
    expect(body).not.toContain("neozhehan");
    expect(body).not.toMatch(/WebSocket/);
  });

  it("credits the upstream project without claiming to be it", () => {
    expect(zh).toContain("Neo Product LLC");
    expect(zh).toContain("sonnylazuardi");
    expect(zh).toMatch(/与 Figma, Inc\. 无关联|不隶属于 Figma/);
  });

  it("does not pin a version number that will go stale", () => {
    expect(zh).not.toMatch(/\b0\.\d+\.\d+\b/);
  });
});

// The same wording guards, run against the published static page.
const root = join(import.meta.dir, "../../..");
const html = readFileSync(join(root, "site/zh/index.html"), "utf8");
const htmlBody = html.split("\n").filter((l) => !l.includes("Neo Product LLC")).join("\n");
const sitemap = readFileSync(join(root, "site/sitemap.xml"), "utf8");

describe("published site/zh/index.html", () => {
  it("is Simplified Chinese, canonical at /zh, and loads app.js", () => {
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<link rel="canonical" href="https://figmamcp.dev/zh">');
    expect(html).toContain('<script src="/app.js" defer></script>');
    expect(html).toContain('<link rel="alternate" hreflang="en" href="https://figmamcp.dev/">');
    expect(html).toContain('<link rel="alternate" hreflang="zh-CN" href="https://figmamcp.dev/zh">');
  });

  it("is listed in the sitemap", () => {
    expect(sitemap).toContain("<loc>https://figmamcp.dev/zh</loc>");
  });

  it("names the product and links the Mac download and issues", () => {
    expect(html).toContain("FigmaMCP");
    expect(html).toContain('href="/download"');
    expect(html).toContain("https://github.com/MrCoder/figmamcp-releases/issues");
  });

  it("carries none of the upstream-only or forbidden claims", () => {
    expect(htmlBody).not.toMatch(/Figma Edit MCP/i);
    expect(htmlBody).not.toMatch(/figma-edit/i);
    expect(htmlBody).not.toMatch(/\bnpx\b|\bnpm\b|\bbunx\b/i);
    expect(htmlBody).not.toMatch(/\bMIT\b/);
    expect(htmlBody).not.toMatch(/open[- ]source|开源/i);
    expect(htmlBody).not.toMatch(/unlimited|bypass|无限|绕过/i);
    expect(htmlBody).not.toContain("neozhehan");
    expect(htmlBody).not.toMatch(/WebSocket/);
  });

  it("credits the upstream project without claiming to be it", () => {
    expect(html).toContain("Neo Product LLC");
    expect(html).toContain("sonnylazuardi");
    expect(html).toMatch(/不隶属于 Figma/);
  });

  it("the home page links to it and declares the alternates", () => {
    const home = readFileSync(join(root, "site/index.html"), "utf8");
    expect(home).toContain('<a href="/zh"');
    expect(home).toContain('<link rel="alternate" hreflang="zh-CN" href="https://figmamcp.dev/zh">');
    expect(home).toContain('<link rel="alternate" hreflang="en" href="https://figmamcp.dev/">');
  });
});
