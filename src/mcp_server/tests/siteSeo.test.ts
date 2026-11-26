import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import worker from "../../../site-worker/index.js";
import { indexNowPayload, pingIndexNow, INDEXNOW_KEY } from "../../../scripts/indexnow-ping";

// Technical SEO/GEO rules for figmamcp.dev (audit of 2026-11-19).
const root = join(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const sitemap = read("site/sitemap.xml");
const entries = [...sitemap.matchAll(/<url><loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod><\/url>/g)].map((m) => ({ loc: m[1], lastmod: m[2] }));
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const fileOf = (loc: string) => {
  const path = new URL(loc).pathname;
  return path === "/" ? "site/index.html" : `site${path}/index.html`;
};
const pages = locs.map((loc) => ({ loc, path: new URL(loc).pathname, html: read(fileOf(loc)) }));
const version = JSON.parse(read("package.json")).version;
const ORG_ID = "https://figmamcp.dev/#organization";

const ENTITIES: Record<string, string> = { rsquo: "\u2019", lsquo: "\u2018", ldquo: "\u201c", rdquo: "\u201d", quot: '"', amp: "&", mdash: "\u2014", ndash: "\u2013", nbsp: "\u00a0", lt: "<", gt: ">", middot: "\u00b7", hellip: "\u2026", rarr: "\u2192" };
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] ?? all;
  });
const meta = (html: string, attr: string) => {
  const m = html.match(new RegExp(`<meta ${attr} content="([^"]*)"`));
  return m ? decode(m[1]) : null;
};
const title = (html: string) => decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "");
const lang = (html: string) => html.match(/<html lang="([^"]+)"/)?.[1] ?? "";
const CJK = new Set(["zh-CN", "zh-Hant", "ja", "ko"]);
const LATIN = new Set(["en", "de", "fr", "pl"]);

