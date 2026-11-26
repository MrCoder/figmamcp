import { afterAll, describe, expect, it } from "bun:test";

// This file swaps in a fake global WebSocket; put the real one back so later test files can open real sockets.
const RealWebSocket = (globalThis as any).WebSocket;
afterAll(() => { (globalThis as any).WebSocket = RealWebSocket; });
import { SERVER_VERSION } from "../../../shared/version.js";

// Local patch (simple model): the client runs the auto-binder before a
// command's first frame while unbound, and sends nothing when it fails. Fake
// socket only: this proves the client's ordering, not the relay.

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

    close() {
        this.readyState = 3;
        this.emit("close", {});
    }

    emit(type: string, event: any) {
        for (const callback of this.listeners[type] ?? []) callback(event);
    }

    emitFrame(frame: unknown) {
        this.emit("message", { data: JSON.stringify(frame) });
    }

    frames() {
        return this.sent.map((item) => JSON.parse(item));
    }

    lastFrame() {
        return this.frames().at(-1);
    }

    acknowledge(frame: any, result: unknown) {
        this.emitFrame({
            type: "system",
            channel: frame.channel,
            message: { id: frame.id, result },
        });
    }
}

function newestSocket() {
    const socket = FakeWebSocket.instances.at(-1);
    expect(socket).toBeDefined();
    return socket!;
}

async function importFreshClient(key: string) {
    (globalThis as any).WebSocket = FakeWebSocket;
    return import(`../../figma-client.js?simple-autobind-${key}`);
}

async function establishBinding(client: any, channel = "phase9", pluginVersion = SERVER_VERSION) {
    client.connectToFigma(9999);
    const socket = newestSocket();
    const joinPromise = client.joinChannel(channel);
    const joinFrame = socket.lastFrame();
    socket.acknowledge(joinFrame, {
        serverVersion: SERVER_VERSION,
        pluginVersion,
    });
    const result = await joinPromise;
    return { socket, result, joinFrame };
}


const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("figma-client auto-bind", () => {
    it("runs the binder before the first frame of an unbound command", async () => {
        const client = await importFreshClient("before-frame");
        client.connectToFigma(9999);
        const socket = newestSocket();
        const order: string[] = [];
        client.setAutoBinder(async () => {
            order.push(`binder sent=${socket.sent.length}`);
            const join = client.joinChannel("auto");
            socket.acknowledge(socket.lastFrame(), { serverVersion: SERVER_VERSION, pluginVersion: SERVER_VERSION });
            await join;
        });
        const command = client.sendCommandToFigma("page_info", {});
        await flush();
        expect(order).toEqual(["binder sent=0"]);
        const frame = socket.lastFrame();
        expect(frame.message.command).toBe("page_info");
        expect(frame.channel).toBe("auto");
        socket.emitFrame({ type: "broadcast", channel: "auto", message: { id: frame.message.id, result: { ok: 1 } } });
        expect(await command).toEqual({ ok: 1 });
        client.setAutoBinder(null);
    });

    it("sends no frame when the binder fails, and rejects with its code", async () => {
        const client = await importFreshClient("binder-fails");
        client.connectToFigma(9999);
        const socket = newestSocket();
        client.setAutoBinder(async () => {
            throw new client.FigmaError({ code: "CHANNEL_NOT_BOUND", message: "several open" });
        });
        let thrown: any;
        try { await client.sendCommandToFigma("node_delete", { nodes: [] }); } catch (error) { thrown = error; }
        expect(thrown?.code).toBe("CHANNEL_NOT_BOUND");
        expect(socket.sent.length).toBe(0);
        client.setAutoBinder(null);
    });

    it("shares one bind between concurrent commands", async () => {
        const client = await importFreshClient("shared-bind");
        client.connectToFigma(9999);
        const socket = newestSocket();
        let calls = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        client.setAutoBinder(async () => { calls++; await gate; throw new client.FigmaError({ code: "CHANNEL_NOT_BOUND", message: "x" }); });
        const a = client.sendCommandToFigma("page_info", {}).catch((e: any) => e.code);
        const b = client.sendCommandToFigma("node_info", {}).catch((e: any) => e.code);
        release();
        expect(await a).toBe("CHANNEL_NOT_BOUND");
        expect(await b).toBe("CHANNEL_NOT_BOUND");
        expect(calls).toBe(1);
        expect(socket.sent.length).toBe(0);
        client.setAutoBinder(null);
    });

    it("does not call the binder while bound", async () => {
        const client = await importFreshClient("bound");
        client.connectToFigma(9999);
        const socket = newestSocket();
        const join = client.joinChannel("held");
        socket.acknowledge(socket.lastFrame(), { serverVersion: SERVER_VERSION, pluginVersion: SERVER_VERSION });
        await join;
        let calls = 0;
        client.setAutoBinder(async () => { calls++; });
        client.sendCommandToFigma("page_info", {}).catch(() => {});
        await flush();
        expect(calls).toBe(0);
        expect(socket.lastFrame().message.command).toBe("page_info");
        client.setAutoBinder(null);
    });

    it("after the plugin drops, the in-flight command fails once and the next one rejoins the same channel", async () => {
        const client = await importFreshClient("reload");
        const { socket } = await establishBinding(client, "K");
        const binderChannels: string[] = [];
        client.setAutoBinder(async () => {
            binderChannels.push("K");
            const join = client.joinChannel("K");
            const leave = socket.lastFrame();
            expect(leave.type).toBe("leave");
            socket.acknowledge(leave, { left: true, channel: "K" });
            await flush();
            socket.acknowledge(socket.lastFrame(), { serverVersion: SERVER_VERSION, pluginVersion: SERVER_VERSION });
            await join;
        });

        const inFlight = client.sendCommandToFigma("node_rename", { nodeId: "1:2" });
        const inFlightFrame = socket.lastFrame();
        socket.emitFrame({ type: "peer_disconnected", channel: "K", code: "PLUGIN_DISCONNECTED", message: "The bound plugin left." });
        let inFlightError: any;
        try { await inFlight; } catch (error) { inFlightError = error; }
        expect(inFlightError?.code).toBe("PLUGIN_DISCONNECTED");
        expect(binderChannels).toEqual([]);

        const next = client.sendCommandToFigma("page_info", {});
        await flush();
        await flush();
        expect(binderChannels).toEqual(["K"]);
        const frame = socket.lastFrame();
        expect(frame.channel).toBe("K");
        expect(frame.message.command).toBe("page_info");
        // The dropped command was not sent again.
        const renames = socket.frames().filter((f: any) => f.message?.command === "node_rename");
        expect(renames).toHaveLength(1);
        expect(renames[0].id).toBe(inFlightFrame.id);
        socket.emitFrame({ type: "broadcast", channel: "K", message: { id: frame.message.id, result: { pages: [] } } });
        expect(await next).toEqual({ pages: [] });
        client.setAutoBinder(null);
    });

    it("listChannels returns the relay's channel_list", async () => {
        const client = await importFreshClient("list");
        client.connectToFigma(9999);
        const socket = newestSocket();
        const listed = client.listChannels(1000);
        await flush();
        const frame = socket.lastFrame();
        expect(frame.type).toBe("list_channels");
        socket.emitFrame({ type: "channel_list", id: frame.id, channels: [{ channel: "K", fileName: "F", pluginVersion: SERVER_VERSION, mcpCount: 0, maxMcpPeers: 8 }] });
        expect((await listed).map((c: any) => c.channel)).toEqual(["K"]);
    });
});
