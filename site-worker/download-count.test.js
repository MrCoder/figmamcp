import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker from "./index.js";

// /download writes one Analytics Engine data point per hit: blobs = [event, country, "bot" | "human", referrerHost].
// Link checkers and HTTP libraries are not people, so they must land in the "bot" bucket.
const realFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = async () => new Response("{}", { status: 404 }); });
afterEach(() => { globalThis.fetch = realFetch; });

async function labelFor(ua) {
  const points = [];
  const env = { LOADS: { writeDataPoint: (p) => points.push(p) }, ASSETS: { fetch: () => new Response("asset") } };
  const headers = ua === undefined ? {} : { "user-agent": ua };
  const res = await worker.fetch(new Request("https://figmamcp.dev/download", { headers }), env, {});
  expect(res.status).toBe(302);
  expect(points).toHaveLength(1);
  return points[0].blobs[2];
}

describe("GET /download bot or human label", () => {
  test("labels our CI link checker (lychee) as bot", async () => {
    expect(await labelFor("lychee/0.18.1")).toBe("bot");
  });

  test.each([
    "linkchecker/10.4.0",
    "Go-http-client/2.0",
    "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
    "undici",
    "axios/1.7.2",
    "okhttp/4.12.0",
    "Apache-HttpClient/4.5.14 (Java/17)",
    "Java/17.0.2",
    "libwww-perl/6.67",
    "Scrapy/2.11.0 (+https://scrapy.org)",
    "UptimeRobot/2.0",
    "Pingdom monitor",
  ])("labels %s as bot", async (ua) => {
    expect(await labelFor(ua)).toBe("bot");
  });

  test("labels a missing user agent as bot", async () => {
    expect(await labelFor(undefined)).toBe("bot");
  });

  test.each([
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ])("keeps browser %s as human", async (ua) => {
    expect(await labelFor(ua)).toBe("human");
  });
});
