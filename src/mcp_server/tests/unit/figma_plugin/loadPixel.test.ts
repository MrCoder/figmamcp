import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";

const ui = readFileSync("figma_plugin/ui.html", "utf8");
const manifest = JSON.parse(readFileSync("figma_plugin/manifest.json", "utf8"));

describe("plugin load pixel", () => {
    it("requests the pixel with the plugin version and the anonymous install ID only", () => {
        expect(ui).toContain("https://figmamcp.dev/p.gif?v=${encodeURIComponent(");
        const line = ui.split("\n").find((l) => l.includes("/p.gif?v="))!;
        expect(line).not.toMatch(/fileKey|documentName|channel|fileName/i);
    });

    it("is allowed by the manifest, keeping the relay dev-only entries", () => {
        expect(manifest.networkAccess.allowedDomains).toEqual(["https://figmamcp.dev", "https://www.google-analytics.com"]);
        expect(manifest.networkAccess.devAllowedDomains).toContain("ws://localhost:3155");
    });

    // Owner decision 2026-11-11: Google Analytics also counts plugin loads.
    it("also reports one plugin_load event to Google Analytics with the plugin version only", () => {
        const line = ui.split("\n").find((l) => l.includes("google-analytics.com/g/collect"))!;
        expect(line).toContain("tid=G-EV24W7HFMP");
        expect(line).toContain("en=plugin_load");
        expect(line).toContain("ep.plugin_version=${encodeURIComponent(");
        expect(line).not.toMatch(/fileKey|documentName|channel|fileName/i);
    });

    // Owner decision 2026-11-17 replaced "never store a visitor ID": one random install ID,
    // kept in figma.clientStorage, is the GA client ID. Without it, GA gets a random per-load ID.
    it("uses the install ID as the GA client ID, else a random one, and never browser storage", () => {
        const start = ui.indexOf("function sendLoadPixel");
        const body = ui.slice(start, ui.indexOf("function generateChannelName"));
        expect(body).toContain("const cid = id ||");
        expect(body).toContain("Math.random()");
        expect(body).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
    });
});
