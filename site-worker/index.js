// Counts plugin and site loads. Stores the version and Cloudflare's country code only.
// Also resolves the Mac download, so one failing GitHub route does not stop a visitor.
const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));

const REPO = "MrCoder/figmamcp-releases";
const DMG = "FigmaMCP.dmg";
const DIRECT_URL = `https://github.com/${REPO}/releases/latest/download/${DMG}`;
const LATEST_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_PAGE_URL = `https://github.com/${REPO}/releases/latest`;
const USER_AGENT = "figmamcp-site";
const TIMEOUT_MS = 8000;

function ghFetch(url, accept) {
  return fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": USER_AGENT, ...(accept ? { accept } : {}) },
  });
}

function redirectTarget(response) {
  return response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
}

// GitHub answers with a second github.com link first. Only the signed URL after it avoids the host that can fail.
async function viaDirectLink() {
  let target = redirectTarget(await ghFetch(DIRECT_URL));
  for (let hop = 0; target && new URL(target).hostname === "github.com" && hop < 3; hop++) {
    target = redirectTarget(await ghFetch(target));
  }
  return target && new URL(target).hostname !== "github.com" ? target : null;
}

async function viaApi() {
  const latest = await ghFetch(LATEST_API_URL, "application/vnd.github+json");
  if (!latest.ok) return null;
  const { assets = [] } = await latest.json();
  const asset = assets.find((a) => a.name === DMG);
  if (!asset) return null;
  return redirectTarget(await ghFetch(`https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`, "application/octet-stream"));
}

async function resolveDownload() {
  for (const route of [viaDirectLink, viaApi]) {
    try {
      const target = await route();
      if (target) return target;
    } catch {
      // A failed or slow route falls through to the next one.
    }
  }
  return RELEASE_PAGE_URL;
}

// Optional email list (owner decision 2026-11-17). Stores email, source and time only, in Workers KV.
const SOURCES = new Set(["download", "footer", "home", "setup"]);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const RATE_LIMIT = 5;
const RATE_WINDOW_S = 3600;
const ALLOWED_ORIGINS = new Set(["https://figmamcp.dev", "https://www.figmamcp.dev"]);

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

async function readBody(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) return { form: false, data: await request.json().catch(() => ({})) };
  const fd = await request.formData().catch(() => null);
  return { form: true, data: fd ? Object.fromEntries(fd) : {} };
}

async function subscribe(request, env) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: "forbidden" }, 403);
  const { form, data } = await readBody(request);
  const done = () => (form ? new Response(null, { status: 303, headers: { location: "/subscribed" } }) : json({ ok: true }));
  // Honeypot: a hidden field people never fill. Answer as if it worked.
  if (typeof data.website === "string" && data.website.trim()) return done();
  const email = String(data.email || "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return json({ ok: false, error: "invalid_email" }, 400);
  const kv = env.SUBSCRIBERS;
  if (!kv) return json({ ok: false, error: "unavailable" }, 503);
  // Rate limit by a hash of the IP; the raw IP is never stored.
  const rlKey = `rl:${(await sha256(`figmamcp:${request.headers.get("cf-connecting-ip") || "unknown"}`)).slice(0, 32)}`;
  const count = Number(await kv.get(rlKey)) || 0;
  if (count >= RATE_LIMIT) return json({ ok: false, error: "rate_limited" }, 429);
  await kv.put(rlKey, String(count + 1), { expirationTtl: RATE_WINDOW_S });
  const key = `email:${email}`;
  if (!(await kv.get(key))) {
    const source = SOURCES.has(data.source) ? data.source : "other";
    await kv.put(key, JSON.stringify({ email, source, ts: new Date().toISOString() }));
  }
  return done();
}

// Newest released version, read from the release tag so it cannot drift from the release.
const LATEST_HEADERS = { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=600" };
// Edge-cached so plugin loads do not spend the GitHub API rate limit.
async function latestVersion(request, ctx) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(new URL("/latest.json", request.url).toString());
  const hit = cache && (await cache.match(key).catch(() => null));
  if (hit) return hit;
  const res = await fetchLatestVersion();
  if (cache && res.ok) {
    const put = cache.put(key, res.clone()).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(put);
  }
  return res;
}

