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
    return import(`../../figma-client.js?hello-${key}`);
}

// The MCP server is started and connects to the relay well before any AI
// session asks for a Figma tool (autoBind is lazy, triggered only by the
// first real command). Without an eager announcement, a plugin opened while
// the server sits idle has no way to learn a client is even there — see
// the "connected" pixel design.
describe("figma-client: announces itself to the relay on connect", () => {
    it("sends a hello frame identifying as an mcp client as soon as the socket opens, before any join", async () => {
        const client = await importFreshClient("announce");
        client.connectToFigma(9999);
        const socket = newestSocket();
        // connectToFigma's own 'open' listener fires synchronously in the fake.
        socket.emit("open", {});
        expect(socket.frames()).toEqual([{ type: "hello", clientType: "mcp" }]);
    });
});

describe("figma-client: FIGMAMCP_TELEMETRY=0", () => {
    it("tells the relay in its hello, because the relay started at login cannot see this process's environment", async () => {
        const before = process.env.FIGMAMCP_TELEMETRY;
        process.env.FIGMAMCP_TELEMETRY = "0";
        try {
            const client = await importFreshClient("telemetry-off");
            client.connectToFigma(9999);
            const socket = newestSocket();
            socket.emit("open", {});
            expect(socket.frames()).toEqual([{ type: "hello", clientType: "mcp", telemetry: false }]);
        } finally {
            if (before === undefined) delete process.env.FIGMAMCP_TELEMETRY;
            else process.env.FIGMAMCP_TELEMETRY = before;
        }
    });
});
