import { afterAll, describe, expect, it } from "bun:test";

// This file swaps in a fake global WebSocket; put the real one back so later test files can open real sockets.
const RealWebSocket = (globalThis as any).WebSocket;
afterAll(() => { (globalThis as any).WebSocket = RealWebSocket; });

class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    readyState = 1;
    sent: string[] = [];
    private listeners: Record<string, Array<(event: any) => void>> = {};

    constructor(public url: string) {
        FakeWebSocket.instances.push(this);
    }

    addEventListener(type: string, callback: (event: any) => void) {
        (this.listeners[type] ??= []).push(callback);
    }

    send(data: string) {
        this.sent.push(data);
    }

    emit(type: string, event: any) {
        for (const callback of this.listeners[type] ?? []) callback(event);
    }

    frames() {
        return this.sent.map((item) => JSON.parse(item));
    }
}

function newestSocket() {
    const socket = FakeWebSocket.instances.at(-1);
    expect(socket).toBeDefined();
    return socket!;
}

async function importFreshClient(key: string) {
    (globalThis as any).WebSocket = FakeWebSocket;
    return import(`../../figma-client.js?identity-${key}`);
}


const CLAUDE = { app: "Claude Code", label: "自运营 Figma MCP 产品" };

describe("figma-client: sends the session identity for the plugin panel", () => {
    it("puts the identity on hello and on the join frame", async () => {
        const client = await importFreshClient("frames");
        client.setClientIdentitySource(() => ({ ...CLAUDE, source: "session-title" }));
        client.connectToFigma(9999);
        const socket = newestSocket();
        socket.emit("open", {});
        expect(socket.frames()[0]).toEqual({ type: "hello", clientType: "mcp", client: CLAUDE });

        client.joinChannel("FileKey").catch(() => {});
        await new Promise((r) => setTimeout(r, 0));
        const join = socket.frames().find((f: any) => f.type === "join");
        expect(join.client).toEqual(CLAUDE);
    });

    it("sends client_info only when the identity changes", async () => {
        const client = await importFreshClient("refresh");
        let label = "Untitled";
        client.setClientIdentitySource(() => ({ app: "Claude Code", label }));
        client.connectToFigma(9999);
        const socket = newestSocket();
        socket.emit("open", {});
        client.refreshClientIdentity();
        expect(socket.frames().filter((f: any) => f.type === "client_info")).toEqual([]);
        label = "Renamed";
        client.refreshClientIdentity();
        client.refreshClientIdentity();
        expect(socket.frames().filter((f: any) => f.type === "client_info")).toEqual([
            { type: "client_info", client: { app: "Claude Code", label: "Renamed" } },
        ]);
    });

    it("sends no identity when no source is set, and survives a throwing source", async () => {
        const client = await importFreshClient("none");
        client.setClientIdentitySource(() => { throw new Error("boom"); });
        client.connectToFigma(9999);
        const socket = newestSocket();
        socket.emit("open", {});
        expect(socket.frames()[0]).toEqual({ type: "hello", clientType: "mcp" });
    });
});
