import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import worker from "./index.js";

// Every Analytics Engine row the pixels write is also sent to Mixpanel as one event.
// The expected $insert_id is computed here from the literal formula, not with the worker's helper.
const NOW_MS = Date.UTC(2026, 10, 22, 3, 4, 5);
const NOW_S = Math.floor(NOW_MS / 1000);
const realFetch = globalThis.fetch;
let upstream;
let points;
let pending;

beforeEach(() => {
  setSystemTime(new Date(NOW_MS));
  upstream = [];
  points = [];
  pending = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://api.mixpanel.com/")) {
      upstream.push({ url: u, init, body: JSON.parse(init.body) });
      return new Response('{"status":1,"error":null}', { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
});
afterEach(() => {
  setSystemTime();
  globalThis.fetch = realFetch;
});

const env = () => ({ ASSETS: { fetch: () => new Response("asset") }, LOADS: { writeDataPoint: (p) => points.push(p) } });
const ctx = () => ({ waitUntil: (p) => pending.push(p) });

async function hit(path, { country = "AU", headers = {} } = {}) {
  const request = new Request(`https://figmamcp.dev${path}`, { headers: { "cf-connecting-ip": "203.0.113.7", ...headers } });
  Object.defineProperty(request, "cf", { value: country === null ? {} : { country } });
  const res = await worker.fetch(request, env(), ctx());
  await Promise.all(pending);
  return res;
}

async function insertId(event, distinctId, blobs) {
  const text = `${event}|${distinctId}|${NOW_S}|${blobs.join("|")}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function only() {
  expect(upstream).toHaveLength(1);
  const url = new URL(upstream[0].url);
  expect(url.origin + url.pathname).toBe("https://api.mixpanel.com/track");
  expect(url.searchParams.get("ip")).toBe("0");
  expect(JSON.stringify(upstream[0])).not.toContain("203.0.113.7");
  expect(upstream[0].body).toHaveLength(1);
  return upstream[0].body[0];
}

const common = (distinctId, country = "AU") => ({
  product: "figmamcp",
  source: "pixel",
  token: "62d0ff230c6799db2a4d30a04fe5e1e2",
  mp_country_code: country,
  time: NOW_S,
  distinct_id: distinctId,
});

describe("pixel rows are mirrored to Mixpanel", () => {
  test("p.gif plugin load -> px_plugin_loaded", async () => {
    const res = await hit("/p.gif?v=0.1.20&i=a1b2c3d4e5f60718");
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(points[0].blobs).toEqual(["0.1.20", "AU", "a1b2c3d4e5f60718", ""]);
    const e = only();
    expect(e.event).toBe("px_plugin_loaded");
    expect(e.properties).toEqual({
      ...common("a1b2c3d4e5f60718"),
      is_internal: false,
      plugin_version: "0.1.20",
      $insert_id: await insertId("px_plugin_loaded", "a1b2c3d4e5f60718", ["0.1.20", "AU", "a1b2c3d4e5f60718", ""]),
    });
  });

  test("p.gif without an install ID (0.1.10) uses noid-<country>", async () => {
    await hit("/p.gif?v=0.1.10", { country: "DE" });
    const e = only();
    expect(e.event).toBe("px_plugin_loaded");
    expect(e.properties.distinct_id).toBe("noid-DE");
    expect(e.properties.$insert_id).toBe(await insertId("px_plugin_loaded", "noid-DE", ["0.1.10", "DE", "", ""]));
  });

  test("the test install ID is internal", async () => {
    await hit("/p.gif?v=0.1.25&i=0000000000000001");
    expect(only().properties.is_internal).toBe(true);
  });

  test("p.gif app launch -> px_app_launched, owner Mac app is internal", async () => {
    await hit("/p.gif?v=app-0.1.24&i=3ca9259ba36013aa");
    const e = only();
    expect(e.event).toBe("px_app_launched");
    expect(e.properties).toEqual({
      ...common("3ca9259ba36013aa"),
      is_internal: true,
      app_version: "0.1.24",
      $insert_id: await insertId("px_app_launched", "3ca9259ba36013aa", ["app-0.1.24", "AU", "3ca9259ba36013aa", ""]),
    });
  });

  test("site visit -> site_visited with lang and a random site- ID", async () => {
    await hit("/p.gif?l=ja", { country: "JP" });
    const e = only();
    expect(e.event).toBe("site_visited");
    const id = e.properties.distinct_id;
    expect(id).toMatch(/^site-[0-9a-f-]{36}$/);
    expect(e.properties).toEqual({
      ...common(id, "JP"),
      is_internal: false,
      lang: "ja",
      $insert_id: await insertId("site_visited", id, ["site", "JP", "", "ja"]),
    });
  });

  test("country is the value AE stores, XX when Cloudflare has none", async () => {
    await hit("/p.gif", { country: null });
    expect(points[0].blobs[1]).toBe("XX");
    expect(only().properties.mp_country_code).toBe("XX");
  });

  test("c.gif -> px_connected", async () => {
    await hit("/c.gif?v=0.1.22&i=0000000000000001");
    const e = only();
    expect(e.event).toBe("px_connected");
    expect(e.properties).toEqual({
      ...common("0000000000000001"),
      is_internal: true,
      plugin_version: "0.1.22",
      $insert_id: await insertId("px_connected", "0000000000000001", ["connected", "0.1.22", "AU", "0000000000000001"]),
    });
  });

  test("u.gif -> px_usage with calls, tools and tool_counts", async () => {
    await hit("/u.gif?v=0.1.22&i=a1b2c3d4e5f60718&ok=4&err=1&t=node_info:3,node_delete:2,bogus_tool:9&f=node_delete:NAME_MISMATCH:1");
    const blobs = ["usage", "0.1.22", "AU", "a1b2c3d4e5f60718", "node_info:3,node_delete:2", "node_delete:NAME_MISMATCH:1"];
    expect(points[0].blobs).toEqual(blobs);
    const e = only();
    expect(e.event).toBe("px_usage");
    expect(e.properties).toEqual({
      ...common("a1b2c3d4e5f60718"),
      is_internal: false,
      plugin_version: "0.1.22",
      calls: 5,
      calls_ok: 4,
      calls_err: 1,
      tools: ["node_info", "node_delete"],
      tool_counts: "node_info:3,node_delete:2",
      $insert_id: await insertId("px_usage", "a1b2c3d4e5f60718", blobs),
    });
  });

  test("/download -> download with is_bot and referrer_host", async () => {
    const res = await hit("/download", { headers: { "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15", referer: "https://news.ycombinator.com/item?id=1" } });
    expect(res.status).toBe(302);
    const e = only();
    expect(e.event).toBe("download");
    const id = e.properties.distinct_id;
    expect(id).toMatch(/^dl-[0-9a-f-]{36}$/);
    expect(e.properties).toEqual({
      ...common(id),
      is_internal: false,
      is_bot: false,
      referrer_host: "news.ycombinator.com",
      $insert_id: await insertId("download", id, ["download", "AU", "human", "news.ycombinator.com"]),
    });
  });

  test("/download by curl is a bot", async () => {
    await hit("/download", { headers: { "user-agent": "curl/8.7.1" } });
    expect(only().properties).toMatchObject({ is_bot: true, referrer_host: "" });
  });

  test("the same row always gets the same $insert_id", async () => {
    await hit("/c.gif?v=0.1.22&i=a1b2c3d4e5f60718");
    await hit("/c.gif?v=0.1.22&i=a1b2c3d4e5f60718");
    expect(upstream).toHaveLength(2);
    expect(upstream[0].body[0].properties.$insert_id).toBe(upstream[1].body[0].properties.$insert_id);
  });
});

describe("what is not mirrored", () => {
  test.each(["deploy-check", "site-private-check", "test-download-check", "app-beta", "1.2"])("test label %s stays in AE only", async (label) => {
    await hit(`/p.gif?v=${label}&i=0000000000000001`);
    expect(points).toHaveLength(1);
    expect(upstream).toHaveLength(0);
  });

  test("rejected c.gif and u.gif rows (no AE write) are not mirrored", async () => {
    await hit("/c.gif?v=0.1.22&i=nothex");
    await hit("/u.gif?v=0.1.22&i=a1b2c3d4e5f60718&ok=0&err=0");
    expect(points).toHaveLength(0);
    expect(upstream).toHaveLength(0);
  });
});

describe("a Mixpanel failure never changes the pixel response", () => {
  beforeEach(() => {
    globalThis.fetch = async (url) => {
      if (String(url).startsWith("https://api.mixpanel.com/")) throw new Error("down");
      return new Response("{}", { status: 404 });
    };
  });

  test.each(["/p.gif?v=0.1.20&i=a1b2c3d4e5f60718", "/p.gif", "/p.gif?v=app-0.1.24&i=3ca9259ba36013aa", "/c.gif?v=0.1.22&i=a1b2c3d4e5f60718", "/u.gif?v=0.1.22&i=a1b2c3d4e5f60718&ok=1"])("%s still returns the GIF and writes AE", async (path) => {
    const res = await hit(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(points).toHaveLength(1);
  });

  test("/download still redirects and writes AE", async () => {
    const res = await hit("/download", { headers: { "user-agent": "curl/8.7.1" } });
    expect(res.status).toBe(302);
    expect(points).toHaveLength(1);
  });

  test("works without a ctx", async () => {
    const request = new Request("https://figmamcp.dev/p.gif?v=0.1.20&i=a1b2c3d4e5f60718");
    const res = await worker.fetch(request, env());
    expect(res.status).toBe(200);
  });
});
