import { describe, expect, test } from "bun:test";
import worker from "./index.js";

// Site page-view ping: which page, which site sent the visitor, which campaign tag.
// AE blob layout for a 'site' row: 1 'site', 2 country, 3 install ID (empty), 4 locale,
// 5 page path, 6 referring host, 7 utm_source.
const mk = (assets) => {
  const points = [];
  return { points, env: { ASSETS: { fetch: assets || (() => new Response("asset")) }, LOADS: { writeDataPoint: (p) => points.push(p) } } };
};
const ctx = () => ({ waitUntil() {} });
const ping = async (qs) => {
  const { points, env } = mk();
  const request = new Request(`https://figmamcp.dev/p.gif${qs}`);
  Object.defineProperty(request, "cf", { value: { country: "AU" } });
  await worker.fetch(request, env, ctx());
  expect(points).toHaveLength(1);
  return points[0].blobs;
};

describe("/p.gif site row", () => {
  test("stores path, referrer host and utm_source in blobs 5-7", async () => {
    expect(await ping("?l=en&p=%2Fpricing&r=www.google.com&u=agenttest")).toEqual(["site", "AU", "", "en", "/pricing", "www.google.com", "agenttest"]);
  });

  test("a plain ping still works and the new blobs are empty", async () => {
    expect(await ping("")).toEqual(["site", "AU", "", "", "", "", ""]);
  });

  test("path loses query and hash, and is cut at 100 characters", async () => {
    expect((await ping("?p=%2Fa%3Fx%3D1%23h"))[4]).toBe("/a");
    expect((await ping(`?p=%2F${"a".repeat(300)}`))[4]).toBe(`/${"a".repeat(99)}`);
    expect((await ping("?p=pricing"))[4]).toBe("");
  });

  test("referrer is reduced to a host, never a full address", async () => {
    expect((await ping("?r=https%3A%2F%2Fnews.ycombinator.com%2Fitem%3Fid%3D1%26token%3Dsecret"))[5]).toBe("news.ycombinator.com");
    expect((await ping("?r=Www.Bing.COM"))[5]).toBe("www.bing.com");
    expect((await ping("?r=%3Cscript%3E"))[5]).toBe("");
  });

  test("same-origin referrer is dropped", async () => {
    expect((await ping("?r=figmamcp.dev"))[5]).toBe("");
    expect((await ping("?r=www.figmamcp.dev"))[5]).toBe("");
    expect((await ping("?r=https%3A%2F%2Ffigmamcp.dev%2Fpricing"))[5]).toBe("");
  });

  test("utm_source is lower-cased, cleaned to [a-z0-9._-] and cut at 40", async () => {
    expect((await ping("?u=Reddit-ClaudeAI"))[6]).toBe("reddit-claudeai");
    expect((await ping("?u=a%20b%2Fc%3Cd%3E%40"))[6]).toBe("abcd");
    expect((await ping(`?u=${"x".repeat(80)}`))[6]).toHaveLength(40);
  });

  test("other row types keep their layout (plugin load has no page fields)", async () => {
    expect(await ping("?v=0.1.24&i=0123456789abcdef&p=%2Fx&r=google.com&u=z")).toEqual(["0.1.24", "AU", "0123456789abcdef", ""]);
  });
});

describe("page request adds the fields to the ping image", () => {
  const html = '<html><body><img class="px" src="/p.gif?l=en" width="1" height="1" alt=""><img src="/other.png"></body></html>';
  const page = async (path, headers = {}, assets) => {
    const seen = [];
    const { env } = mk(assets || ((req) => { seen.push(req); return new Response(html, { headers: { "content-type": "text/html", etag: '"abc"' } }); }));
    const request = new Request(`https://figmamcp.dev${path}`, { headers });
    Object.defineProperty(request, "cf", { value: { country: "AU" } });
    const res = await worker.fetch(request, env, ctx());
    return { res, body: await res.text(), seen };
  };

  test("path, referrer host and utm_source go into the ping URL; nothing else from the referrer", async () => {
    const { body } = await page("/pricing?utm_source=AgentTest&q=1", { referer: "https://www.google.com/search?q=secret" });
    const src = new URL(/src="(\/p\.gif[^"]*)"/.exec(body)[1].replaceAll("&amp;", "&"), "https://figmamcp.dev");
    expect(src.searchParams.get("l")).toBe("en");
    expect(src.searchParams.get("p")).toBe("/pricing");
    expect(src.searchParams.get("r")).toBe("www.google.com");
    expect(src.searchParams.get("u")).toBe("agenttest");
    expect(body).not.toContain("secret");
    expect(body).toContain('src="/other.png"');
  });

  test("no referrer and no utm: only the path is added", async () => {
    const { body } = await page("/tools");
    expect(body).toContain("p=%2Ftools");
    expect(body).not.toMatch(/[?&]r=/);
    expect(body).not.toMatch(/[?&]u=/);
  });

  test("a page opened from another page of the site has no referrer host", async () => {
    const { body } = await page("/", { referer: "https://figmamcp.dev/pricing" });
    expect(body).not.toMatch(/[?&]r=/);
  });

  test("conditional headers are not forwarded, so a 304 never reuses an old rewritten page", async () => {
    const { seen, res } = await page("/pricing", { "if-none-match": '"abc"', "if-modified-since": "Wed, 01 Jan 2026 00:00:00 GMT" });
    expect(seen[0].headers.get("if-none-match")).toBeNull();
    expect(seen[0].headers.get("if-modified-since")).toBeNull();
    expect(res.headers.get("etag")).toBeNull();
  });

  test("non-HTML assets pass through untouched", async () => {
    const { body, res } = await page("/app.js", {}, () => new Response("var a=1", { headers: { "content-type": "text/javascript", etag: '"js"' } }));
    expect(body).toBe("var a=1");
    expect(res.headers.get("etag")).toBe('"js"');
  });
});
