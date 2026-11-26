import { afterEach, describe, expect, it } from "bun:test";
import worker from "../../../site-worker/index.js";

const DIRECT = "https://github.com/MrCoder/figmamcp-releases/releases/latest/download/FigmaMCP.dmg";
const LATEST = "https://api.github.com/repos/MrCoder/figmamcp-releases/releases/latest";
const ASSET = "https://api.github.com/repos/MrCoder/figmamcp-releases/releases/assets/77";
const TAGGED = "https://github.com/MrCoder/figmamcp-releases/releases/download/v0.1.0/FigmaMCP.dmg";
const RELEASE_PAGE = "https://github.com/MrCoder/figmamcp-releases/releases/latest";
const SIGNED_DIRECT = "https://release-assets.example/direct";
const SIGNED_API = "https://release-assets.example/api";

type Route = () => Response;
const redirect = (location: string): Route => () => new Response(null, { status: 302, headers: { location } });
const gateway: Route = () => new Response("504", { status: 504 });
const latest: Route = () => Response.json({ assets: [{ id: 5, name: "other.zip" }, { id: 77, name: "FigmaMCP.dmg" }] });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubGitHub(routes: Record<string, Route>) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const route = routes[String(input)];
    if (!route) throw new Error(`network failure for ${input}`);
    return route();
  }) as typeof fetch;
}

const download = () => worker.fetch(new Request("https://figmamcp.dev/download"), { ASSETS: { fetch: () => new Response("asset") } });

describe("site /download", () => {
  it("sends the visitor to the signed URL when the normal GitHub link works", async () => {
    stubGitHub({ [DIRECT]: redirect(SIGNED_DIRECT) });
    const res = await download();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SIGNED_DIRECT);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("follows the tagged GitHub link so the visitor never lands on github.com", async () => {
    stubGitHub({ [DIRECT]: redirect(TAGGED), [TAGGED]: redirect(SIGNED_DIRECT) });
    const res = await download();
    expect(res.headers.get("location")).toBe(SIGNED_DIRECT);
  });

  it("uses the GitHub API when the tagged GitHub link returns 504", async () => {
    stubGitHub({ [DIRECT]: redirect(TAGGED), [TAGGED]: gateway, [LATEST]: latest, [ASSET]: redirect(SIGNED_API) });
    const res = await download();
    expect(res.headers.get("location")).toBe(SIGNED_API);
  });

  it("uses the GitHub API when the normal link returns 504", async () => {
    stubGitHub({ [DIRECT]: gateway, [LATEST]: latest, [ASSET]: redirect(SIGNED_API) });
    const res = await download();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SIGNED_API);
  });

  it("uses the GitHub API when the normal link throws", async () => {
    stubGitHub({ [LATEST]: latest, [ASSET]: redirect(SIGNED_API) });
    const res = await download();
    expect(res.headers.get("location")).toBe(SIGNED_API);
  });

  it("sends the visitor to the release page when both routes fail", async () => {
    stubGitHub({ [DIRECT]: gateway, [LATEST]: gateway });
    const res = await download();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(RELEASE_PAGE);
  });

  it("sends the visitor to the release page when the release has no DMG", async () => {
    stubGitHub({ [DIRECT]: gateway, [LATEST]: () => Response.json({ assets: [] }) });
    const res = await download();
    expect(res.headers.get("location")).toBe(RELEASE_PAGE);
  });
});

describe("site /download count", () => {
  type Point = { blobs: string[]; doubles: number[]; indexes: string[] };
  const hit = (headers: Record<string, string>, country: string | undefined, LOADS: { writeDataPoint: (p: Point) => void }) => {
    stubGitHub({ [DIRECT]: redirect(SIGNED_DIRECT) });
    const request = new Request("https://figmamcp.dev/download", { headers });
    if (country) Object.defineProperty(request, "cf", { value: { country } });
    return worker.fetch(request, { ASSETS: { fetch: () => new Response("asset") }, LOADS });
  };
  const collect = () => {
    const points: Point[] = [];
    return { points, LOADS: { writeDataPoint: (p: Point) => void points.push(p) } };
  };

  it("counts a browser download with country and referrer host only", async () => {
    const { points, LOADS } = collect();
    const res = await hit({ "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1", referer: "https://news.ycombinator.com/item?id=1&q=secret" }, "AU", LOADS);
    expect(res.status).toBe(302);
    expect(points).toEqual([{ blobs: ["download", "AU", "human", "news.ycombinator.com"], doubles: [1], indexes: ["download"] }]);
  });

  it("flags crawlers, previews, curl and an empty user agent as bot", async () => {
    for (const ua of ["Googlebot/2.1", "Slackbot-LinkExpanding", "facebookexternalhit/1.1", "curl/8.4.0", "python-requests/2.31", "HeadlessChrome/120", "Mozilla/5.0 LinkPreview", ""]) {
      const { points, LOADS } = collect();
      await hit(ua ? { "user-agent": ua } : {}, "US", LOADS);
      expect(points[0].blobs[2], ua).toBe("bot");
    }
  });

  it("uses XX without a country and an empty referrer host without a valid Referer", async () => {
    const { points, LOADS } = collect();
    await hit({ "user-agent": "Mozilla/5.0 Safari", referer: "not a url" }, undefined, LOADS);
    expect(points[0].blobs).toEqual(["download", "XX", "human", ""]);
  });

  it("never stores the user agent or IP", async () => {
    const { points, LOADS } = collect();
    await hit({ "user-agent": "Mozilla/5.0 SecretUA Safari", "cf-connecting-ip": "203.0.113.9" }, "AU", LOADS);
    const stored = JSON.stringify(points);
    expect(stored).not.toContain("SecretUA");
    expect(stored).not.toContain("203.0.113.9");
  });

  it("still redirects when the counter throws", async () => {
    const res = await hit({ "user-agent": "Mozilla/5.0 Safari" }, "AU", { writeDataPoint: () => { throw new Error("analytics down"); } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SIGNED_DIRECT);
  });
});
