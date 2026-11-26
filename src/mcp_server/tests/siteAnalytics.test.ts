import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const site = join(import.meta.dir, "../../../site");
const appJs = readFileSync(join(site, "app.js"), "utf8");
const headers = readFileSync(join(site, "_headers"), "utf8");
const privacy = readFileSync(join(site, "privacy/index.html"), "utf8");
const ID = "G-EV24W7HFMP";

function htmlPages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return htmlPages(p);
    return name.endsWith(".html") && !name.startsWith("google") ? [p] : [];
  });
}

describe("site analytics (owner decision 2026-11-11: Google Analytics on the site)", () => {
  it("loads Google Analytics 4 with the FigmaMCP measurement ID from the script every page already includes", () => {
    expect(appJs).toContain(ID);
    expect(appJs).toContain("https://www.googletagmanager.com/gtag/js?id=");
    for (const page of htmlPages(site)) {
      expect(readFileSync(page, "utf8"), page).toContain('<script src="/app.js" defer></script>');
    }
  });

  it("keeps cookies and ad features off where consent is required, and ad features off everywhere", () => {
    const consentDefaults = [...appJs.matchAll(/gtag\(\s*'consent'\s*,\s*'default'\s*,\s*(\{[\s\S]*?\})\s*\)/g)].map((m) => m[1]);
    expect(consentDefaults.length).toBe(2);
    const everywhere = consentDefaults.find((d) => !d.includes("region"))!;
    for (const k of ["ad_storage", "ad_user_data", "ad_personalization"]) expect(everywhere).toMatch(new RegExp(`${k}\\s*:\\s*'denied'`));
    const regional = consentDefaults.find((d) => d.includes("region"))!;
    expect(regional).toMatch(/analytics_storage\s*:\s*'denied'/);
    for (const c of ["FR", "DE", "PL", "NL", "NO", "GB", "CH"]) expect(regional).toContain(`'${c}'`);
    expect(appJs).toContain("allow_google_signals: false");
    expect(appJs).toContain("allow_ad_personalization_signals: false");
  });

  it("counts clicks on the Mac download link as a download_click event, only when tracking is allowed", () => {
    expect(appJs).toContain("'download_click'");
    expect(appJs).toContain('a[href="/download"]');
    // The listener must sit after the Do Not Track guard, so DNT / GPC visitors send nothing.
    expect(appJs.indexOf("globalPrivacyControl")).toBeLessThan(appJs.indexOf("'download_click'"));
    // No file name, version or page content in the event: only the page path.
    const call = appJs.match(/gtag\(\s*'event'\s*,\s*'download_click'\s*,\s*(\{[\s\S]*?\})\s*\)/)![1];
    expect(call).toContain("page_path");
  });

  it("does nothing when the browser asks not to be tracked", () => {
    expect(appJs).toContain("doNotTrack");
    expect(appJs).toContain("globalPrivacyControl");
  });

  it("lets the browser run and talk to Google Analytics and nothing else", () => {
    const csp = headers.match(/Content-Security-Policy: ([^\n]+)/)![1];
    expect(csp).toContain("script-src 'self' https://www.googletagmanager.com");
    expect(csp).toContain("connect-src");
    expect(csp).toContain("https://*.google-analytics.com");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("the privacy page says what Google Analytics does instead of promising no trackers", () => {
    const text = privacy.replace(/<[^>]*>/g, " ");
    expect(text).toContain("Google Analytics");
    expect(text).not.toMatch(/no third-party scripts or trackers/i);
    expect(text).not.toMatch(/This site sets none/i);
    expect(text).toMatch(/Do Not Track/i);
  });
});
