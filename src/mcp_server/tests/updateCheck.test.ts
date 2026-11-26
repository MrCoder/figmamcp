import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import worker from "../../../site-worker/index.js";

const LATEST = "https://api.github.com/repos/MrCoder/figmamcp-releases/releases/latest";
const RELEASE_PAGE = "https://github.com/MrCoder/figmamcp-releases/releases/latest";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const env = { ASSETS: { fetch: () => new Response("asset") } };
const get = () => worker.fetch(new Request("https://figmamcp.dev/latest.json"), env);

describe("GET /latest.json", () => {
  it("returns the latest release version from the release tag, with CORS", async () => {
    globalThis.fetch = (async (u: any) => {
      if (String(u) !== LATEST) throw new Error("unexpected " + u);
      return Response.json({ tag_name: "v0.1.14" });
    }) as typeof fetch;
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ version: "0.1.14", url: "https://figmamcp.dev/download" });
  });

  // 2026-11-20: live /latest.json returned 503 while api.github.com answered 200 from a Mac.
  // Unauthenticated API calls from shared Worker IPs hit GitHub's rate limit (403); the
  // github.com release page redirect carries the tag and has no API rate limit.
  it("reads the version from the release page redirect when the API is rate-limited", async () => {
    globalThis.fetch = (async (u: any) => {
      const url = String(u);
      if (url === LATEST) return new Response('{"message":"API rate limit exceeded"}', { status: 403 });
      if (url === RELEASE_PAGE) return new Response(null, { status: 302, headers: { location: "https://github.com/MrCoder/figmamcp-releases/releases/tag/v0.1.20" } });
      throw new Error("unexpected " + u);
    }) as typeof fetch;
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "0.1.20", url: "https://figmamcp.dev/download" });
  });

  it("answers 503 when GitHub fails, still with CORS", async () => {
    globalThis.fetch = (async () => { throw new Error("down"); }) as typeof fetch;
    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("is routed to the worker before static assets", () => {
    const cfg = readFileSync(join(import.meta.dir, "../../../wrangler.jsonc"), "utf8");
    // "/*" sends every path to the worker; only the paths negated with "!" go straight to static assets.
    expect(cfg).toContain('"/*"');
    expect(cfg).not.toContain('"!/latest.json"');
  });
});

// The update-check code lives inline in ui.html between markers; evaluate that exact code.
function loadUpdateCheck() {
  const html = readFileSync(join(import.meta.dir, "../../../figma_plugin/ui.html"), "utf8");
  const m = html.match(/\/\/ <update-check>([\s\S]*?)\/\/ <\/update-check>/);
  if (!m) throw new Error("update-check block missing in ui.html");
  return new Function(m[1] + "; return { compareVersions, updateBannerText };")();
}

describe("plugin update banner decision", () => {
  const { compareVersions, updateBannerText } = loadUpdateCheck();

  it("compares semver numerically", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.9", "0.1.10")).toBeLessThan(0);
    expect(compareVersions("0.2.0", "0.1.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("shows a banner only when the running version is older", () => {
    expect(updateBannerText("0.1.10", { version: "0.1.14" }, "en")).toBe("New version 0.1.14 available — download at figmamcp.dev");
    expect(updateBannerText("0.1.10", { version: "0.1.14" }, "zh-CN")).toBe("新版本 0.1.14 已发布 — 前往 figmamcp.dev 下载");
    expect(updateBannerText("0.1.14", { version: "0.1.14" }, "en")).toBeNull();
    expect(updateBannerText("0.1.15", { version: "0.1.14" }, "en")).toBeNull();
  });

  it("ignores malformed responses", () => {
    expect(updateBannerText("0.1.10", null, "en")).toBeNull();
    expect(updateBannerText("0.1.10", { version: "<b>9</b>" }, "en")).toBeNull();
    expect(updateBannerText("0.1.10", {}, "en")).toBeNull();
  });
});
