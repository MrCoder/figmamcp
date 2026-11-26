import { createServer, type Server as HttpServer } from "http";
import { randomUUID } from "crypto";
import { realpathSync } from "fs";
import { resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { parseCliArgs } from "./cli.js";
import {
  acknowledgedResultFrame,
  CHANNEL_REFUSALS,
  channelVersionsCompatible,
  isKnownChannelVersion,
  joinErrorFrame,
  normalizeChannelVersion,
  normalizeClientIdentity,
  type ClientIdentity,
  type ChannelClientType,
  type RelayFrame,
} from "./shared/channelProtocol.js";
import {
  cleanVersion,
  clientSlug,
  createTelemetry,
  detectOs,
  errorCodeOf,
  INSTALL_ID_RE,
  TELEMETRY_TOOLS,
  type TelemetrySink,
} from "./telemetry.js";
import { SERVER_VERSION } from "./shared/version.js";

/**
 * A dispatched route is reclaimed once it has been idle this long (Change 5,
 * P9-F4). The bound is on INACTIVITY, not age: a long command that keeps
 * emitting progress refreshes its route, so pruning can never evict work that
 * is still running. It exists so a command that never receives a terminal
 * frame — a client-side timeout, or a plugin that stops answering — cannot
 * leak its route for the life of the binding.
 */
const MAX_MCP_PEERS_LIMIT = 4;

/** Plugin opt-in for several MCP peers; missing or invalid means 1. */
const normalizeMaxMcpPeers = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_MCP_PEERS_LIMIT, Math.max(1, Math.floor(value)))
    : 1;

const ROUTE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface SocketLogger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

interface ConnectedPeer {
  socket: WebSocket;
  peerId: string;
  clientType: ChannelClientType | null;
  channel: string | null;
  pluginVersion?: string;
  serverVersion?: string;
  /** Local patch (simple model): the plugin's file name, for list_channels. */
  fileName?: string;
  /** MCP peers: client app and session label, shown in the plugin panel only. Never in list_channels. */
  client?: ClientIdentity;
  /** MCP peers: when this peer joined its current channel (epoch ms). */
  connectedAt?: number;
  /** Plugin peers: the plugin's random install ID, used as the telemetry distinct_id. */
  installId?: string;
  /** Plugin peers: a random ID per plugin window, so a reconnect is not a second plugin_opened. */
  pluginSession?: string;
  /** MCP peers: the server process was started with FIGMAMCP_TELEMETRY=0. */
  telemetryOff?: boolean;
}

/** Commands the MCP client sends for its own connection, not on behalf of the AI. */
const TRANSPORT_COMMANDS = new Set(["join", "get_connect_payload"]);

interface PendingRoute {
  requestId: string;
  /** The tool command; transport commands are not counted as AI requests. */
  command: string;
  pluginPeerId: string;
  mcpPeerId: string;
  /** Refreshed by progress forwarding; drives idle reclamation (P9-F4). */
  lastActivityAt: number;
  /** When the command was dispatched; tool_called duration_ms. */
  startedAt: number;
  /** Per-route idle timer; cleared on progress, terminal delivery, or detach. */
  expiryTimer?: unknown;
}

interface ChannelState {
  name: string;
  plugin: ConnectedPeer | null;
  mcps: Map<string, ConnectedPeer>;
  /** Opt-in by the plugin join frame; 1 keeps the single-MCP default. */
  maxMcpPeers: number;
  pending: Map<string, PendingRoute>;
  /** Order of the plugin's last join or reported activity; list_channels shows the highest first. */
  lastActive: number;
  /** AI requests the plugin answered without an error, since the relay started. Shown by list_channels. */
  completedCalls: number;
  /** Telemetry events waiting for the plugin's install ID. Dropped if the plugin leaves without one. */
  telemetryBuffer: Array<{ event: string; properties: Record<string, unknown> }>;
}