// The release page redirects to /releases/tag/vX.Y.Z. It has no API rate limit, unlike
// unauthenticated api.github.com calls from shared Worker IPs, so it is tried first.
async function tagFromReleasePage() {
  const location = redirectTarget(await ghFetch(RELEASE_PAGE_URL));
  const m = location && location.match(/\/releases\/tag\/([^/?#]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function tagFromApi() {
  const res = await ghFetch(LATEST_API_URL, "application/vnd.github+json");
  if (!res.ok) return null;
  const { tag_name } = await res.json();
  return tag_name || null;
}

async function fetchLatestVersion() {
  for (const source of [tagFromReleasePage, tagFromApi]) {
    try {
      const version = String((await source()) || "").replace(/^v/, "");
      if (/^\d+\.\d+\.\d+$/.test(version)) {
        return new Response(JSON.stringify({ version, url: "https://figmamcp.dev/download" }), { headers: LATEST_HEADERS });
      }
    } catch {
      // Try the next source; the plugin ignores a failed check.
    }
  }
  return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { ...LATEST_HEADERS, "cache-control": "no-store" } });
}

// Anonymous usage counts from the plugin (owner decision 2026-11-18). Tool names, ok/error counts and failed tool:ERROR_CODE pairs only.
// Must match USAGE_TOOLS in figma_plugin/utils/usageCounter.ts.
const TOOLS = new Set(["annotation_list","annotation_set","component_delete_property","component_list","component_manage_property","create_component","create_component_set","create_frame","create_instance","create_shape","create_svg","create_text","instance_get_overrides","instance_set_overrides","instance_set_property","node_apply_style","node_bind_variable","node_clone","node_delete","node_export_visual","node_flatten","node_group","node_info","node_insert_child","node_rename","node_set_auto_layout","node_set_corner_radius","node_set_effects","node_set_fill","node_set_stroke","node_transform","node_ungroup","page_info","reaction_list","reaction_update","style_delete","style_list","style_manage","text_set_content","text_set_style","variable_delete","variable_list","variable_manage","view_navigate"]);
const MAX_COUNT = 10000;
const count = (raw) => { const n = /^\d{1,9}$/.test(raw || "") ? Number(raw) : 0; return Math.min(n, MAX_COUNT); };

// Fired once per plugin session, when the relay reports the first MCP client
// joining the channel — before any tool is called. Distinguishes "opened,
// no client" (p.gif) from "client connected" from "client called a tool" (u.gif).
function connectedPixel(url, request, env, ctx) {
  const p = url.searchParams;
  const version = p.get("v") || "";
  const installId = p.get("i") || "";
  if (/^\d+\.\d+\.\d+$/.test(version) && /^[0-9a-f]{16}$/.test(installId)) {
    const country = request.cf?.country || "XX";
    const blobs = ["connected", version, country, installId];
    env.LOADS?.writeDataPoint({ blobs, doubles: [1], indexes: ["connected"] });
    mirror(ctx, env, "px_connected", installId, country, blobs, { plugin_version: version });
  }
  return new Response(GIF, { headers: { "content-type": "image/gif", "cache-control": "no-store" } });
}

function usagePixel(url, request, env, ctx) {
  const p = url.searchParams;
  const version = p.get("v") || "";
  const installId = p.get("i") || "";
  const ok = count(p.get("ok"));
  const err = count(p.get("err"));
  const tools = String(p.get("t") || "").split(",").slice(0, 60).flatMap((pair) => {
    const m = /^([a-z_]{1,40}):(\d{1,9})$/.exec(pair);
    return m && TOOLS.has(m[1]) ? [`${m[1]}:${Math.min(Number(m[2]), MAX_COUNT)}`] : [];
  });
  const failures = String(p.get("f") || "").split(",").slice(0, 60).flatMap((item) => {
    const m = /^([a-z_]{1,40}):([A-Z][A-Z0-9_]{0,39}):(\d{1,9})$/.exec(item);
    return m && TOOLS.has(m[1]) ? [`${m[1]}:${m[2]}:${Math.min(Number(m[3]), MAX_COUNT)}`] : [];
  });
  if (/^\d+\.\d+\.\d+$/.test(version) && /^[0-9a-f]{16}$/.test(installId) && ok + err > 0) {
    const country = request.cf?.country || "XX";
    const blobs = ["usage", version, country, installId, tools.join(","), failures.join(",")];
    env.LOADS?.writeDataPoint({ blobs, doubles: [ok, err], indexes: ["usage"] });
    mirror(ctx, env, "px_usage", installId, country, blobs, {
      plugin_version: version,
      calls: ok + err,
      calls_ok: ok,
      calls_err: err,
      tools: tools.map((pair) => pair.slice(0, pair.indexOf(":"))),
      tool_counts: tools.join(","),
    });
  }
  return new Response(GIF, { headers: { "content-type": "image/gif", "cache-control": "no-store" } });
}

// Product usage events for Mixpanel (owner decision 2026-11-22), sent by the local relay and the Mac app.
// Only the events and properties below pass. The worker adds the country from Cloudflare, marks
// internal install IDs, adds the project token (public by Mixpanel's design) and forwards with ip=0,
// so Mixpanel never gets the sender's IP address. Mixpanel project "Diagramly.Ai" also holds another
// product's events, which is why every event carries product="figmamcp".
const MIXPANEL_TOKEN = "62d0ff230c6799db2a4d30a04fe5e1e2";
const MIXPANEL_TRACK_URL = "https://api.mixpanel.com/track?ip=0&verbose=1";
const MP_MAX_BODY = 64 * 1024;
const MP_MAX_EVENTS = 50;
const MP_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;
const INTERNAL_IDS = new Set(["a531dc8409abd710", "0123456789abcdef", "00000000000000aa", "0000000000000001", "31f1abe9b07d14d3", "22a24d25d5d2574c", "3ca9259ba36013aa"]);
const VERSION_OK = (v) => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);
const MP_COMMON = {
  distinct_id: (v) => typeof v === "string" && /^[0-9a-f]{16}$/.test(v),
  time: (v) => Number.isInteger(v) && v > Date.now() - MP_MAX_AGE_MS && v < Date.now() + 60 * 60 * 1000,
  $insert_id: (v) => typeof v === "string" && /^[A-Za-z0-9-]{8,36}$/.test(v),
  product: (v) => v === "figmamcp",
  server_version: VERSION_OK,
  plugin_version: VERSION_OK,
  os: (v) => typeof v === "string" && /^(macOS( \d{1,2})?|Linux|Windows|other)$/.test(v),
};
const MP_REQUIRED = ["distinct_id", "time", "$insert_id"];
const MP_EVENTS = {
  plugin_opened: {},
  ai_connected: { client: (v) => ["claude-code", "codex", "cursor", "claude", "other"].includes(v) },
  tool_called: {
    tool: (v) => TOOLS.has(v),
    ok: (v) => typeof v === "boolean",
    error_code: (v) => typeof v === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(v),
    duration_ms: (v) => Number.isInteger(v) && v >= 0 && v <= 3_600_000,
  },
  app_launched: { app_version: VERSION_OK },
};