function jsonLd(html: string): any[] {
  const nodes: any[] = [];
  for (const [, body] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const data = JSON.parse(body);
    nodes.push(...(data["@graph"] ?? [data]));
  }
  return nodes;
}
const ofType = (html: string, type: string) => jsonLd(html).filter((n) => n["@type"] === type);
// The page node: WebPage, or its subtype CollectionPage on a hub such as /tutorials.
const pageNode = (html: string) => jsonLd(html).filter((n) => n["@type"] === "WebPage" || n["@type"] === "CollectionPage");
const visibleText = (html: string) =>
  decode(
    html
      .replace(/<head>[\s\S]*?<\/head>/, " ")
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();

const homeText = (() => {
  const html = read("site/index.html");
  return visibleText(html.slice(html.indexOf('id="what"'), html.indexOf('id="how"')));
})();

describe("site redirects and headers", () => {
  const assetRedirect = (location: string) => ({ fetch: async () => new Response(null, { status: 307, headers: { location } }) });

  it("turns the trailing-slash redirect from static assets into a 301", async () => {
    const res = await worker.fetch(new Request("https://figmamcp.dev/pricing/"), { ASSETS: assetRedirect("/pricing") });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/pricing");
  });

  it("keeps 200 asset responses unchanged on trailing-slash paths", async () => {
    const res = await worker.fetch(new Request("https://figmamcp.dev/ja/"), { ASSETS: { fetch: async () => new Response("ok") } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("routes trailing-slash paths to the worker, so the 307 can be rewritten", () => {
    // Without this pattern the static asset layer answers /pricing/ itself, with a 307.
    const config = JSON.parse(read("wrangler.jsonc"));
    expect(config.assets.run_worker_first).toContain("/*");
    expect(config.assets.run_worker_first).not.toContain("!/*/");
    expect(config.assets.html_handling).toBe("drop-trailing-slash");
  });

  it("lets the CSP load Cloudflare Web Analytics, and the privacy page says so", () => {
    // Cloudflare injects beacon.min.js at the edge; it is not in the repo HTML.
    const csp = read("site/_headers").match(/Content-Security-Policy: (.*)/)?.[1] ?? "";
    const directive = (name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";
    expect(directive("script-src").split(" ")).toContain("https://static.cloudflareinsights.com");
    expect(directive("connect-src").split(" ")).toContain("https://cloudflareinsights.com");
    expect(directive("connect-src").split(" ")).toContain("'self'");
    expect(read("site/privacy/index.html")).toContain("Cloudflare Web Analytics");
  });

  it("sends HSTS without includeSubDomains or preload", () => {
    const headers = read("site/_headers");
    const block = headers.split(/\n(?=\S)/).find((b) => b.startsWith("/*\n")) ?? "";
    expect(block).toContain("  Strict-Transport-Security: max-age=15552000\n");
    expect(headers).not.toMatch(/includeSubDomains|preload/i);
  });
});

describe("site titles and descriptions", () => {
  it("keeps titles on Latin-script pages to 60 characters or fewer", () => {
    for (const p of pages.filter((p) => LATIN.has(lang(p.html)))) {
      const t = title(p.html);
      expect(`${p.path}: ${t.length <= 60 ? "ok" : `${t.length} ${t}`}`).toBe(`${p.path}: ok`);
    }
  });

  it("keeps descriptions between 120 and 160 characters on non-CJK pages", () => {
    for (const p of pages.filter((p) => !CJK.has(lang(p.html)))) {
      const d = meta(p.html, 'name="description"') ?? "";
      const ok = d.length >= 120 && d.length <= 160;
      expect(`${p.path}: ${ok ? "ok" : `${d.length} ${d}`}`).toBe(`${p.path}: ok`);
    }
  });

  it("keeps CJK titles to 32 characters and descriptions to 80", () => {
    // A CJK character is about twice as wide as a Latin one in search results.
    for (const p of pages.filter((p) => CJK.has(lang(p.html)))) {
      const t = title(p.html);
      const d = meta(p.html, 'name="description"') ?? "";
      expect(`${p.path}: ${t.length <= 32 ? "ok" : `${t.length} ${t}`}`).toBe(`${p.path}: ok`);
      expect(`${p.path}: ${d.length <= 80 ? "ok" : `${d.length} ${d}`}`).toBe(`${p.path}: ok`);
    }
  });

  it("starts the title of each top-impression page with its Search Console query (S1)", () => {
    const targets: Record<string, string> = {
      "/what-is-figma-mcp": "figma mcp server",
      "/troubleshooting/not-working": "figma mcp not working",
      "/pricing": "figma mcp pricing",
      "/figma-mcp-limit-reached": "figma mcp limit reached",
      "/compare/official-figma-mcp": "official figma mcp",
      "/tools": "figma mcp tools",
    };
    for (const [path, phrase] of Object.entries(targets)) {
      const p = pages.find((x) => x.path === path);
      expect(`${path}: ${p ? "found" : "missing"}`).toBe(`${path}: found`);
      const t = title(p!.html);
      expect(`${path}: ${t.toLowerCase().startsWith(phrase)}`).toBe(`${path}: true`);
      expect(`${path}: ${t.length <= 60}`).toBe(`${path}: true`);
    }
  });

  it("uses the page title as the JSON-LD WebPage name", () => {
    for (const p of pages) {
      const [page] = pageNode(p.html);
      expect(`${p.path}: ${page?.name}`).toBe(`${p.path}: ${title(p.html)}`);
    }
  });

  it("repeats the title and description in Open Graph tags", () => {
    for (const p of pages) {
      expect(`${p.path}: ${meta(p.html, 'property="og:title"')}`).toBe(`${p.path}: ${title(p.html)}`);
      expect(`${p.path}: ${meta(p.html, 'property="og:description"')}`).toBe(`${p.path}: ${meta(p.html, 'name="description"')}`);
    }
  });
});

describe("site structured data", () => {
  it("has a BreadcrumbList on every page, matching the visible breadcrumb", () => {
    for (const p of pages) {
      const lists = ofType(p.html, "BreadcrumbList");
      expect(`${p.path}: ${lists.length}`).toBe(`${p.path}: 1`);
      const items = lists[0].itemListElement;
      // Home and locale home pages are a one-item trail; every other page starts at the English home,
      // or, for a translated page such as /ja/figma-mcp-rate-limit, at its locale home.
      const localeHome = p.path.match(/^\/[a-z]{2}(-hant)?(?=\/)/)?.[0];
      if (items.length > 1) expect(`${p.path}: ${items[0].item}`).toBe(`${p.path}: https://figmamcp.dev${localeHome ?? "/"}`);
      else expect(`${p.path}: ${/^\/([a-z]{2}(-hant)?)?$/.test(p.path)}`).toBe(`${p.path}: true`);
      expect(items[items.length - 1].item).toBe(p.loc);
      items.forEach((it: any, i: number) => expect(it.position).toBe(i + 1));
      if (items.length > 1) {
        const nav = p.html.match(/<nav class="crumbs" aria-label="Breadcrumb">([\s\S]*?)<\/nav>/)?.[1] ?? "";
        const shown = visibleText(nav);
        for (const it of items) expect(`${p.path}: ${shown.includes(it.name)}`).toBe(`${p.path}: true`);
      }
    }
  });

  it("names the publisher by one Organization @id on every page", () => {
    for (const p of pages) {
      const orgs = ofType(p.html, "Organization");
      expect(`${p.path}: ${orgs.map((o) => o["@id"]).join(",")}`).toBe(`${p.path}: ${ORG_ID}`);
      const [app] = ofType(p.html, "SoftwareApplication");
      expect(`${p.path}: ${app?.publisher?.["@id"]}`).toBe(`${p.path}: ${ORG_ID}`);
    }
  });

  it("gives SoftwareApplication the released version and download facts", () => {
    for (const p of pages) {
      const [app] = ofType(p.html, "SoftwareApplication");
      expect(`${p.path}: ${app.softwareVersion}`).toBe(`${p.path}: ${version}`);
      expect(app.downloadUrl).toBe("https://figmamcp.dev/download");
      expect(app.isAccessibleForFree).toBe(true);
      expect(Array.isArray(app.featureList) && app.featureList.length).toBeGreaterThan(0);
      // Each feature is the home page's "What it does" card text, word for word.
      for (const f of app.featureList) {
        const [head, body] = f.split(": ");
        expect(`${f}: ${homeText.includes(`${head} ${body}`)}`).toBe(`${f}: true`);
      }
    }
  });

  it("shows the same last-updated date on the page, in dateModified and in the sitemap", () => {
    // Every sitemap page. Locale homes label the line in their own language, so match the
    // `updated` paragraph, not the English words.
    const dated = pages;
    expect(dated.length).toBeGreaterThan(50);
    for (const p of dated) {
      const shown = p.html.match(/<p class="[^"]*\bupdated\b[^"]*">[^<]*<time datetime="(\d{4}-\d{2}-\d{2})">\1<\/time>/)?.[1];
      const [page] = pageNode(p.html);
      const lastmod = entries.find((e) => e.loc === p.loc)?.lastmod;
      expect(`${p.path}: ${shown} ${page?.dateModified} ${lastmod}`).toBe(`${p.path}: ${shown} ${shown} ${shown}`);
      expect(shown).toBeDefined();
    }
  });

  it("marks up the setup steps as HowTo, using the visible step text", () => {
    const html = read("site/docs/setup/index.html");
    const [howTo] = ofType(html, "HowTo");
    expect(howTo.step.length).toBeGreaterThan(2);
    const text = visibleText(html);
    for (const s of howTo.step) expect(text).toContain(s.text);
  });
});

describe("site tutorial: edit a Figma file with Claude Code (S4)", () => {
  const path = "/tutorials/edit-figma-with-claude-code";
  const html = read(`site${path}/index.html`);

  it("marks up the tutorial steps as HowTo, using the visible step text in order", () => {
    const [howTo] = ofType(html, "HowTo");
    expect(howTo.step.length).toBeGreaterThan(5);
    const text = visibleText(html);
    let from = 0;
    for (const s of howTo.step) {
      const at = text.indexOf(s.text, from);
      expect(`${s.position}: ${at >= 0}`).toBe(`${s.position}: true`);
      from = at;
    }
  });

  it("embeds the demo video and is linked from setup and use cases", () => {
    expect(html).toContain('data-src="/assets/figmamcp-demo.mp4"');
    for (const from of ["site/docs/setup/index.html", "site/use-cases/index.html"]) {
      expect(`${from}: ${read(from).includes(`href="${path}"`)}`).toBe(`${from}: true`);
    }
    expect(locs).toContain(`https://figmamcp.dev${path}`);
  });
});

describe("site tutorial: design QA on a Figma file (S5)", () => {
  const path = "/tutorials/design-qa-figma-file";
  const html = read(`site${path}/index.html`);

  it("marks up the tutorial steps as HowTo, using the visible step text in order", () => {
    const [howTo] = ofType(html, "HowTo");
    expect(howTo.step.length).toBeGreaterThan(5);
    const text = visibleText(html);
    let from = 0;
    for (const s of howTo.step) {
      const at = text.indexOf(s.text, from);
      expect(`${s.position}: ${at >= 0}`).toBe(`${s.position}: true`);
      from = at;
    }
  });

  it("shows the same round scores as the worked example in the skill's rubric", () => {
    // The page's claim must match the recorded run in skills/figma-design-qa/references/rubric.md.
    const rubric = read("skills/figma-design-qa/references/rubric.md");
    const recorded = [...rubric.matchAll(/^\| (\d) \|[^|]+\|((?: [\d.]+ \|){7})$/gm)].map((m) => [m[1], ...m[2].split("|").map((c) => c.trim()).filter(Boolean)].join(" "));
    expect(recorded.length).toBe(4);
    const shown = [...html.matchAll(/<tr><th scope="row">(\d)<\/th><td>[^<]*<\/td>((?:<td>[\d.]+<\/td>){6})<td><strong>([\d.]+)<\/strong><\/td><\/tr>/g)].map((m) =>
      [m[1], ...[...m[2].matchAll(/<td>([\d.]+)<\/td>/g)].map((c) => c[1]), m[3]].join(" "),
    );
    expect(shown).toEqual(recorded);
    expect(visibleText(html)).toContain("1.7 to 10.0 in three rounds");
  });

  it("is linked from tools, use cases and the first tutorial, and is in the sitemap and llms.txt", () => {
    for (const from of ["site/tools/index.html", "site/use-cases/index.html", "site/tutorials/edit-figma-with-claude-code/index.html"]) {
      expect(`${from}: ${read(from).includes(`href="${path}"`)}`).toBe(`${from}: true`);
    }
    expect(locs).toContain(`https://figmamcp.dev${path}`);
    expect(read("site/llms.txt")).toContain(`(https://figmamcp.dev${path})`);
  });
});

const howToInOrder = (html: string) => {
  const [howTo] = ofType(html, "HowTo");
  expect(howTo.step.length).toBeGreaterThan(5);
  const text = visibleText(html);
  let from = 0;
  for (const s of howTo.step) {
    const at = text.indexOf(s.text, from);
    expect(`${s.position}: ${at >= 0}`).toBe(`${s.position}: true`);
    from = at;
  }
};
const linkedFrom = (path: string, files: string[]) => {
  for (const from of files) expect(`${from}: ${read(from).includes(`href="${path}"`)}`).toBe(`${from}: true`);
};
const TUTORIALS = ["/tutorials/edit-figma-with-claude-code", "/tutorials/design-qa-figma-file", "/tutorials/spec-to-figma-frames", "/tutorials/rename-figma-layers"];

describe("site tutorials: spec to frames and rename layers (S6)", () => {
  for (const [path, skill] of [["/tutorials/spec-to-figma-frames", "figma-spec-to-frames"], ["/tutorials/rename-figma-layers", "figma-rename-layers"]]) {
    const html = read(`site${path}/index.html`);

    it(`${path}: marks up the steps as HowTo, using the visible step text in order`, () => howToInOrder(html));

    it(`${path}: labels its example as the skill's, not as a recorded run, and links the skill`, () => {
      // The skills' worked examples are expected calls, not runs; the page must not present them as results.
      expect(visibleText(html)).toContain("It is an example written in the skill, not a recorded run.");
      expect(html).toContain(`href="https://github.com/MrCoder/figmamcp-releases/tree/main/skills/${skill}"`);
    });

    it(`${path}: is linked from tools and use cases, and is in the sitemap and llms.txt`, () => {
      linkedFrom(path, ["site/tools/index.html", "site/use-cases/index.html"]);
      expect(locs).toContain(`https://figmamcp.dev${path}`);
      expect(read("site/llms.txt")).toContain(`(https://figmamcp.dev${path})`);
    });
  }
});

describe("site tutorials hub (S7)", () => {
  const html = read("site/tutorials/index.html");

  it("lists all four tutorials as a JSON-LD ItemList on a CollectionPage, and links each one", () => {
    const [page] = ofType(html, "CollectionPage");
    const [list] = ofType(html, "ItemList");
    expect(page.mainEntity["@id"]).toBe(list["@id"]);
    expect(list.itemListElement.map((i: any) => new URL(i.url).pathname)).toEqual(TUTORIALS);
    expect(list.numberOfItems).toBe(TUTORIALS.length);
    const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
    for (const [i, path] of TUTORIALS.entries()) {
      expect(`${path}: ${main.includes(`href="${path}"`)}`).toBe(`${path}: true`);
      expect(list.itemListElement[i].name).toBe(title(read(`site${path}/index.html`)));
      expect(locs).toContain(`https://figmamcp.dev${path}`);
    }
  });

  it("is linked from home, setup and use cases, and is in the sitemap and llms.txt", () => {
    linkedFrom("/tutorials", ["site/index.html", "site/docs/setup/index.html", "site/use-cases/index.html"]);
    expect(locs).toContain("https://figmamcp.dev/tutorials");
    expect(read("site/llms.txt")).toContain("(https://figmamcp.dev/tutorials)");
  });

  it("puts the hub in the breadcrumb of every tutorial, in JSON-LD and on the page", () => {
    for (const path of TUTORIALS) {
      const page = read(`site${path}/index.html`);
      const items = ofType(page, "BreadcrumbList")[0].itemListElement.map((i: any) => `${i.position} ${i.name} ${i.item}`);
      expect(`${path}: ${items.length} ${items[1]}`).toBe(`${path}: 3 2 Tutorials https://figmamcp.dev/tutorials`);
      const nav = page.match(/<nav class="crumbs" aria-label="Breadcrumb">([\s\S]*?)<\/nav>/)?.[1] ?? "";
      expect(`${path}: ${nav.includes('<li><a href="/tutorials">Tutorials</a></li>')}`).toBe(`${path}: true`);
    }
  });
});

describe("site crawler files", () => {
  const BOTS = ["OAI-SearchBot", "GPTBot", "ChatGPT-User", "Claude-SearchBot", "ClaudeBot", "Claude-User", "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended"];
  const robots = read("site/robots.txt");
  const groups = robots.split(/\n\s*\n/);

  it("allows every named AI crawler in its own group, and keeps the default group and sitemap", () => {
    for (const bot of ["*", ...BOTS]) {
      const group = groups.find((g) => g.split("\n").includes(`User-agent: ${bot}`)) ?? "";
      expect(`${bot}: ${group.includes("\nAllow: /")}`).toBe(`${bot}: true`);
    }
    expect(robots).toContain("Sitemap: https://figmamcp.dev/sitemap.xml");
    expect(robots).not.toMatch(/Disallow: \//);
  });

  it("hosts the IndexNow key file", () => {
    expect(INDEXNOW_KEY).toMatch(/^[0-9a-f]{32}$/);
    expect(read(`site/${INDEXNOW_KEY}.txt`).trim()).toBe(INDEXNOW_KEY);
  });

  it("submits every sitemap URL to IndexNow", () => {
    const body = indexNowPayload(sitemap);
    expect(body.host).toBe("figmamcp.dev");
    expect(body.key).toBe(INDEXNOW_KEY);
    expect(body.keyLocation).toBe(`https://figmamcp.dev/${INDEXNOW_KEY}.txt`);
    expect(body.urlList).toEqual(locs);
  });

  it("never throws when the IndexNow ping fails, so a deploy cannot fail on it", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await pingIndexNow(sitemap, failing)).toBeNull();
    const ok = (async () => new Response(null, { status: 202 })) as unknown as typeof fetch;
    expect(await pingIndexNow(sitemap, ok)).toBe(202);
  });

  it("links llms.txt from the footer of every page", () => {
    for (const p of pages) {
      const footer = p.html.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? "";
      expect(`${p.path}: ${footer.includes('href="/llms.txt"')}`).toBe(`${p.path}: true`);
    }
  });
});

describe("site copy", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.(html|txt|xml)$/.test(name) ? [path] : [];
    });
  }

  it("uses none of the banned words in any page or text file", () => {
    // MIT is matched case-sensitively: German pages use the word "mit".
    for (const file of files(join(root, "site"))) {
      const text = readFileSync(file, "utf8");
      const hits = [...text.matchAll(/\bMIT\b|\bopen[- ]source\b|\bunlimited\b|\bbypass(es|ed|ing)?\b|\bworkarounds?\b/gi)]
        .map((m) => m[0])
        .filter((w) => w.toLowerCase() !== "mit" || w === "MIT");
      expect(`${file.slice(root.length)}: ${hits.join(",")}`).toBe(`${file.slice(root.length)}: `);
    }
  });

  it("uses none of the Japanese, Chinese or Korean equivalents of the banned words", () => {
    // unlimited / bypass in ja, zh-CN, zh-Hant and ko. Say "no call quota" (呼び出し回数の上限なし, 没有调用次数配额, 호출 할당량 없음),
    // not the Korean "no call limit" (호출 제한 없음), which reads as unlimited in the snippet Naver and Google show.
    for (const file of files(join(root, "site"))) {
      const hits = [...readFileSync(file, "utf8").matchAll(/無制限|無限|回避|无限|不限量|绕过|繞過|무제한|우회|호출 (횟수 )?제한(이)? 없/g)].map((m) => m[0]);
      expect(`${file.slice(root.length)}: ${hits.join(",")}`).toBe(`${file.slice(root.length)}: `);
    }
  });

  it("FigmaMCP's row in the home comparison table says no call quota, not no limit", () => {
    for (const page of ["site/zh/index.html", "site/zh-hant/index.html", "site/ko/index.html"]) {
      const row = read(page).match(/<tr class="us">[\s\S]*?<\/tr>/)?.[0] ?? "";
      expect(row).not.toBe("");
      expect(`${page}: ${row.match(/[没沒]有限制|(?<!할당량 )제한 없음/)?.[0] ?? ""}`).toBe(`${page}: `);
    }
  });

  it("does not say FigmaMCP has no call limit in Chinese or Japanese (say no call quota)", () => {
    // 没有调用次数限制 reads as "unlimited". Approved: 没有调用配额 (zh), 呼び出し回数の上限なし (ja).
    for (const file of files(join(root, "site"))) {
      const hits = [...readFileSync(file, "utf8").matchAll(/[没无]有?调用次数限制|呼び出し(回数)?(の)?制限なし|回数制限なし/g)].map((m) => m[0]);
      expect(`${file.slice(root.length)}: ${hits.join(",")}`).toBe(`${file.slice(root.length)}: `);
    }
  });

  it("no English page states an official-limits check date older than 2026-11-22", () => {
    // Figma's rate-limit page was re-read on 2026-11-22 (PR #150). These pages state its limits or
    // the write-to-canvas terms and must carry that date. Pages whose date covers other sources
    // (README of other tools, Figma overview/desktop guide) are not in this list.
    const limitPages = [
      "site/index.html",
      "site/figma-mcp-limit-reached/index.html",
      "site/troubleshooting/not-working/index.html",
      "site/figma-mcp-write-to-canvas/index.html",
      "site/figma-mcp-free-plan/index.html",
      "site/pricing/index.html",
      "site/tools/write/index.html",
      "site/figma-mcp-rate-limit/index.html",
      // Re-read 2026-11-25: Figma overview, desktop server guide, rate limits, write to canvas.
      "site/what-is-figma-mcp/index.html",
      "site/compare/local-vs-remote/index.html",
      "site/compare/official-figma-mcp/index.html",
    ];
    const stale = /(checked|as of|published on)\s+(November (9|20|21), 2026|2026-11-(09|20|21))/gi;
    for (const page of limitPages) {
      const hits = [...read(page).matchAll(stale)].map((m) => m[0]);
      expect(`${page}: ${hits.join(",")}`).toBe(`${page}: `);
    }
  });

  it("no Japanese or Chinese page states an official-Figma check date of 2026-11-09", () => {
    // Restamped 2026-11-25 after re-reading Figma's overview, desktop guide, rate-limit and
    // write-to-canvas pages. /figma-mcp-alternative keeps November 9 only for other tools' READMEs.
    const cjkPages = [
      "site/ja/pricing/index.html",
      "site/zh/pricing/index.html",
      "site/ja/troubleshooting/not-working/index.html",
      "site/zh/troubleshooting/not-working/index.html",
      "site/ja/what-is-figma-mcp/index.html",
      "site/zh/what-is-figma-mcp/index.html",
      "site/zh-hant/index.html",
    ];
    const stale = /2026-11-09|2026\s*年\s*11\s*月\s*9\s*日/g;
    for (const page of cjkPages) {
      const hits = [...read(page).matchAll(stale)].map((m) => m[0]);
      expect(`${page}: ${hits.join(",")}`).toBe(`${page}: `);
    }
    // de/fr/pl/uk homes, and the abbreviated "Nov 9" in the official-compare meta.
    const otherLocales: Array<[string, RegExp]> = [
      ["site/de/index.html", /9\.\s*November 2026/g],
      ["site/fr/index.html", /9 novembre 2026/g],
      ["site/pl/index.html", /9 listopada 2026/g],
      ["site/uk/index.html", /9 листопада 2026/g],
      ["site/ko/index.html", /2026년 11월 9일|2026-11-09/g],
      ["site/compare/official-figma-mcp/index.html", /Nov(ember)? 9, 2026/g],
    ];
    for (const [page, re] of otherLocales) {
      const hits = [...read(page).matchAll(re)].map((m) => m[0]);
      expect(`${page}: ${hits.join(",")}`).toBe(`${page}: `);
    }
    const fine = read("site/figma-mcp-alternative/index.html").match(/<p class="fine">Figma&rsquo;s limits:[\s\S]*?<\/p>/)?.[0] ?? "";
    expect(fine).toContain("Checked November 25, 2026");
  });

  it("closes the home page with a second download button after the FAQ", () => {
    const html = read("site/index.html");
    const afterFaq = html.slice(html.indexOf('id="faq"'));
    const close = afterFaq.match(/<section class="wrap block" id="get">[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(close).toContain('<a class="btn" href="/download">');
    expect(visibleText(close)).toContain("Free. No FigmaMCP account. No Figma API token.");
  });

  it("states the competitor license without naming it", () => {
    for (const page of ["framelink", "talk-to-figma-mcp", "figma-console-mcp"]) {
      expect(read(`site/compare/${page}/index.html`)).toMatch(/see its repository/i);
    }
  });
});

describe("site audit checks (S3, 2026-11-21)", () => {
  const SITE = "https://figmamcp.dev";
  const htmlFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? htmlFiles(p) : name.endsWith(".html") ? [p] : [];
    });
  const siteDir = join(root, "site");
  const urlPath = (file: string) => file.slice(siteDir.length).replace(/\/index\.html$/, "").replace(/\.html$/, "") || "/";
  const all = new Map(htmlFiles(siteDir).map((f) => [urlPath(f), readFileSync(f, "utf8")]));
  const noindex = (html: string) => /<meta name="robots" content="[^"]*noindex/.test(html);
  const redirectSources = read("site/_redirects").split("\n").map((l) => l.split(/\s+/)[0]).filter(Boolean);
  const isAsset = (p: string) => /\.[a-z0-9]+$/i.test(p);
  // Paths the worker answers itself; they have no HTML file.
  const DYNAMIC = new Set(["/download", "/subscribe"]);
  const internalHrefs = (html: string) =>
    [...html.replace(/<link\b[^>]*>/g, "").matchAll(/\shref="([^"]+)"/g)]
      .map((m) => decode(m[1]))
      .map((h) => (h.startsWith(SITE) ? h.slice(SITE.length) || "/" : h))
      .filter((h) => h.startsWith("/") && !h.startsWith("//"));

  it("lists every indexable HTML page in the sitemap, and marks the rest noindex", () => {
    for (const [path, html] of all) {
      if (path.startsWith("/google")) continue; // Search Console verification file
      const listed = locs.includes(`${SITE}${path}`) || (path === "/" && locs.includes(`${SITE}/`));
      expect(`${path}: ${listed ? "sitemap" : noindex(html) ? "noindex" : "neither"}`).toBe(`${path}: ${noindex(html) ? "noindex" : "sitemap"}`);
    }
  });

  it("gives each page one canonical and one og:url, both equal to its sitemap URL", () => {
    for (const p of pages) {
      const canon = [...p.html.matchAll(/<link rel="canonical" href="([^"]+)"/g)].map((m) => m[1]);
      const ogUrl = [...p.html.matchAll(/<meta property="og:url" content="([^"]+)"/g)].map((m) => m[1]);
      expect(`${p.path}: ${canon.join(",")} ${ogUrl.join(",")}`).toBe(`${p.path}: ${p.loc} ${p.loc}`);
    }
  });

  it("has the Open Graph basics on every page, with an image that exists", () => {
    for (const p of pages) {
      for (const tag of ['property="og:type"', 'property="og:site_name"', 'property="og:image"', 'name="twitter:card"']) {
        expect(`${p.path} ${tag}: ${meta(p.html, tag) ? "ok" : "missing"}`).toBe(`${p.path} ${tag}: ok`);
      }
      const img = meta(p.html, 'property="og:image"')!;
      expect(`${p.path}: ${img.startsWith(`${SITE}/`) && existsSync(join(siteDir, img.slice(SITE.length)))}`).toBe(`${p.path}: true`);
    }
  });

  it("repeats the Open Graph values in any Twitter tag a page sets", () => {
    // X falls back to og:* when a twitter:* tag is absent, so absence is fine; a different value is not.
    for (const p of pages) {
      for (const [tw, og] of [["title", "title"], ["description", "description"], ["image", "image"]]) {
        const value = meta(p.html, `name="twitter:${tw}"`);
        if (value === null) continue;
        expect(`${p.path} twitter:${tw}: ${value}`).toBe(`${p.path} twitter:${tw}: ${meta(p.html, `property="og:${og}"`)}`);
      }
    }
  });

  it("uses a different title and description on every page", () => {
    const seen = new Map<string, string>();
    for (const p of pages) {
      for (const [kind, value] of [["title", title(p.html)], ["description", meta(p.html, 'name="description"')]]) {
        const key = `${kind}:${value}`;
        expect(`${p.path}: ${kind} shared with ${seen.get(key) ?? "none"}`).toBe(`${p.path}: ${kind} shared with none`);
        seen.set(key, p.path);
      }
    }
  });

  it("has one h1 per page and never skips a heading level", () => {
    for (const p of pages) {
      const levels = [...p.html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
      expect(`${p.path}: h1 x${levels.filter((l) => l === 1).length}, first h${levels[0]}`).toBe(`${p.path}: h1 x1, first h1`);
      const skip = levels.findIndex((l, i) => i > 0 && l > levels[i - 1] + 1);
      expect(`${p.path}: ${skip < 0 ? "ok" : `h${levels[skip - 1]} then h${levels[skip]}`}`).toBe(`${p.path}: ok`);
    }
  });

  it("gives every image alt text, a width and a height", () => {
    for (const p of pages) {
      for (const [tag] of p.html.matchAll(/<img\b[^>]*>/g)) {
        const ok = /\salt="/.test(tag) && /\swidth="\d+"/.test(tag) && /\sheight="\d+"/.test(tag);
        expect(`${p.path}: ${ok ? "ok" : tag}`).toBe(`${p.path}: ok`);
      }
    }
  });

  it("points every internal link and anchor at something that exists", () => {
    for (const [path, html] of all) {
      for (const href of internalHrefs(html)) {
        const [beforeHash, hash] = href.split("#");
        const target = beforeHash.split("?")[0] || path;
        let state = "ok";
        if (isAsset(target)) state = existsSync(join(siteDir, target)) ? "ok" : "missing asset";
        else if (target !== "/" && target.endsWith("/")) state = "trailing slash";
        else if (DYNAMIC.has(target)) state = "ok";
        else if (!all.has(target)) state = redirectSources.includes(target) ? "links to a redirect" : "missing page";
        else if (hash && !all.get(target)!.includes(`id="${hash}"`)) state = "missing anchor";
        expect(`${path} -> ${href}: ${state}`).toBe(`${path} -> ${href}: ok`);
      }
    }
  });

  it("links to every sitemap page from at least one other indexable page", () => {
    const inbound = new Set<string>();
    for (const [path, html] of all) {
      if (noindex(html)) continue; // a link from the 404 page does not make a page findable
      for (const href of internalHrefs(html)) {
        const target = href.split("#")[0].split("?")[0] || path;
        if (target !== path) inbound.add(target);
      }
    }
    for (const p of pages.filter((p) => p.path !== "/")) expect(`${p.path}: ${inbound.has(p.path)}`).toBe(`${p.path}: true`);
  });

  it("links the six thinly linked pages of the audit from at least two other pages' body text", () => {
    // Audit item 1: these had one in-body inbound link each. Count distinct indexable pages that link
    // from inside <main>, so the shared footer does not count.
    const THIN = ["/compare/figwright", "/compare/code-connect", "/figma-mcp-starter-plan", "/tools/components", "/tools/auto-layout", "/tools/prototype"];
    const from = new Map<string, Set<string>>(THIN.map((t) => [t, new Set()]));
    for (const [path, html] of all) {
      if (noindex(html)) continue;
      const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? "";
      for (const href of internalHrefs(main)) {
        const target = href.split("#")[0].split("?")[0];
        if (target !== path) from.get(target)?.add(path);
      }
    }
    for (const t of THIN) expect(`${t}: ${from.get(t)!.size >= 2}`).toBe(`${t}: true`);
  });

  it("gives each translated page a full, reciprocal hreflang set with x-default", () => {
    // Pages that carry hreflang form clusters: the homepage and its 8 locale homes, and each translated
    // leaf page with its English original. Within a cluster every page carries the same set.
    const sets = new Map<string, Map<string, string>>();
    for (const p of pages) {
      const set = new Map([...p.html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => [m[1], m[2]] as [string, string]));
      if (set.size) sets.set(p.loc, set);
    }
    // Each translated leaf cluster is English + ja + zh-CN.
    const LEAF_CLUSTERS = ["/figma-mcp-rate-limit", "/pricing", "/docs/setup", "/what-is-figma-mcp", "/troubleshooting/not-working", "/tutorials/edit-figma-with-claude-code"];
    const CLUSTERS: Record<string, number> = { [`${SITE}/`]: 9, ...Object.fromEntries(LEAF_CLUSTERS.map((p) => [`${SITE}${p}`, 3])) };
    const clusterOf = (set: Map<string, string>) => set.get("en") ?? "none";
    for (const [en, size] of Object.entries(CLUSTERS)) {
      const members = [...sets].filter(([, set]) => clusterOf(set) === en).map(([loc]) => loc);
      expect(`${en}: ${members.length}`).toBe(`${en}: ${size}`);
    }
    for (const [loc, set] of sets) {
      const en = clusterOf(set);
      expect(`${loc}: cluster ${en in CLUSTERS ? "known" : en}`).toBe(`${loc}: cluster known`);
      const reference = JSON.stringify([...sets.get(en)!].sort());
      expect(`${loc}: ${JSON.stringify([...set].sort())}`).toBe(`${loc}: ${reference}`);
      expect(`${loc}: ${[...set.values()].includes(loc)}`).toBe(`${loc}: true`);
      expect(`${loc}: ${set.get("x-default")}`).toBe(`${loc}: ${en}`);
      for (const href of set.values()) expect(`${loc} -> ${href}: ${sets.has(href)}`).toBe(`${loc} -> ${href}: true`);
    }
  });

  it("lists every sitemap page in llms.txt, and only real pages", () => {
    // URL presence only; the entry text is reviewed, not tested.
    const llms = read("site/llms.txt");
    const listed = new Set([...llms.matchAll(/https:\/\/figmamcp\.dev(\/[^\s)\],]*)/g)].map((m) => `${SITE}${m[1]}`));
    for (const loc of locs) expect(`${loc}: ${listed.has(loc)}`).toBe(`${loc}: true`);
    for (const url of listed) expect(`${url}: ${locs.includes(url) || url === `${SITE}/download`}`).toBe(`${url}: true`);
  });
});

