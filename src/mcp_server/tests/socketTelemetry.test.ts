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

const ID = "0000000000000001";
const SESSION = "abc123def456";

describe("socket relay: telemetry events", () => {
  let server: FigmaSocketServer;
  let socketUrl: string;
  let peers: WirePeer[];
  let peerSequence: number;
  let tracked: Array<{ event: string; properties: Record<string, unknown>; distinctId: string }>;

  beforeEach(async () => {
    peers = [];
    peerSequence = 0;
    tracked = [];
    server = createFigmaSocketServer({
      logger: { log() {}, error() {} },
      peerIdFactory: () => `peer-${++peerSequence}`,
      telemetry: { track: (event, properties, distinctId) => tracked.push({ event, properties, distinctId }) },
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
    peer.send({ id, type: "join", channel, clientType: "plugin", pluginVersion: SERVER_VERSION, fileName: "Secret Client File", ...extra });
    return peer.next((m) => (m.type === "system" && m.message?.id === id) || (m.type === "join_error" && m.id === id));
  }

  async function joinMcp(peer: WirePeer, channel: string, extra: Record<string, unknown> = {}) {
    const id = `mcp-${peer.peerId}`;
    peer.send({ id, type: "join", channel, clientType: "mcp", serverVersion: SERVER_VERSION, ...extra });
    return peer.next((m) => (m.type === "system" && m.message?.id === id) || (m.type === "join_error" && m.id === id));
  }

  /** One tool call through the relay; the plugin answers with `answer`. */
  async function call(mcp: WirePeer, plugin: WirePeer, channel: string, id: string, command: string, answer: Record<string, unknown>) {
    mcp.send({ id, type: "message", channel, message: { id, command, params: { nodeName: "Secret Layer" } } });
    await plugin.next((m) => m.type === "broadcast" && m.message?.id === id);
    plugin.send({ id, type: "message", channel, message: { id, ...answer } });
    await mcp.next((m) => m.type === "broadcast" && m.message?.id === id);
  }

  const events = (name: string) => tracked.filter((t) => t.event === name);

  it("emits plugin_opened with the plugin version and the install ID from the join", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey1", { installId: ID, pluginSession: SESSION });
    expect(events("plugin_opened")).toEqual([{ event: "plugin_opened", properties: { plugin_version: SERVER_VERSION }, distinctId: ID }]);
  });

  it("emits tool_called with tool, ok, error code and duration only", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey1", { installId: ID, pluginSession: SESSION });
    const mcp = await openPeer();
    await joinMcp(mcp, "FileKey1", { client: { app: "Claude Code", label: "my-private-folder" } });
    await call(mcp, plugin, "FileKey1", "r1", "node_info", { result: { name: "Secret Layer" } });
    await call(mcp, plugin, "FileKey1", "r2", "node_delete", { error: { code: "READ_ONLY_MODE", message: "'Secret Layer' is read-only" }, result: {} });
    await call(mcp, plugin, "FileKey1", "r3", "node_rename", { result: { errorCode: "NAME_MISMATCH", detail: "Secret Layer" } });
    await call(mcp, plugin, "FileKey1", "r4", "node_clone", { error: "Node 'Secret Layer' not found", result: {} });
    const calls = events("tool_called");
    expect(calls.map((c) => c.properties)).toEqual([
      { tool: "node_info", ok: true, error_code: undefined, duration_ms: expect.any(Number), plugin_version: SERVER_VERSION },
      { tool: "node_delete", ok: false, error_code: "READ_ONLY_MODE", duration_ms: expect.any(Number), plugin_version: SERVER_VERSION },
      { tool: "node_rename", ok: false, error_code: "NAME_MISMATCH", duration_ms: expect.any(Number), plugin_version: SERVER_VERSION },
      { tool: "node_clone", ok: false, error_code: "UNKNOWN", duration_ms: expect.any(Number), plugin_version: SERVER_VERSION },
    ]);
    expect(calls.every((c) => c.distinctId === ID)).toBe(true);
    expect(JSON.stringify(tracked)).not.toContain("Secret");
    expect(JSON.stringify(tracked)).not.toContain("my-private-folder");
  });

  it("emits ai_connected once per plugin window, with a fixed client name", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey1", { installId: ID, pluginSession: SESSION });
    const mcp = await openPeer();
    await joinMcp(mcp, "FileKey1", { client: { app: "Codex", label: "Secret session title" } });
    const mcp2 = await openPeer();
    await joinMcp(mcp2, "FileKey1", { client: { app: "Claude Code" } });
    expect(events("ai_connected").map((e) => e.properties)).toEqual([{ client: "codex", plugin_version: SERVER_VERSION }]);
  });

  it("holds events until the install ID arrives in plugin_status, then sends them with it", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey1", { pluginSession: SESSION });
    const mcp = await openPeer();
    await joinMcp(mcp, "FileKey1");
    await call(mcp, plugin, "FileKey1", "r1", "page_info", { result: {} });
    expect(tracked).toHaveLength(0);
    plugin.send({ type: "plugin_status", installId: ID });
    await mcp.send({ type: "list_channels", id: "sync" });
    await mcp.next((m) => m.type === "channel_list");
    expect(tracked.map((t) => [t.event, t.distinctId])).toEqual([["plugin_opened", ID], ["ai_connected", ID], ["tool_called", ID]]);
  });

  it("sends nothing for a plugin that never gives a valid install ID", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey1", { installId: "someone@example.com" });
    const mcp = await openPeer();
    await joinMcp(mcp, "FileKey1");
    await call(mcp, plugin, "FileKey1", "r1", "page_info", { result: {} });
    expect(tracked).toHaveLength(0);
  });

  it("a server started with FIGMAMCP_TELEMETRY=0 adds no ai_connected or tool_called", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey1", { installId: ID, pluginSession: SESSION });
    const mcp = await openPeer();
    await joinMcp(mcp, "FileKey1", { telemetry: false });
    await call(mcp, plugin, "FileKey1", "r1", "node_info", { result: {} });
    expect(tracked.map((t) => t.event)).toEqual(["plugin_opened"]);
  });

  it("a reconnect of the same plugin window is not a second plugin_opened", async () => {
    const first = await openPeer();
    await joinPlugin(first, "FileKey1", { installId: ID, pluginSession: SESSION });
    await first.close();
    const second = await openPeer();
    await joinPlugin(second, "FileKey1", { installId: ID, pluginSession: SESSION });
    expect(events("plugin_opened")).toHaveLength(1);
  });

  it("does not count transport commands or unknown commands as tool calls", async () => {
    const plugin = await openPeer();
    await joinPlugin(plugin, "FileKey1", { installId: ID, pluginSession: SESSION });
    const mcp = await openPeer();
    await joinMcp(mcp, "FileKey1");
    await call(mcp, plugin, "FileKey1", "r1", "get_connect_payload", { result: {} });
    await call(mcp, plugin, "FileKey1", "r2", "secret_command", { result: {} });
    expect(events("tool_called")).toHaveLength(0);
  });
});
