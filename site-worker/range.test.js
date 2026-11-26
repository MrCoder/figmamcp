import { describe, expect, test } from "bun:test";
import worker from "./index.js";

// The static asset layer answers a Range request with 200 and the whole file.
// Safari and iOS refuse to play a <video> unless the server answers byte ranges with 206.
const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
const env = () => ({
  ASSETS: {
    fetch: () => new Response(BYTES, { headers: { "content-type": "video/mp4", etag: '"abc"', "cache-control": "public, max-age=604800" } }),
  },
});
const get = (range) => new Request("https://figmamcp.dev/assets/figmamcp-demo.mp4", { headers: range ? { range } : {} });

describe("GET /assets/*.mp4 byte ranges", () => {
  test("answers bytes=0-1 with 206 and the two bytes", async () => {
    const res = await worker.fetch(get("bytes=0-1"), env(), {});
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-1/1000");
    expect(res.headers.get("content-length")).toBe("2");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0, 1]);
  });

  test("answers an open range to the end of the file", async () => {
    const res = await worker.fetch(get("bytes=990-"), env(), {});
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 990-999/1000");
    expect((await res.arrayBuffer()).byteLength).toBe(10);
  });

  test("answers a suffix range with the last N bytes", async () => {
    const res = await worker.fetch(get("bytes=-5"), env(), {});
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 995-999/1000");
  });

  test("answers a range past the end with 416", async () => {
    const res = await worker.fetch(get("bytes=5000-6000"), env(), {});
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */1000");
  });

  test("answers a request without Range with 200, the full file and accept-ranges", async () => {
    const res = await worker.fetch(get(null), env(), {});
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
  });
});