function invalidEvent(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return "not an object";
  const extra = Object.keys(e).filter((k) => k !== "event" && k !== "properties");
  if (extra.length) return `unknown key ${extra[0]}`;
  const own = Object.prototype.hasOwnProperty.call(MP_EVENTS, e.event) ? MP_EVENTS[e.event] : null;
  if (!own) return "unknown event";
  const props = e.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return "no properties";
  for (const [key, value] of Object.entries(props)) {
    const check = Object.prototype.hasOwnProperty.call(own, key) ? own[key] : Object.prototype.hasOwnProperty.call(MP_COMMON, key) ? MP_COMMON[key] : null;
    if (!check) return `unknown property ${key}`;
    if (!check(value)) return `bad ${key}`;
  }
  for (const key of MP_REQUIRED) if (!(key in props)) return `missing ${key}`;
  if (e.event === "tool_called" && !("tool" in props && "ok" in props)) return "missing tool";
  return null;
}

async function mixpanelTrack(request, env) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  const text = await request.text().catch(() => "");
  if (text.length > MP_MAX_BODY) return json({ error: "too_large" }, 413);
  let batch;
  try { batch = JSON.parse(text); } catch { return json({ error: "invalid_json" }, 400); }
  if (!Array.isArray(batch) || batch.length === 0 || batch.length > MP_MAX_EVENTS) return json({ error: "invalid_batch" }, 400);
  for (let i = 0; i < batch.length; i++) {
    const reason = invalidEvent(batch[i]);
    if (reason) return json({ error: "invalid_event", index: i, reason }, 400);
  }
  const country = request.cf?.country;
  const countryCode = typeof country === "string" && /^[A-Z]{2}$/.test(country) && country !== "XX" && country !== "T1" ? country : undefined;
  const events = batch.map((e) => ({
    event: e.event,
    properties: {
      ...e.properties,
      product: "figmamcp",
      token: env.MIXPANEL_TOKEN || MIXPANEL_TOKEN,
      is_internal: INTERNAL_IDS.has(e.properties.distinct_id),
      ...(countryCode ? { mp_country_code: countryCode } : {}),
    },
  }));
  try {
    const res = await sendToMixpanel(events);
    const body = await res.text();
    return new Response(body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return json({ error: "upstream_unavailable" }, 502);
  }
}

