// Tells IndexNow engines (Bing, Yandex, Seznam, Naver...) that the sitemap URLs changed.
// Runs after `wrangler deploy` in `bun run deploy:site`. It must never fail the deploy:
// every error is printed and the process still exits 0.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const INDEXNOW_KEY = "1e5ffada13758433ea0bd1d7f90c711b";
const HOST = "figmamcp.dev";
const ENDPOINT = "https://api.indexnow.org/indexnow";
const TIMEOUT_MS = 10_000;

export function indexNowPayload(sitemap: string) {
  const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  return { host: HOST, key: INDEXNOW_KEY, keyLocation: `https://${HOST}/${INDEXNOW_KEY}.txt`, urlList };
}

// Returns the HTTP status (200 = accepted, 202 = accepted while the key is being checked), or null on a network error.
export async function pingIndexNow(sitemap: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(indexNowPayload(sitemap)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.status;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  try {
    const sitemap = readFileSync(join(import.meta.dir, "../site/sitemap.xml"), "utf8");
    const status = await pingIndexNow(sitemap);
    const count = indexNowPayload(sitemap).urlList.length;
    console.log(status === null ? `IndexNow: request failed (deploy not affected)` : `IndexNow: HTTP ${status} for ${count} URLs`);
  } catch (error) {
    console.log(`IndexNow: skipped (${error instanceof Error ? error.message : error})`);
  }
  process.exit(0);
}
