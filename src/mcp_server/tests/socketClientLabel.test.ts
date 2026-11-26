// The relay carries each MCP peer's client identity (app + session label) to
// the plugin panel, and to nothing else. WirePeer is copied from
// socketMcpPresence.test.ts, same as the other socket tests do.
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

describe("socket relay: client identity for the plugin panel", () => {
  let server: FigmaSocketServer;
  let socketUrl: string;
  let peers: WirePeer[];
  let peerSequence: number;
  let clock: number;

  beforeEach(async () => {
    peers = [];
    peerSequence = 0;
    clock = 1_000;
    server = createFigmaSocketServer({
      logger: { log() {}, error() {} },
      peerIdFactory: () => `peer-${++peerSequence}`,
      now: () => clock,
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

  async function joinPlugin(peer: WirePeer, channel: string) {
    const id = `plugin-${peer.peerId}`;
    peer.send({ id, type: "join", channel, clientType: "plugin", pluginVersion: SERVER_VERSION, maxMcpPeers: 4 });
    return peer.next((m) => m.type === "system" && m.message?.id === id);
  }

  async function joinMcp(peer: WirePeer, channel: string, extra: Record<string, unknown> = {}) {
    const id = `mcp-${peer.peerId}-${Math.random()}`;
    peer.send({ id, type: "join", channel, clientType: "mcp", serverVersion: SERVER_VERSION, ...extra });
    return peer.next((m) => (m.type === "system" && m.message?.id === id) || (m.type === "join_error" && m.id === id));
  }

  const joinedNotice = (peerId: string) => (m: any) =>
    m.type === "system" && m.message === "A new user has joined the channel" && m.peerId === peerId;

  it("carries each joining client's app, label and join time to the plugin, one per peer", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey");
    const a = await openPeer();
    const b = await openPeer();
    await joinMcp(a, "FileKey", { client: { app: "Claude Code", label: "自运营 Figma MCP 产品" } });
    clock = 2_000;
    await joinMcp(b, "FileKey", { client: { app: "Codex", label: "web-sequence" } });

    const noticeA = await plugin.next(joinedNotice(a.peerId));
    const noticeB = await plugin.next(joinedNotice(b.peerId));
    expect(noticeA.client).toEqual({ app: "Claude Code", label: "自运营 Figma MCP 产品" });
    expect(noticeA.connectedAt).toBe(1_000);
    expect(noticeB.client).toEqual({ app: "Codex", label: "web-sequence" });
    expect(noticeB.connectedAt).toBe(2_000);
  });

  it("uses the identity from hello when the join frame has none", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey");
    const mcp = await openPeer();
    mcp.send({ type: "hello", clientType: "mcp", client: { app: "Claude Code", label: "From hello" } });
    await joinMcp(mcp, "FileKey");
    const notice = await plugin.next(joinedNotice(mcp.peerId));
    expect(notice.client).toEqual({ app: "Claude Code", label: "From hello" });
  });

  it("omits client when the peer sent none, so an old server still gets a row", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey");
    const mcp = await openPeer();
    await joinMcp(mcp, "FileKey");
    const notice = await plugin.next(joinedNotice(mcp.peerId));
    expect(notice.client).toBeUndefined();
    expect(notice.peerId).toBe(mcp.peerId);
  });

  it("sanitizes the label on ingest: any local process can connect", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey");
    const mcp = await openPeer();
    await joinMcp(mcp, "FileKey", { client: { app: "X\u0007", label: "evil‮txt" + "y".repeat(300) } });
    const notice = await plugin.next(joinedNotice(mcp.peerId));
    expect(notice.client.app).toBe("X");
    expect(notice.client.label.startsWith("evil txt")).toBe(true);
    expect([...notice.client.label].length).toBe(80);
  });

  it("forwards a client_info rename only to the bound channel's plugin", async () => {
    const pluginA = await openPeer();
    await joinPlugin(pluginA, "FileA");
    const pluginB = await openPeer();
    await joinPlugin(pluginB, "FileB");
    const mcp = await openPeer();
    await joinMcp(mcp, "FileA", { client: { app: "Claude Code", label: "Untitled" } });
    await pluginA.next(joinedNotice(mcp.peerId));

    mcp.send({ type: "client_info", client: { app: "Claude Code", label: "Renamed" } });
    const update = await pluginA.next((m) => m.type === "system" && m.message === "Client updated");
    expect(update).toMatchObject({ peerId: mcp.peerId, channel: "FileA", client: { app: "Claude Code", label: "Renamed" } });
    await pluginB.expectNo((m) => m.message === "Client updated");
  });

  it("ignores client_info from a plugin peer and from an unbound MCP peer", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey");
    plugin.send({ type: "client_info", client: { app: "Fake", label: "Fake" } });
    const loose = await openPeer();
    loose.send({ type: "hello", clientType: "mcp" });
    loose.send({ type: "client_info", client: { app: "Loose", label: "Loose" } });
    await plugin.expectNo((m) => m.message === "Client updated");
  });

  it("never lists client identity in list_channels, which answers any local client", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey");
    const mcp = await openPeer();
    await joinMcp(mcp, "FileKey", { client: { app: "Claude Code", label: "Secret title" } });
    const other = await openPeer();
    other.send({ type: "list_channels", id: "l1" });
    const list = await other.next((m) => m.type === "channel_list");
    expect(JSON.stringify(list)).not.toContain("Secret title");
  });
});