it("opens exactly one <main> per page", () => {
  // Four pages once had a duplicated <main id="main">: two main landmarks and a repeated id.
  for (const p of pages) expect(`${p.path}: ${(p.html.match(/<main\b/g) ?? []).length}`).toBe(`${p.path}: 1`);
});

it("serves each sitemap page from a file that exists", () => {
  for (const loc of locs) expect(existsSync(join(root, fileOf(loc)))).toBe(true);
});

describe("site page: how FigmaMCP is built (growth 0e)", () => {
  const path = "/how-figmamcp-is-built";
  const html = read(`site${path}/index.html`);
  const mainOf = (h: string) => h.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? "";

  it("is in the sitemap and llms.txt", () => {
    expect(locs).toContain(`https://figmamcp.dev${path}`);
    expect(read("site/llms.txt")).toContain(`(https://figmamcp.dev${path})`);
  });

  it("links to and from /how-figma-mcp-works and /is-figma-mcp-safe in body text", () => {
    expect(mainOf(html)).toContain('href="/how-figma-mcp-works"');
    for (const from of ["site/how-figma-mcp-works/index.html", "site/is-figma-mcp-safe/index.html"]) {
      expect(`${from}: ${mainOf(read(from)).includes(`href="${path}"`)}`).toBe(`${from}: true`);
    }
    for (const to of ["/docs/setup", "/is-figma-mcp-safe", "/tutorials", "/tools"]) {
      expect(`${to}: ${mainOf(html).includes(`href="${to}"`)}`).toBe(`${to}: true`);
    }
  });

  it("does not compete with /how-figma-mcp-works for its title or h1", () => {
    const other = read("site/how-figma-mcp-works/index.html");
    const h1 = (h: string) => decode(h.match(/<h1>([^<]*)<\/h1>/)?.[1] ?? "");
    expect(title(html)).not.toBe(title(other));
    expect(h1(html)).not.toBe(h1(other));
    expect(title(html).toLowerCase()).toContain("figmamcp architecture");
  });

  it("has one accessible inline SVG diagram in main, labelled by its own title", () => {
    const svgs = [...mainOf(html).matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/g)];
    expect(svgs.length).toBe(1);
    const [, attrs, body] = svgs[0];
    expect(attrs).toContain('role="img"');
    const labelled = attrs.match(/aria-labelledby="([^"]+)"/)?.[1].split(" ") ?? [];
    const titleId = body.match(/<title id="([^"]+)">[^<]+<\/title>/)?.[1];
    expect(titleId).toBeDefined();
    expect(labelled).toContain(titleId!);
    for (const id of labelled) expect(`${id}: ${body.includes(`id="${id}"`)}`).toBe(`${id}: true`);
  });

  it("uses no style attribute or style element, which the CSP (style-src 'self') would block", () => {
    expect(html).not.toMatch(/\sstyle="|<style\b/);
  });

  it("has TechArticle, WebPage and BreadcrumbList JSON-LD that parses", () => {
    expect(ofType(html, "TechArticle").length).toBe(1);
    expect(pageNode(html).length).toBe(1);
    expect(ofType(html, "BreadcrumbList").length).toBe(1);
    expect(ofType(html, "TechArticle")[0].publisher["@id"]).toBe(ORG_ID);
  });
});
