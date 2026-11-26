import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { askAppToOpenPlugin } from "../../../appClient.js";
import { resolveGuidesDir } from "../../../guidesDir.js";

function socketPath() {
    return path.join(mkdtempSync(path.join(tmpdir(), "fm-")), "a.sock");
}

describe("askAppToOpenPlugin", () => {
    it("sends one JSON line and returns the app's reply", async () => {
        const at = socketPath();
        let received = "";
        const server = Bun.listen({
            unix: at,
            socket: {
                data(socket, data) {
                    received += data.toString();
                    socket.end(JSON.stringify({ ok: true, outcome: "opened", message: "" }) + "\n");
                },
            },
        });
        const reply = await askAppToOpenPlugin(at);
        server.stop(true);
        expect(received).toBe('{"cmd":"open-plugin"}\n');
        expect(reply).toEqual({ ok: true, outcome: "opened", message: "" });
    });

    it("returns null when the app is not running", async () => {
        expect(await askAppToOpenPlugin(socketPath())).toBeNull();
    });

    it("returns null when the app never answers", async () => {
        const at = socketPath();
        const server = Bun.listen({ unix: at, socket: { data() {} } });
        const reply = await askAppToOpenPlugin(at, 20);
        server.stop(true);
        expect(reply).toBeNull();
    });
});

describe("resolveGuidesDir", () => {
    const moduleUrl = "file:///repo/dist/server.js";

    it("uses the folder next to the bundle under npm", () => {
        const dir = resolveGuidesDir(moduleUrl, "/usr/bin/node", (u) => u.pathname === "/repo/skills/figmamcp/references/");
        expect(dir.pathname).toBe("/repo/skills/figmamcp/references/");
    });

    it("uses the folder next to a compiled program", () => {
        const dir = resolveGuidesDir("file:///$bunfs/root/server", "/home/.figmamcp/current/figmamcp-server",
            (u) => u.pathname === "/home/.figmamcp/current/skills/figmamcp/references/");
        expect(dir.pathname).toBe("/home/.figmamcp/current/skills/figmamcp/references/");
    });

    it("uses the parent folder when the program lives in bin/ of the installed version", () => {
        const dir = resolveGuidesDir("file:///$bunfs/root/server", "/home/.figmamcp/current/bin/figmamcp-server",
            (u) => u.pathname === "/home/.figmamcp/current/skills/figmamcp/references/");
        expect(dir.pathname).toBe("/home/.figmamcp/current/skills/figmamcp/references/");
    });
});
