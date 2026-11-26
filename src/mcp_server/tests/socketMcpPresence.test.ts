// Relay behaviour behind the "connected" pixel design: a plugin must learn an
// MCP client exists even when that client never joins any channel (autoBind
// only joins on the first real tool call). WirePeer is copied from
// socketMultiPeer.test.ts, same as socketSimpleModel.test.ts does.
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

describe("socket relay: MCP presence (before any channel join)", () => {
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

  const isPresentNotice = (m: any) => m.type === "system" && m.message === "An MCP client is connected";

  it("tells a plugin already open that a client said hello, with no channel and no tool call", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey123");
    const mcp = await openPeer();
    mcp.send({ type: "hello", clientType: "mcp" });
    const notice = await plugin.next(isPresentNotice);
    expect(notice).toBeDefined();
  });

  it("tells a plugin that opens after the hello, catching up the client-first order", async () => {
    const mcp = await openPeer();
    mcp.send({ type: "hello", clientType: "mcp" });
    const plugin = await openPeer();
    const ack = await joinPlugin(plugin, "FileKey123");
    expect(ack.type).toBe("system");
    const notice = await plugin.next(isPresentNotice);
    expect(notice).toBeDefined();
  });

  it("never sends the notice when no client has said hello", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey123");
    await plugin.expectNo(isPresentNotice);
  });

  it("does not treat list_channels as hello", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey123");
    const mcp = await openPeer();
    mcp.send({ type: "list_channels", id: "l1" });
    await mcp.next((m) => m.type === "channel_list" && m.id === "l1");
    await plugin.expectNo(isPresentNotice);
  });
});
