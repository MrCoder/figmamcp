import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { INSTALL_ID_PATTERN, loadInstallId } from "../../../../../figma_plugin/utils/installId";

// Owner decision 2026-11-17: count distinct installs with one random ID per Figma install,
// kept in figma.clientStorage. It carries nothing about the person, file or account.
function memoryStorage(initial: Record<string, unknown> = {}) {
    const data = { ...initial };
    return {
        data,
        getAsync: async (k: string) => data[k],
        setAsync: async (k: string, v: unknown) => { data[k] = v; },
    };
}

describe("anonymous install ID", () => {
    it("creates a 16-hex-digit ID once and stores it", async () => {
        const s = memoryStorage();
        const id = await loadInstallId(s);
        expect(id).toMatch(INSTALL_ID_PATTERN);
        expect(s.data.installId).toBe(id);
    });

    it("returns the same ID on the next load", async () => {
        const s = memoryStorage();
        const first = await loadInstallId(s);
        expect(await loadInstallId(s)).toBe(first);
    });

    it("replaces a stored value that is not a valid ID", async () => {
        const s = memoryStorage({ installId: "someone@example.com" });
        const id = await loadInstallId(s);
        expect(id).toMatch(INSTALL_ID_PATTERN);
        expect(id).not.toBe("someone@example.com");
    });

    it("returns null when storage fails, so the load is still counted without an ID", async () => {
        const broken = { getAsync: async () => { throw new Error("no storage"); }, setAsync: async () => {} };
        expect(await loadInstallId(broken)).toBeNull();
    });
});

describe("install ID on the wire", () => {
    const ui = readFileSync("figma_plugin/ui.html", "utf8");
    const worker = readFileSync("site-worker/index.js", "utf8");

    it("the pixel carries the install ID as i=", () => {
        const line = ui.split("\n").find((l) => l.includes("/p.gif?v="))!;
        expect(line).toContain("&i=");
    });

    it("the worker stores only an ID that matches the pattern", () => {
        expect(worker).toContain("/^[0-9a-f]{16}$/");
        // blob order is version, country, installId, then an optional locale code
        // (owner decision 2026-11-19, site-worker/index.js) — installId no longer
        // has to be the last element, just present in the right position.
        expect(worker).toMatch(/blobs(: | = )\[version, [^\]]*installId[^\]]*\]/);
    });
});
