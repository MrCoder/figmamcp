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

describe("socket relay: opt-in multi-MCP channels", () => {
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
    const welcome = await peer.next(
      (m) => m.type === "system" && typeof m.peerId === "string",
    );
    peer.peerId = welcome.peerId;
    return peer;
  }

  async function joinPlugin(
    peer: WirePeer,
    channel: string,
    maxMcpPeers?: unknown,
  ): Promise<any> {
    const id = `plugin-${channel}`;
    peer.send({
      id,
      type: "join",
      channel,
      clientType: "plugin",
      pluginVersion: SERVER_VERSION,
      ...(maxMcpPeers === undefined ? {} : { maxMcpPeers }),
    });
    return peer.next((m) => m.type === "system" && m.message?.id === id);
  }

  async function joinMcp(peer: WirePeer, channel: string): Promise<any> {
    const id = `mcp-${peer.peerId}`;
    peer.send({
      id,
      type: "join",
      channel,
      clientType: "mcp",
      serverVersion: SERVER_VERSION,
    });
    return peer.next(
      (m) =>
        (m.type === "system" && m.message?.id === id) ||
        (m.type === "join_error" && m.id === id),
    );
  }

  function command(peer: WirePeer, channel: string, id: string) {
    peer.send({
      id,
      type: "message",
      channel,
      message: { id, command: "page_info", params: { commandId: id } },
    });
  }

  function reply(plugin: WirePeer, channel: string, id: string, extra = {}) {
    plugin.send({
      id,
      type: "message",
      channel,
      message: { id, result: { ok: id }, ...extra },
    });
  }

  const isNotice = (text: string) => (m: any) =>
    m.type === "system" && m.message === text;

  async function trio(max: unknown, channel = "ch") {
    const plugin = await openPeer();
    const a = await openPeer();
    const b = await openPeer();
    await joinPlugin(plugin, channel, max);
    return { plugin, a, b };
  }

  it("default (no maxMcpPeers): a second MCP gets CHANNEL_IN_USE", async () => {
    const { plugin, a, b } = await trio(undefined);
    expect((await joinMcp(a, "ch")).type).toBe("system");
    const refused = await joinMcp(b, "ch");
    expect(refused.type).toBe("join_error");
    expect(refused.code).toBe("CHANNEL_IN_USE");
    expect(plugin.peerId).toBe("peer-1");
  });

  it("ignores invalid maxMcpPeers values (stays single-MCP)", async () => {
    const { a, b } = await trio("2");
    await joinMcp(a, "ch");
    expect((await joinMcp(b, "ch")).code).toBe("CHANNEL_IN_USE");
  });

  it("maxMcpPeers 2: tags forwarded commands with mcpPeerId and routes each reply only to its sender", async () => {
    const { plugin, a, b } = await trio(2);
    expect((await joinMcp(a, "ch")).type).toBe("system");
    expect((await joinMcp(b, "ch")).type).toBe("system");

    command(a, "ch", "cmd-a");
    command(b, "ch", "cmd-b");
    const fa = await plugin.next((m) => m.message?.id === "cmd-a");
    const fb = await plugin.next((m) => m.message?.id === "cmd-b");
    expect(fa.mcpPeerId).toBe(a.peerId);
    expect(fb.mcpPeerId).toBe(b.peerId);

    reply(plugin, "ch", "cmd-b");
    reply(plugin, "ch", "cmd-a");
    const ra = await a.next((m) => m.message?.id === "cmd-a");
    const rb = await b.next((m) => m.message?.id === "cmd-b");
    expect(ra.message.result).toEqual({ ok: "cmd-a" });
    expect(rb.message.result).toEqual({ ok: "cmd-b" });
    await a.expectNo((m) => m.message?.id === "cmd-b");
    await b.expectNo((m) => m.message?.id === "cmd-a");
  });

  it("maxMcpPeers 2: a third MCP gets CHANNEL_IN_USE", async () => {
    const { a, b } = await trio(2);
    const c = await openPeer();
    await joinMcp(a, "ch");
    await joinMcp(b, "ch");
    const refused = await joinMcp(c, "ch");
    expect(refused.type).toBe("join_error");
    expect(refused.code).toBe("CHANNEL_IN_USE");
  });

  it("clamps maxMcpPeers to 4", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "ch", 99);
    const mcps: WirePeer[] = [];
    for (let i = 0; i < 5; i++) mcps.push(await openPeer());
    for (let i = 0; i < 4; i++) {
      expect((await joinMcp(mcps[i], "ch")).type).toBe("system");
    }
    expect((await joinMcp(mcps[4], "ch")).code).toBe("CHANNEL_IN_USE");
  });

  it("a duplicate request id from another MCP is refused without evicting the in-flight route", async () => {
    const { plugin, a, b } = await trio(2);
    await joinMcp(a, "ch");
    await joinMcp(b, "ch");

    command(a, "ch", "dup");
    await plugin.next((m) => m.message?.id === "dup");
    command(b, "ch", "dup");

    const refusal = await b.next((m) => m.message?.id === "dup");
    expect(refusal.type).toBe("broadcast");
    expect(refusal.message.error).toBe(
      "Duplicate request id in channel: another session has a request in flight with this id.",
    );
    await plugin.expectNo((m) => m.message?.id === "dup");

    reply(plugin, "ch", "dup");
    const ra = await a.next((m) => m.message?.id === "dup");
    expect(ra.message.result).toEqual({ ok: "dup" });
    await b.expectNo((m) => m.message?.result !== undefined);
  });

  it("the same MCP may reuse its own request id (old route replaced)", async () => {
    const { plugin, a } = await trio(2);
    await joinMcp(a, "ch");
    command(a, "ch", "again");
    await plugin.next((m) => m.message?.id === "again");
    command(a, "ch", "again");
    await plugin.next((m) => m.message?.id === "again");
    await a.expectNo((m) => m.message?.error !== undefined);
  });

  it("routes progress_update to the owning MCP only", async () => {
    const { plugin, a, b } = await trio(2);
    await joinMcp(a, "ch");
    await joinMcp(b, "ch");
    command(a, "ch", "slow-a");
    command(b, "ch", "slow-b");
    await plugin.next((m) => m.message?.id === "slow-a");
    await plugin.next((m) => m.message?.id === "slow-b");

    plugin.send({
      id: "slow-b",
      type: "progress_update",
      channel: "ch",
      message: { id: "slow-b", type: "progress_update", data: { pct: 5 } },
    });
    const progress = await b.next((m) => m.type === "progress_update");
    expect(progress.id).toBe("slow-b");
    await a.expectNo((m) => m.type === "progress_update");
  });

  it("when A leaves, the plugin gets a left notice with A's peerId and B's in-flight request still completes", async () => {
    const { plugin, a, b } = await trio(2);
    await joinMcp(a, "ch");
    await joinMcp(b, "ch");
    command(a, "ch", "cmd-a");
    command(b, "ch", "cmd-b");
    await plugin.next((m) => m.message?.id === "cmd-a");
    await plugin.next((m) => m.message?.id === "cmd-b");

    await a.close();
    const left = await plugin.next(isNotice("A user has left the channel"));
    expect(left.peerId).toBe(a.peerId);

    // A's route is gone: a late reply for it reaches nobody.
    reply(plugin, "ch", "cmd-a");
    reply(plugin, "ch", "cmd-b");
    const rb = await b.next((m) => m.message?.id === "cmd-b");
    expect(rb.message.result).toEqual({ ok: "cmd-b" });
    await b.expectNo((m) => m.message?.id === "cmd-a");
  });

  it("plugin disconnect sends peer_disconnected to every MCP", async () => {
    const { plugin, a, b } = await trio(2);
    await joinMcp(a, "ch");
    await joinMcp(b, "ch");
    await plugin.close();
    const da = await a.next((m) => m.type === "peer_disconnected");
    const db = await b.next((m) => m.type === "peer_disconnected");
    expect(da.code).toBe("PLUGIN_DISCONNECTED");
    expect(db.code).toBe("PLUGIN_DISCONNECTED");
  });

  it("join notices to the plugin carry the joining MCP's peerId", async () => {
    const { plugin, a, b } = await trio(2);
    await joinMcp(a, "ch");
    const ja = await plugin.next(isNotice("A new user has joined the channel"));
    expect(ja.peerId).toBe(a.peerId);
    await joinMcp(b, "ch");
    const jb = await plugin.next(isNotice("A new user has joined the channel"));
    expect(jb.peerId).toBe(b.peerId);
  });
});