export interface FigmaSocketServerOptions {
  logger?: SocketLogger;
  peerIdFactory?: () => string;
  /** Injectable clock so route-reclamation tests need no wall-clock wait. */
  now?: () => number;
  /** Override the idle bound; tests use a short one. */
  routeIdleTimeoutMs?: number;
  /** Injectable timer paired with `now` for deterministic expiry tests. */
  routeTimer?: {
    set(callback: () => void, delayMs: number): unknown;
    clear(handle: unknown): void;
  };
  /** Usage events (plugin_opened, ai_connected, tool_called). Off unless given; only the CLI entry passes one. */
  telemetry?: TelemetrySink;
}

export interface FigmaSocketServer {
  httpServer: HttpServer;
  webSocketServer: WebSocketServer;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object";
}

/**
 * Construct the socket server without listening. Keeping construction separate
 * from the CLI entry point lets protocol tests bind an ephemeral port and drive
 * the real WebSocket transport deterministically.
 */
export function createFigmaSocketServer(
  options: FigmaSocketServerOptions = {},
): FigmaSocketServer {
  const logger = options.logger ?? console;
  const peerIdFactory = options.peerIdFactory ?? randomUUID;
  const now = options.now ?? Date.now;
  const routeIdleTimeoutMs = options.routeIdleTimeoutMs ?? ROUTE_IDLE_TIMEOUT_MS;
  const routeTimer = options.routeTimer ?? {
    set(callback: () => void, delayMs: number): unknown {
      const handle = setTimeout(callback, delayMs);
      handle.unref?.();
      return handle;
    },
    clear(handle: unknown): void {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
  const channels = new Map<string, ChannelState>();
  const telemetry = options.telemetry;
  // Plugin windows already counted, so a socket reconnect is not a second open.
  const openedSessions = new Set<string>();
  const aiConnectedSessions = new Set<string>();
  const rememberSession = (set: Set<string>, key: string): boolean => {
    if (set.has(key)) return false;
    if (set.size >= 1000) set.clear();
    set.add(key);
    return true;
  };
  const TELEMETRY_BUFFER_MAX = 200;

  /** Sends now if the plugin's install ID is known, else holds the event until it is. */
  const emitTelemetry = (
    channel: ChannelState,
    event: string,
    properties: Record<string, unknown>,
  ) => {
    if (!telemetry || !channel.plugin) return;
    const props = { ...properties, plugin_version: cleanVersion(channel.plugin.pluginVersion) };
    const installId = channel.plugin.installId;
    if (installId) {
      try {
        telemetry.track(event, props, installId);
      } catch {
        // Telemetry must never affect a tool call.
      }
      return;
    }
    if (channel.telemetryBuffer.length < TELEMETRY_BUFFER_MAX) channel.telemetryBuffer.push({ event, properties: props });
  };

  const setPluginInstallId = (channel: ChannelState, peer: ConnectedPeer, raw: unknown) => {
    if (peer.installId || typeof raw !== "string" || !INSTALL_ID_RE.test(raw)) return;
    peer.installId = raw;
    const buffered = channel.telemetryBuffer.splice(0);
    if (!telemetry) return;
    for (const { event, properties } of buffered) {
      try {
        telemetry.track(event, properties, raw);
      } catch {
        // Ignored, as above.
      }
    }
  };
  // A counter, not a clock: two events in the same millisecond still keep their order.
  let activityCounter = 0;
  const peers = new Map<WebSocket, ConnectedPeer>();
  // MCP peers that announced themselves (`hello`) but have not yet joined any
  // channel — autoBind only joins on the first real tool call, so a server
  // can sit here, present but idle, for the whole life of its connection.
  // Cleared on disconnect; a peer that goes on to join stays harmlessly
  // listed until then (still true: it is present).
  const helloedMcpPeers = new Set<ConnectedPeer>();

  const deletePendingRoute = (
    channel: ChannelState,
    requestId: string,
    expectedRoute?: PendingRoute,
  ): boolean => {
    const route = channel.pending.get(requestId);
    if (!route || (expectedRoute && route !== expectedRoute)) return false;

    channel.pending.delete(requestId);
    if (route.expiryTimer !== undefined) {
      routeTimer.clear(route.expiryTimer);
      route.expiryTimer = undefined;
    }
    return true;
  };

  const clearPendingRoutes = (channel: ChannelState) => {
    for (const route of channel.pending.values()) {
      if (route.expiryTimer !== undefined) {
        routeTimer.clear(route.expiryTimer);
        route.expiryTimer = undefined;
      }
    }
    channel.pending.clear();
  };

  const isIdleRoute = (route: PendingRoute, currentTime = now()) =>
    currentTime - route.lastActivityAt >= routeIdleTimeoutMs;

  const armRouteExpiry = (
    channel: ChannelState,
    route: PendingRoute,
  ) => {
    if (route.expiryTimer !== undefined) {
      routeTimer.clear(route.expiryTimer);
      route.expiryTimer = undefined;
    }
    const elapsed = Math.max(0, now() - route.lastActivityAt);
    const delayMs = Math.max(0, routeIdleTimeoutMs - elapsed);
    route.expiryTimer = routeTimer.set(() => {
      // A cleared/replaced route can leave a queued timer callback behind in
      // some schedulers. Identity guards it from deleting the replacement.
      if (channel.pending.get(route.requestId) !== route) return;

      if (isIdleRoute(route)) {
        deletePendingRoute(channel, route.requestId, route);
        return;
      }

      // The injected/logical clock may advance differently from the host
      // timer. Re-arm for the remaining idle window rather than expiring early.
      armRouteExpiry(channel, route);
    }, delayMs);
  };

  /**
   * Reclaim routes whose request produced no terminal frame and no progress
   * within the idle bound (P9-F4). Per-route timers perform reclamation while
   * fully idle; dispatch pruning is a defensive backstop for delayed timers.
   */
  const pruneIdleRoutes = (channel: ChannelState) => {
    const currentTime = now();
    for (const [requestId, route] of channel.pending) {
      if (isIdleRoute(route, currentTime)) {
        deletePendingRoute(channel, requestId, route);
      }
    }
  };

  const httpServer = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("WebSocket server running");
  });

  const webSocketServer = new WebSocketServer({ noServer: true });

  const send = (peer: ConnectedPeer, frame: unknown): boolean => {
    if (peer.socket.readyState !== WebSocket.OPEN) return false;
    try {
      peer.socket.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      logger.error("Error sending socket frame:", error);
      return false;
    }
  };

  const sendProtocolError = (peer: ConnectedPeer, message: string) => {
    send(peer, { type: "error", message });
  };

  const sendJoinedNotice = (peer: ConnectedPeer, channel: string) => {
    send(peer, {
      type: "system",
      message: `Joined channel: ${channel}`,
      channel,
    });
  };

  const sendPeerJoinedNotice = (
    recipient: ConnectedPeer | null,
    channel: string,
    joined?: ConnectedPeer,
  ) => {
    if (!recipient) return;
    send(recipient, {
      type: "system",
      message: "A new user has joined the channel",
      channel,
      ...(joined === undefined ? {} : { peerId: joined.peerId }),
      ...(joined?.client === undefined ? {} : { client: joined.client }),
      ...(joined?.connectedAt === undefined ? {} : { connectedAt: joined.connectedAt }),
    });
  };

  // Distinct from sendPeerJoinedNotice: this peer has not joined any channel
  // (and may never join this one), so it is not added to the recipient's
  // per-channel peer list — it only says a client exists somewhere.
  const sendMcpPresentNotice = (recipient: ConnectedPeer | null) => {
    if (!recipient) return;
    send(recipient, { type: "system", message: "An MCP client is connected" });
  };

  const sendPeerLeftNotice = (
    recipient: ConnectedPeer | null,
    channel: string,
    peerId?: string,
  ) => {
    if (!recipient) return;
    send(recipient, {
      type: "system",
      message: "A user has left the channel",
      channel,
      ...(peerId === undefined ? {} : { peerId }),
    });
  };

  const detachMcp = (
    channel: ChannelState,
    peer: ConnectedPeer,
    notifyPlugin: boolean,
  ) => {
    if (channel.mcps.get(peer.peerId) !== peer) return;
    for (const [requestId, route] of [...channel.pending]) {
      if (route.mcpPeerId === peer.peerId) {
        deletePendingRoute(channel, requestId, route);
      }
    }
    channel.mcps.delete(peer.peerId);
    peer.channel = null;
    peer.serverVersion = undefined;
    peer.connectedAt = undefined;
    if (notifyPlugin) {
      sendPeerLeftNotice(channel.plugin, channel.name, peer.peerId);
    }
    if (!channel.plugin && channel.mcps.size === 0) {
      channels.delete(channel.name);
    }
  };

  const detachPlugin = (
    channel: ChannelState,
    peer: ConnectedPeer,
    notifyMcp: boolean,
  ) => {
    if (channel.plugin !== peer) return;

    clearPendingRoutes(channel);
    channel.plugin = null;
    peer.channel = null;
    peer.pluginVersion = undefined;
    peer.installId = undefined;
    channel.telemetryBuffer = [];

    const boundMcps = [...channel.mcps.values()];
    channel.mcps.clear();
    for (const boundMcp of boundMcps) {
      boundMcp.channel = null;
      boundMcp.serverVersion = undefined;
      boundMcp.connectedAt = undefined;

      if (notifyMcp) {
        const error = CHANNEL_REFUSALS.PLUGIN_DISCONNECTED(
          channel.name,
          peer.peerId,
        );
        send(boundMcp, {
          type: "peer_disconnected",
          channel: channel.name,
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        });
      }
    }

    channels.delete(channel.name);
  };

  const leavePeer = (peer: ConnectedPeer, notifyBoundPeer: boolean) => {
    const channelName = peer.channel;
    if (!channelName) return;
    const channel = channels.get(channelName);
    if (!channel) {
      peer.channel = null;
      return;
    }

    if (channel.plugin === peer) {
      detachPlugin(channel, peer, notifyBoundPeer);
    } else if (channel.mcps.has(peer.peerId)) {
      detachMcp(channel, peer, notifyBoundPeer);
    } else {
      peer.channel = null;
    }
  };

  const acknowledgePluginJoin = (
    peer: ConnectedPeer,
    id: unknown,
    channelName: string,
    pluginVersion: string,
  ) => {
    sendJoinedNotice(peer, channelName);
    send(
      peer,
      acknowledgedResultFrame(id, channelName, {
        pluginVersion,
      }),
    );
  };

  const acknowledgeMcpJoin = (
    peer: ConnectedPeer,
    id: unknown,
    channelName: string,
    serverVersion: string,
    pluginVersion: string,
  ) => {
    sendJoinedNotice(peer, channelName);
    send(
      peer,
      acknowledgedResultFrame(id, channelName, {
        serverVersion,
        pluginVersion,
      }),
    );
  };

  const handlePluginJoin = (
    peer: ConnectedPeer,
    data: Record<string, any>,
    channelName: string,
  ) => {
    if (peer.clientType && peer.clientType !== "plugin") {
      sendProtocolError(
        peer,
        "A socket connection cannot change clientType after joining.",
      );
      return;
    }
    peer.clientType = "plugin";

    if (peer.channel && peer.channel !== channelName) {
      sendProtocolError(
        peer,
        `Leave channel '${peer.channel}' before joining another channel.`,
      );
      return;
    }

    // Normalized on ingest so the stored value is the one both the
    // known-version test and the equality test see (P9-F6).
    const pluginVersion = normalizeChannelVersion(data.pluginVersion);
    const maxMcpPeers = normalizeMaxMcpPeers(data.maxMcpPeers);
    const existing = channels.get(channelName);

    if (existing?.plugin && existing.plugin !== peer) {
      send(
        peer,
        joinErrorFrame(
          data.id,
          CHANNEL_REFUSALS.PLUGIN_PEER_AMBIGUOUS(channelName),
        ),
      );
      return;
    }

    if (existing?.plugin === peer) {
      existing.maxMcpPeers = maxMcpPeers;
      acknowledgePluginJoin(
        peer,
        data.id,
        channelName,
        normalizeChannelVersion(existing.plugin.pluginVersion),
      );
      return;
    }

    const channel: ChannelState =
      existing ?? {
        name: channelName,
        plugin: null,
        mcps: new Map(),
        maxMcpPeers,
        pending: new Map(),
        lastActive: 0,
        completedCalls: 0,
        telemetryBuffer: [],
      };
    channel.maxMcpPeers = maxMcpPeers;
    channel.plugin = peer;
    channel.lastActive = ++activityCounter;
    channels.set(channelName, channel);
    peer.channel = channelName;
    peer.pluginVersion = pluginVersion;
    peer.fileName = typeof data.fileName === "string" ? data.fileName.slice(0, 200) : undefined;
    if (typeof data.pluginSession === "string" && /^[0-9a-z]{6,40}$/.test(data.pluginSession)) peer.pluginSession = data.pluginSession;
    channel.telemetryBuffer = [];
    if (rememberSession(openedSessions, peer.pluginSession ?? peer.peerId)) emitTelemetry(channel, "plugin_opened", {});
    setPluginInstallId(channel, peer, data.installId);

    acknowledgePluginJoin(
      peer,
      data.id,
      channelName,
      pluginVersion,
    );
    for (const mcp of channel.mcps.values()) {
      sendPeerJoinedNotice(mcp, channelName);
    }
    // Catch up a plugin that opens after a client has already said hello but
    // not yet joined anywhere (it may still pick this file).
    if (helloedMcpPeers.size > 0) sendMcpPresentNotice(peer);
  };

  const handleMcpJoin = (
    peer: ConnectedPeer,
    data: Record<string, any>,
    channelName: string,
  ) => {
    if (peer.clientType && peer.clientType !== "mcp") {
      sendProtocolError(
        peer,
        "A socket connection cannot change clientType after joining.",
      );
      return;
    }
    peer.clientType = "mcp";

    if (peer.channel && peer.channel !== channelName) {
      sendProtocolError(
        peer,
        `Leave channel '${peer.channel}' before joining another channel.`,
      );
      return;
    }

    const channel = channels.get(channelName);
    if (!channel?.plugin) {
      send(
        peer,
        joinErrorFrame(
          data.id,
          CHANNEL_REFUSALS.PLUGIN_PEER_UNAVAILABLE(channelName),
        ),
      );
      return;
    }

    if (
      !channel.mcps.has(peer.peerId) &&
      channel.mcps.size >= channel.maxMcpPeers
    ) {
      send(
        peer,
        joinErrorFrame(
          data.id,
          CHANNEL_REFUSALS.CHANNEL_IN_USE(channelName),
        ),
      );
      return;
    }

    const serverVersion = normalizeChannelVersion(data.serverVersion);
    const pluginVersion = normalizeChannelVersion(channel.plugin.pluginVersion);

    if (
      isKnownChannelVersion(serverVersion) &&
      isKnownChannelVersion(pluginVersion) &&
      !channelVersionsCompatible(serverVersion, pluginVersion)
    ) {
      send(
        peer,
        joinErrorFrame(
          data.id,
          CHANNEL_REFUSALS.VERSION_MISMATCH(
            channelName,
            serverVersion,
            pluginVersion,
          ),
        ),
      );
      return;
    }

    const client = normalizeClientIdentity(data.client);
    if (client) peer.client = client;
    if (data.telemetry === false) peer.telemetryOff = true;
    if (!channel.mcps.has(peer.peerId) || peer.connectedAt === undefined) peer.connectedAt = now();
    channel.mcps.set(peer.peerId, peer);
    peer.channel = channelName;
    peer.serverVersion = serverVersion;

    acknowledgeMcpJoin(
      peer,
      data.id,
      channelName,
      serverVersion,
      pluginVersion,
    );
    sendPeerJoinedNotice(channel.plugin, channelName, peer);
    if (!peer.telemetryOff && rememberSession(aiConnectedSessions, channel.plugin.pluginSession ?? channel.plugin.peerId)) {
      emitTelemetry(channel, "ai_connected", { client: clientSlug(peer.client?.app) });
    }
  };

  const handleJoin = (
    peer: ConnectedPeer,
    data: Record<string, any>,
  ) => {
    const channelName = data.channel;
    if (!channelName || typeof channelName !== "string") {
      sendProtocolError(peer, "Channel name is required");
      return;
    }

    if (data.clientType === "plugin") {
      handlePluginJoin(peer, data, channelName);
      return;
    }
    if (data.clientType === "mcp") {
      handleMcpJoin(peer, data, channelName);
      return;
    }

    sendProtocolError(
      peer,
      "clientType must be exactly 'plugin' or 'mcp'.",
    );
  };

  // Announces an MCP server as present, before it has picked (or even found)
  // a channel to join. Lets every currently open plugin learn a client
  // exists; a plugin that opens later is caught up in handlePluginJoin.
  const handleHello = (
    peer: ConnectedPeer,
    data: Record<string, any>,
  ) => {
    if (data.clientType !== "mcp") return;
    if (peer.clientType && peer.clientType !== "mcp") return;
    peer.clientType = "mcp";
    const client = normalizeClientIdentity(data.client);
    if (client) peer.client = client;
    if (data.telemetry === false) peer.telemetryOff = true;
    helloedMcpPeers.add(peer);
    for (const channel of channels.values()) {
      sendMcpPresentNotice(channel.plugin);
    }
  };

  const handleLeave = (
    peer: ConnectedPeer,
    data: Record<string, any>,
  ) => {
    const requestedChannel =
      typeof data.channel === "string" ? data.channel : peer.channel;
    const actualChannel = peer.channel;

    // Unbind the connection's real pair rather than trusting a caller-supplied
    // room name. An idempotent repeat still receives an acknowledgement.
    leavePeer(peer, true);

    const channelName = actualChannel ?? requestedChannel ?? "";
    send(
      peer,
      acknowledgedResultFrame(data.id, channelName, {
        left: true,
        channel: channelName,
      }),
    );
  };

  const forwardCommand = (
    channel: ChannelState,
    peer: ConnectedPeer,
    data: RelayFrame,
  ) => {
    if (channel.mcps.get(peer.peerId) !== peer || !channel.plugin) return;
    if (data.type !== "message") return;

    const requestId =
      typeof data.message.id === "string" ? data.message.id : data.id;
    if (
      typeof requestId !== "string" ||
      typeof data.message.command !== "string"
    ) {
      return;
    }
    if (
      typeof data.id === "string" &&
      typeof data.message.id === "string" &&
      data.id !== data.message.id
    ) {
      return;
    }

    pruneIdleRoutes(channel);
    const inFlight = channel.pending.get(requestId);
    if (inFlight && inFlight.mcpPeerId !== peer.peerId) {
      send(peer, {
        type: "broadcast",
        message: {
          id: requestId,
          error:
            "Duplicate request id in channel: another session has a request in flight with this id.",
        },
        sender: "peer",
        channel: channel.name,
      });
      return;
    }
    deletePendingRoute(channel, requestId);
    const route: PendingRoute = {
      requestId,
      command: data.message.command,
      pluginPeerId: channel.plugin.peerId,
      mcpPeerId: peer.peerId,
      lastActivityAt: now(),
      startedAt: now(),
      // Assigned by armRouteExpiry immediately below.
      expiryTimer: undefined,
    };
    channel.pending.set(requestId, route);
    armRouteExpiry(channel, route);

    send(channel.plugin, {
      type: "broadcast",
      message: data.message,
      sender: "peer",
      channel: channel.name,
      mcpPeerId: peer.peerId,
    });
  };

  const forwardPluginFrame = (
    channel: ChannelState,
    peer: ConnectedPeer,
    data: RelayFrame,
  ) => {
    if (channel.plugin !== peer || channel.mcps.size === 0) return;
    const requestId =
      typeof data.message.id === "string" ? data.message.id : data.id;
    if (typeof requestId !== "string") return;
    if (
      typeof data.id === "string" &&
      typeof data.message.id === "string" &&
      data.id !== data.message.id
    ) {
      return;
    }

    const route = channel.pending.get(requestId);
    if (!route || route.pluginPeerId !== peer.peerId) {
      // A response is accepted only from the exact plugin peer to which this
      // request was dispatched. Forged, stale, and cross-peer replies disappear.
      return;
    }

    // Enforce the idle boundary on arrival as well as by timer. A host timer
    // that fires late must not let a late progress/terminal frame revive or
    // consume an already expired request.
    const currentTime = now();
    if (isIdleRoute(route, currentTime)) {
      deletePendingRoute(channel, requestId, route);
      return;
    }

    const target = channel.mcps.get(route.mcpPeerId);
    if (!target) {
      // The owning MCP peer is gone; nothing to deliver to.
      deletePendingRoute(channel, requestId, route);
      return;
    }

    const isProgress =
      data.type === "progress_update" ||
      data.message.type === "progress_update";
    if (isProgress) {
      // Progress is liveness evidence: refresh the route so a long-running
      // command that keeps reporting is never reclaimed under it (P9-F4).
      route.lastActivityAt = currentTime;
      armRouteExpiry(channel, route);
      send(target, {
        id: requestId,
        type: "progress_update",
        message: data.message,
        sender: "peer",
        channel: channel.name,
      });
      return;
    }

    const isTerminal =
      Object.prototype.hasOwnProperty.call(data.message, "result") ||
      Object.prototype.hasOwnProperty.call(data.message, "error");
    if (!isTerminal) return;
    // The plugin's refusal frame carries `error` next to an empty `result`, so only an answer without an error counts.
    if (!data.message.error && !TRANSPORT_COMMANDS.has(route.command)) channel.completedCalls++;
    if (TELEMETRY_TOOLS.has(route.command) && !target.telemetryOff) {
      const { ok, code } = errorCodeOf(data.message);
      emitTelemetry(channel, "tool_called", {
        tool: route.command,
        ok,
        error_code: code,
        duration_ms: Math.max(0, Math.round(currentTime - route.startedAt)),
      });
    }

    send(target, {
      type: "broadcast",
      message: data.message,
      sender: "peer",
      channel: channel.name,
    });
    deletePendingRoute(channel, requestId, route);
  };

  const handleRelay = (
    peer: ConnectedPeer,
    data: Record<string, any>,
  ) => {
    const channelName = data.channel;
    if (
      typeof channelName !== "string" ||
      peer.channel !== channelName ||
      !isRecord(data.message)
    ) {
      return;
    }

    const channel = channels.get(channelName);
    if (!channel || !channel.plugin || channel.mcps.size === 0) return;

    if (channel.mcps.has(peer.peerId)) {
      forwardCommand(channel, peer, data as RelayFrame);
    } else if (channel.plugin === peer) {
      forwardPluginFrame(channel, peer, data as RelayFrame);
    }
  };

  httpServer.on("upgrade", (req, socket, head) => {
    webSocketServer.handleUpgrade(req, socket, head, (ws) => {
      webSocketServer.emit("connection", ws, req);
    });
  });

  webSocketServer.on("connection", (socket: WebSocket) => {
    const peer: ConnectedPeer = {
      socket,
      peerId: peerIdFactory(),
      clientType: null,
      channel: null,
    };
    peers.set(socket, peer);
    logger.log("New client connected");

    send(peer, {
      type: "system",
      message: "Please join a channel to start chatting",
      peerId: peer.peerId,
    });

    socket.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());
        if (!isRecord(data) || typeof data.type !== "string") {
          sendProtocolError(peer, "Invalid socket frame");
          return;
        }

        if (data.type === "join") {
          handleJoin(peer, data);
        } else if (data.type === "hello") {
          handleHello(peer, data);
        } else if (data.type === "leave") {
          handleLeave(peer, data);
        } else if (data.type === "plugin_status") {
          // Local patch (simple model): the open plugin reports a file rename or that its file is in use.
          // Accepted only from the channel's own plugin; anything else is ignored.
          const channel = peer.channel ? channels.get(peer.channel) : undefined;
          if (channel && channel.plugin === peer) {
            if (typeof data.fileName === "string") peer.fileName = data.fileName.slice(0, 200);
            if (data.active === true) channel.lastActive = ++activityCounter;
            setPluginInstallId(channel, peer, data.installId);
          }
        } else if (data.type === "client_info") {
          // An MCP peer renamed itself (a new session title, or an explicit
          // label). Stored for its next join; forwarded only to the plugin of
          // the channel this peer is bound to.
          if (peer.clientType !== "mcp") return;
          const client = normalizeClientIdentity(data.client);
          if (!client) return;
          peer.client = client;
          const channel = peer.channel ? channels.get(peer.channel) : undefined;
          if (channel?.plugin && channel.mcps.get(peer.peerId) === peer) {
            send(channel.plugin, {
              type: "system",
              message: "Client updated",
              channel: channel.name,
              peerId: peer.peerId,
              client,
            });
          }
        } else if (data.type === "list_channels") {
          // Local patch (simple model): lets an MCP session find the plugin
          // without a channel code. Read-only: it never sets clientType or
          // binds the peer, so the peer can still join as anything after.
          // The relay listens on localhost only.
          const list = [...channels.values()]
            .filter((channel) => channel.plugin)
            .sort((a, b) => b.lastActive - a.lastActive)
            .map((channel) => ({
              channel: channel.name,
              fileName: channel.plugin!.fileName ?? null,
              pluginVersion: normalizeChannelVersion(channel.plugin!.pluginVersion),
              mcpCount: channel.mcps.size,
              maxMcpPeers: channel.maxMcpPeers,
              completedCalls: channel.completedCalls,
            }));
          send(peer, { type: "channel_list", id: data.id, channels: list });
        } else if (
          data.type === "message" ||
          data.type === "progress_update"
        ) {
          handleRelay(peer, data);
        }
      } catch (error) {
        logger.error("Error handling message:", error);
        sendProtocolError(peer, "Invalid JSON socket frame");
      }
    });

    socket.on("close", () => {
      logger.log("Client disconnected");
      leavePeer(peer, true);
      helloedMcpPeers.delete(peer);
      peers.delete(socket);
    });
  });

  const close = async () => {
    for (const channel of channels.values()) clearPendingRoutes(channel);
    for (const client of webSocketServer.clients) client.terminate();

    const webSocketClose = new Promise<void>((resolveClose) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        resolveClose();
      };
      // `ws` in noServer mode can omit the close callback after the owning HTTP
      // server has already drained every upgraded connection. Bound the helper
      // used by tests/shutdown rather than leaving teardown wedged indefinitely.
      const fallback = setTimeout(finish, 250);
      fallback.unref?.();
      webSocketServer.close(finish);
    });

    const httpClose = httpServer.listening
      ? new Promise<void>((resolveClose, rejectClose) => {
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(fallback);
            if (error) rejectClose(error);
            else resolveClose();
          };
          // Bun/Node can keep the HTTP close callback pending for an upgraded
          // socket even after `ws.terminate()`. The WebSocket side is already
          // force-closed above; this bound keeps programmatic teardown usable.
          const fallback = setTimeout(() => finish(), 250);
          fallback.unref?.();
          httpServer.close((error) => finish(error));
        })
      : Promise.resolve();

    await Promise.all([webSocketClose, httpClose]);
  };

  return { httpServer, webSocketServer, close };
}

