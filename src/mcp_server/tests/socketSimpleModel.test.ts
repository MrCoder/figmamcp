// Local patch (simple model): relay behaviour the "open the plugin, then
// agents edit the file" model relies on — a stable channel name (the file key)
// across plugin reloads, and a read-only list_channels frame. WirePeer is
// copied from socketMultiPeer.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import {
  createFigmaSocketServer,
  type FigmaSocketServer,
} from "../../socket.js";
import { SERVER_VERSION } from "../../shared/version.js";

type Predicate = (message: any) => boolean;

interface MessageWaiter {
  predicate: Predicate;
  resolve: (message: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class WirePeer {
  readonly messages: any[] = [];
  readonly waiters: MessageWaiter[] = [];
  peerId = "";

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const waiterIndex = this.waiters.findIndex((waiter) =>
        waiter.predicate(message),
      );
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  send(message: unknown) {
    this.socket.send(JSON.stringify(message));
  }

  next(predicate: Predicate, timeoutMs = 1_000): Promise<any> {
    const queuedIndex = this.messages.findIndex(predicate);
    if (queuedIndex >= 0) {
      const [message] = this.messages.splice(queuedIndex, 1);
      return Promise.resolve(message);
    }

    return new Promise((resolve, reject) => {
      const waiter: MessageWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for socket frame after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async expectNo(predicate: Predicate, timeoutMs = 100): Promise<void> {
    try {
      const message = await this.next(predicate, timeoutMs);
      throw new Error(`Unexpected socket frame: ${JSON.stringify(message)}`);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Timed out waiting for socket frame")
      ) {
        return;
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (
      this.socket.readyState === WebSocket.CLOSED ||
      this.socket.readyState === WebSocket.CLOSING
    ) {
      return;
    }
    await new Promise<void>((resolve) => {
      const fallback = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, 500);
      this.socket.once("close", () => {
        clearTimeout(fallback);
        resolve();
      });
      this.socket.close();
    });
  }
}
describe("socket relay: simple model", () => {
  let server: FigmaSocketServer;
  let socketUrl: string;
  let peers: WirePeer[];
  let peerSequence: number;

  beforeEach(async () => {
    peers = [];
    peerSequence = 0;
    server = createFigmaSocketServer({
      logger: { log() {}, error() {} },
      peerIdFactory: () => `peer-${++peerSequence}`,
    });
    await new Promise<void>((resolve, reject) => {
      server.httpServer.once("error", reject);
      server.httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.httpServer.address() as AddressInfo;
    socketUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await Promise.all(peers.map((peer) => peer.close()));
    await server.close();
  });

  async function openPeer(): Promise<WirePeer> {
    const socket = new WebSocket(socketUrl);
    const peer = new WirePeer(socket);
    peers.push(peer);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const welcome = await peer.next((m) => m.type === "system" && typeof m.peerId === "string");
    peer.peerId = welcome.peerId;
    return peer;
  }

  async function joinPlugin(peer: WirePeer, channel: string, extra: Record<string, unknown> = {}) {
    const id = `plugin-${peer.peerId}`;
    peer.send({ id, type: "join", channel, clientType: "plugin", pluginVersion: SERVER_VERSION, ...extra });
    return peer.next((m) => (m.type === "system" && m.message?.id === id) || (m.type === "join_error" && m.id === id));
  }

  async function joinMcp(peer: WirePeer, channel: string) {
    const id = `mcp-${peer.peerId}`;
    peer.send({ id, type: "join", channel, clientType: "mcp", serverVersion: SERVER_VERSION });
    return peer.next((m) => (m.type === "system" && m.message?.id === id) || (m.type === "join_error" && m.id === id));
  }

  async function list(peer: WirePeer) {
    peer.send({ type: "list_channels", id: "l1" });
    return (await peer.next((m) => m.type === "channel_list" && m.id === "l1")).channels;
  }

  const isAck = (frame: any) => frame.type === "system" && typeof frame.message?.result === "object";

  it("accepts a plugin rejoining the same file-key channel after the old plugin socket closed", async () => {
    const first = await openPeer();
    expect(isAck(await joinPlugin(first, "FileKey123"))).toBe(true);
    await first.close();
    const second = await openPeer();
    expect(isAck(await joinPlugin(second, "FileKey123"))).toBe(true);
  });

  it("refuses a second open plugin on the same file-key channel with PLUGIN_PEER_AMBIGUOUS", async () => {
    const first = await openPeer();
    await joinPlugin(first, "FileKey123");
    const second = await openPeer();
    const refused = await joinPlugin(second, "FileKey123");
    expect(refused.type).toBe("join_error");
    expect(refused.code).toBe("PLUGIN_PEER_AMBIGUOUS");
  });

  it("lists connected plugins with file name and session count, and the lister can still join", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey123", { fileName: "Conf File", maxMcpPeers: 4 });
    const mcp = await openPeer();
    expect(await list(mcp)).toEqual([
      { channel: "FileKey123", fileName: "Conf File", pluginVersion: SERVER_VERSION, mcpCount: 0, maxMcpPeers: 4, completedCalls: 0 },
    ]);
    expect(isAck(await joinMcp(mcp, "FileKey123"))).toBe(true);
    const other = await openPeer();
    expect((await list(other))[0].mcpCount).toBe(1);
  });

  it("counts finished AI requests per file in list_channels; a refused request does not count", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey123", { fileName: "Conf File" });
    const mcp = await openPeer();
    await joinMcp(mcp, "FileKey123");
    expect((await list(mcp))[0].completedCalls).toBe(0);
    const ask = (id: string) => mcp.send({ id, type: "message", channel: "FileKey123", message: { id, command: "page_info", params: { commandId: id } } });
    const answer = (id: string, body: Record<string, unknown>) => plugin.send({ id, type: "message", channel: "FileKey123", message: { id, ...body } });
    ask("c1");
    await plugin.next((m) => m.message?.id === "c1");
    // The plugin's refusal frame carries both `error` and an empty `result`.
    answer("c1", { error: "Node not found", result: {} });
    await mcp.next((m) => m.message?.id === "c1");
    expect((await list(mcp))[0].completedCalls).toBe(0);
    ask("c2");
    await plugin.next((m) => m.message?.id === "c2");
    answer("c2", { result: { ok: true } });
    await mcp.next((m) => m.message?.id === "c2");
    expect((await list(mcp))[0].completedCalls).toBe(1);
    // The client's own connect handshake is not an AI request.
    mcp.send({ id: "c3", type: "message", channel: "FileKey123", message: { id: "c3", command: "get_connect_payload", params: {} } });
    await plugin.next((m) => m.message?.id === "c3");
    answer("c3", { result: { ok: true } });
    await mcp.next((m) => m.message?.id === "c3");
    expect((await list(mcp))[0].completedCalls).toBe(1);
  });

  it("lists nothing when no plugin is connected, and drops a plugin once it disconnects", async () => {
    const mcp = await openPeer();
    expect(await list(mcp)).toEqual([]);
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey123");
    expect((await list(mcp)).length).toBe(1);
    await plugin.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await list(mcp)).toEqual([]);
  });

  it("a plugin_status frame from the open plugin renames its file in the list", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey123", { fileName: "Old name" });
    plugin.send({ type: "plugin_status", fileName: "New name" });
    const mcp = await openPeer();
    await new Promise((r) => setTimeout(r, 30));
    expect((await list(mcp))[0].fileName).toBe("New name");
  });

  it("lists the file used most recently first: the last to join, until another file reports activity", async () => {
    const a = await openPeer();
    await joinPlugin(a, "KeyA", { fileName: "A" });
    const b = await openPeer();
    await joinPlugin(b, "KeyB", { fileName: "B" });
    const mcp = await openPeer();
    expect((await list(mcp)).map((c: any) => c.fileName)).toEqual(["B", "A"]);
    a.send({ type: "plugin_status", active: true });
    await new Promise((r) => setTimeout(r, 30));
    expect((await list(mcp)).map((c: any) => c.fileName)).toEqual(["A", "B"]);
  });

  it("ignores plugin_status from a peer that is not the channel's plugin", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey123", { fileName: "Real" });
    const mcp = await openPeer();
    await joinMcp(mcp, "FileKey123");
    mcp.send({ type: "plugin_status", fileName: "Hijacked", active: true });
    const other = await openPeer();
    await new Promise((r) => setTimeout(r, 30));
    expect((await list(other))[0].fileName).toBe("Real");
  });
});