function sendToMixpanel(events) {
  return fetch(MIXPANEL_TRACK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(events),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// Every pixel row written to Analytics Engine is also sent to Mixpanel as one event, so Mixpanel
// holds the same signals for every plugin and app version. The AE write and the pixel response
// never wait for Mixpanel, and a Mixpanel failure is ignored. $insert_id is derived from the AE
// row, so a backfill of the same row is removed as a duplicate. The country is the value AE
// stores ("XX" when Cloudflare has none). No IP is sent (ip=0).
function mirror(ctx, env, event, distinctId, country, blobs, extra) {
  const time = Math.floor(Date.now() / 1000);
  const job = (async () => {
    const insertId = (await sha256(`${event}|${distinctId}|${time}|${blobs.join("|")}`)).slice(0, 32);
    await sendToMixpanel([{
      event,
      properties: {
        ...extra,
        distinct_id: distinctId,
        time,
        $insert_id: insertId,
        product: "figmamcp",
        source: "pixel",
        is_internal: INTERNAL_IDS.has(distinctId),
        mp_country_code: country,
        token: env.MIXPANEL_TOKEN || MIXPANEL_TOKEN,
      },
    }]);
  })().catch(() => {});
  ctx?.waitUntil?.(job);
}

// The static asset layer drops a trailing slash with a 307 (temporary). Search engines
// treat the slash-less URL as canonical only after a permanent redirect, so pass it on as a 301.
// wrangler.jsonc routes "/*/" here; every other page is served by the asset layer directly.
async function permanentAssetRedirect(request, env) {
  const res = await env.ASSETS.fetch(request);
  if (res.status !== 307 && res.status !== 308) return res;
  const location = res.headers.get("location");
  if (!location) return res;
  return new Response(null, { status: 301, headers: { location, "cache-control": "public, max-age=3600", "strict-transport-security": "max-age=15552000" } });
}

// The static asset layer answers a Range request with 200 and the whole file, and Safari/iOS
// will not play a <video> unless byte ranges come back as 206. wrangler.jsonc routes
// "/assets/*.mp4" here; this slices the asset layer's full response.
async function rangedAsset(request, env) {
  const res = await env.ASSETS.fetch(request);
  if (request.method !== "GET" || res.status !== 200) return res;
  const headers = new Headers(res.headers);
  headers.set("accept-ranges", "bytes");
  const range = request.headers.get("range");
  if (!range) return new Response(res.body, { status: 200, headers });
  const body = new Uint8Array(await res.arrayBuffer());
  const size = body.byteLength;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = m && m[1] !== "" ? Number(m[1]) : NaN;
  let end = m && m[2] !== "" ? Number(m[2]) : size - 1;
  if (m && m[1] === "" && m[2] !== "") { start = Math.max(size - Number(m[2]), 0); end = size - 1; }
  end = Math.min(end, size - 1);
  if (!m || Number.isNaN(start) || start > end || start >= size) {
    headers.set("content-range", `bytes */${size}`);
    headers.delete("content-length");
    return new Response(null, { status: 416, headers });
  }
  headers.set("content-range", `bytes ${start}-${end}/${size}`);
  headers.set("content-length", String(end - start + 1));
  return new Response(body.slice(start, end + 1), { status: 206, headers });
}

// Counts /download hits: country, bot or human, referring host. No IP, no full user agent.
// Link checkers (our own CI runs lychee against /download) and HTTP libraries are bots, not people.
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python|headless|lychee|linkchecker|go-http-client|node-fetch|undici|axios|okhttp|httpclient|java\/|libwww|scrapy|uptime|monitor/i;
function countDownload(request, env, ctx) {
  try {
    const ua = request.headers.get("user-agent") || "";
    const bot = !ua || BOT_RE.test(ua) ? "bot" : "human";
    let referrerHost = "";
    try { referrerHost = new URL(request.headers.get("referer") || "").hostname; } catch { /* no or bad Referer */ }
    const country = request.cf?.country || "XX";
    const blobs = ["download", country, bot, referrerHost];
    env.LOADS?.writeDataPoint({ blobs, doubles: [1], indexes: ["download"] });
    mirror(ctx, env, "download", `dl-${crypto.randomUUID()}`, country, blobs, { is_bot: bot === "bot", referrer_host: referrerHost });
  } catch {
    // Counting must never delay or break the redirect.
  }
}

// Site page-view fields (owner decision 2026-11-26): page path, referring host and utm_source.
// No query string, no full referrer, no cookie, no ID. The worker adds them to the ping image
// when it serves a page (the image has referrerpolicy=no-referrer, so it cannot send them itself).
const SELF_HOST = /(^|\.)figmamcp\.dev$/;
const cleanPath = (raw) => (String(raw || "").startsWith("/") ? String(raw).split(/[?#]/)[0].slice(0, 100) : "");
const cleanUtm = (raw) => String(raw || "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40);
function cleanHost(raw) {
  let host = "";
  const text = String(raw || "").trim();
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).hostname.toLowerCase(); } catch { return ""; }
  return /^[a-z0-9.-]{1,100}$/.test(host) && !SELF_HOST.test(host) ? host : "";
}

// Adds ?p=&r=&u= to the ping image of an HTML page. Other responses pass through untouched.
async function servePage(request, env, url) {
  // Conditional headers are dropped so a 304 never lets the browser reuse an old, already rewritten page.
  const headers = new Headers(request.headers);
  headers.delete("if-none-match");
  headers.delete("if-modified-since");
  const res = await env.ASSETS.fetch(new Request(request.url, { method: request.method, headers }));
  if (!/^text\/html/i.test(res.headers.get("content-type") || "")) return res;
  const params = new URLSearchParams();
  params.set("p", cleanPath(url.pathname));
  const ref = cleanHost(request.headers.get("referer"));
  if (ref) params.set("r", ref);
  const utm = cleanUtm(url.searchParams.get("utm_source"));
  if (utm) params.set("u", utm);
  const out = new Response(res.body, res);
  out.headers.delete("etag");
  return new HTMLRewriter().on("img.px", {
    element(el) {
      const src = el.getAttribute("src") || "";
      if (src.startsWith("/p.gif")) el.setAttribute("src", `${src}${src.includes("?") ? "&" : "?"}${params}`);
    },
  }).transform(out);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) return permanentAssetRedirect(request, env);
    if (url.pathname.startsWith("/assets/") && url.pathname.endsWith(".mp4")) return rangedAsset(request, env);
    if (url.pathname === "/download") {
      countDownload(request, env, ctx);
      return new Response(null, { status: 302, headers: { location: await resolveDownload(), "cache-control": "no-store" } });
    }
    if (url.pathname === "/latest.json") return latestVersion(request, ctx);
    if (url.pathname === "/subscribe") return subscribe(request, env);
    if (url.pathname === "/mp/track") return mixpanelTrack(request, env);
    if (url.pathname === "/u.gif") return usagePixel(url, request, env, ctx);
    if (url.pathname === "/c.gif") return connectedPixel(url, request, env, ctx);
    if (url.pathname !== "/p.gif") return request.method === "GET" ? servePage(request, env, url) : env.ASSETS.fetch(request);
    const version = (url.searchParams.get("v") || "site").slice(0, 32);
    const rawId = url.searchParams.get("i") || "";
    const installId = /^[0-9a-f]{16}$/.test(rawId) ? rawId : "";
    // Coarse per-locale visit counts for the locale homepages: which locale homepage a
    // site visit came from, as one of a fixed set of codes, not a path or raw query data.
    // Site visits carry no install ID, so this does not join against plugin installs —
    // it only gives a per-locale homepage visit count to compare against other signals.
    // "" means any other page. Keep this set in sync with the <html lang> values in site/*/index.html.
    const LOCALES = new Set(["en", "zh", "zh-hant", "ja", "pl", "fr", "de", "ko", "uk"]);
    const rawLocale = url.searchParams.get("l") || "";
    const locale = LOCALES.has(rawLocale) ? rawLocale : "";
    const country = request.cf?.country || "XX";
    const blobs = [version, country, installId, locale];
    // Site visits (and only those) also keep page path, referring host and utm_source in blobs 5-7.
    // Mixpanel still gets the first four, as the privacy page says.
    const stored = version === "site"
      ? [...blobs, cleanPath(url.searchParams.get("p")), cleanHost(url.searchParams.get("r")), cleanUtm(url.searchParams.get("u"))]
      : blobs;
    env.LOADS?.writeDataPoint({ blobs: stored, doubles: [1], indexes: [version] });
    // Only these labels are mirrored to Mixpanel; test labels such as "deploy-check" stay in AE only.
    const id = installId || `noid-${country}`;
    if (version === "site") mirror(ctx, env, "site_visited", `site-${crypto.randomUUID()}`, country, blobs, { lang: locale });
    else if (/^\d+\.\d+\.\d+$/.test(version)) mirror(ctx, env, "px_plugin_loaded", id, country, blobs, { plugin_version: version });
    else if (/^app-\d+\.\d+\.\d+$/.test(version)) mirror(ctx, env, "px_app_launched", id, country, blobs, { app_version: version.slice(4) });
    return new Response(GIF, { headers: { "content-type": "image/gif", "cache-control": "no-store" } });
  },
};