export function isSocketCliEntry(
  entry: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  if (!entry) return false;
  try {
    // npm/pnpm expose bins through symlinks. `import.meta.url` resolves to the
    // real module while argv[1] may retain the symlink path, so textual URL
    // equality would silently turn the executable into a no-op.
    return (
      realpathSync(resolve(entry)) === realpathSync(fileURLToPath(moduleUrl))
    );
  } catch {
    // Preserve the ordinary direct-source comparison if either path cannot be
    // canonicalized (for example, a non-file loader URL).
    return moduleUrl === pathToFileURL(resolve(entry)).href;
  }
}

if (isSocketCliEntry()) {
  const { port, host } = parseCliArgs("figmamcp-relay");
  const telemetry = createTelemetry({ serverVersion: SERVER_VERSION });
  telemetry.setOs(detectOs((os) => telemetry.setOs(os)));
  const server = createFigmaSocketServer({ telemetry });
  server.httpServer.listen(port, host, () => {
    console.log(`WebSocket server running on ${host}:${port}`);
  });
  // Free the port first, so a relay started right after this one can listen. Then save unsent
  // events (a network send started at exit may not finish), try one send, and exit.
  let exiting = false;
  const exit = () => {
    if (exiting) return;
    exiting = true;
    void server.close().catch(() => {});
    telemetry.persistSync();
    const done = () => process.exit(0);
    const fallback = setTimeout(done, 1500);
    telemetry.flush().finally(() => {
      clearTimeout(fallback);
      done();
    });
  };
  process.on("SIGTERM", exit);
  process.on("SIGINT", exit);
}
