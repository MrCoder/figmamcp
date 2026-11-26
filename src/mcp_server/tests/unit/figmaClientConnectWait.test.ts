import { afterAll, describe, expect, it } from "bun:test";
import { SERVER_VERSION } from "../../../shared/version.js";
import { toolResult } from "../../tools/_result.js";

// Bug (tester, 0.1.11, Intel Mac, direct stdio client): in a fresh server
// process, channel_join right after initialize returned UNKNOWN_ERROR "Not
// connected to Figma." because the relay socket was still CONNECTING. page_info
// worked because its auto-bind path waits for the socket. Fake socket only:
// this proves the client's ordering against a socket that opens late, not the
// relay itself.

const RealWebSocket = (globalThis as any).WebSocket;
afterAll(() => { (globalThis as any).WebSocket = RealWebSocket; });

class LateOpeningSocket {
    static instances: LateOpeningSocket[] = [];
    static openAfterMs: number | null = 30;
    readyState = 0; // CONNECTING, as in a freshly started process
    sent: string[] = [];
    private listeners: Record<string, Array<(event: any) => void>> = {};

    constructor(public url: string) {
        LateOpeningSocket.instances.push(this);
        const delay = LateOpeningSocket.openAfterMs;
        if (delay !== null) {
            setTimeout(() => { this.readyState = 1; this.emit("open", {}); }, delay);
        }
    }
    addEventListener(type: string, cb: (event: any) => void) { (this.listeners[type] ??= []).push(cb); }
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; this.emit("close", {}); }
    emit(type: string, event: any) { for (const cb of this.listeners[type] ?? []) cb(event); }
}

async function importFreshClient(key: string) {
    (globalThis as any).WebSocket = LateOpeningSocket;
    return import(`../../figma-client.js?connect-wait-${key}`);
}

const waitFor = async (predicate: () => boolean, ms = 2000) => {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > ms) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 5));
    }
};

describe("joinChannel on a socket that is still connecting", () => {
    it("waits for the socket to open, then sends the join", async () => {
        LateOpeningSocket.openAfterMs = 30;
        const client = await importFreshClient("opens-late");
        client.connectToFigma(9999);
        const socket = LateOpeningSocket.instances.at(-1)!;
        expect(socket.readyState).toBe(0);

        const join = client.joinChannel("filekey");
        // The socket also announces itself with a "hello" frame as soon as it
        // opens (the "connected" pixel's presence signal), ahead of the join.
        await waitFor(() => socket.sent.some((raw) => JSON.parse(raw).type === "join"));
        const frame = JSON.parse(socket.sent.find((raw) => JSON.parse(raw).type === "join")!);
        expect(frame.type).toBe("join");
        socket.emit("message", {
            data: JSON.stringify({
                type: "system",
                channel: frame.channel,
                message: { id: frame.id, result: { serverVersion: SERVER_VERSION, pluginVersion: SERVER_VERSION } },
            }),
        });
        const result = await join;
        expect(result).toBeDefined();
    });

    it("fails with CONNECTION_NOT_READY when the socket never opens in time", async () => {
        LateOpeningSocket.openAfterMs = null;
        const client = await importFreshClient("never-opens");
        client.setConnectWaitMs(100);
        client.connectToFigma(9999);
        let thrown: any;
        try { await client.joinChannel("filekey"); } catch (error) { thrown = error; }
        expect(thrown?.code).toBe("CONNECTION_NOT_READY");
        expect(String(thrown?.message)).toContain("page_info");
    });
});

describe("toolResult marks error envelopes", () => {
    it("sets isError on status:error results", () => {
        const r: any = toolResult({ status: "error", errorCode: "X", errorMessage: "m" });
        expect(r.isError).toBe(true);
    });
    it("leaves success results without isError", () => {
        const r: any = toolResult({ status: "success" });
        expect(r.isError).toBeUndefined();
    });
});
