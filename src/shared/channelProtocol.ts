/**
 * Canonical server-side channel protocol for the v2.3.3 peer-bound transport.
 *
 * The Figma plugin bundle deliberately keeps its own plugin-origin refusal
 * registry because it cannot import server modules at runtime. Socket-originated
 * refusals live here only, so `src/socket.ts` never reconstructs codes or
 * messages inline and the plugin does not ship a dead mirror.
 */

export type ChannelClientType = "plugin" | "mcp";

export interface ChannelProtocolError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface PluginJoinFrame {
  id?: string;
  type: "join";
  channel: string;
  clientType: "plugin";
  pluginVersion?: string;
}

export interface McpJoinFrame {
  id: string;
  type: "join";
  channel: string;
  clientType: "mcp";
  serverVersion?: string;
  client?: ClientIdentity;
}

/**
 * Who an MCP peer is, for the plugin panel: the client app (from MCP
 * `initialize`) and a session label. Local only: it travels over the
 * localhost relay to the plugin and is never sent to analytics.
 */
export interface ClientIdentity {
  app: string;
  label: string;
}

const CLIENT_APP_MAX = 40;
const CLIENT_LABEL_MAX = 80;
// C0/C1 controls and bidi overrides/isolates: a label must not reorder or hide the text around it.
const UNSAFE_LABEL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function cleanLabelText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(UNSAFE_LABEL_CHARS, " ").replace(/\s+/g, " ").trim();
  const chars = [...cleaned];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : cleaned;
}

/**
 * Both ends normalize: the server before sending, the relay on ingest (any
 * local process can connect to the relay). Returns undefined when there is
 * nothing usable.
 */
export function normalizeClientIdentity(value: unknown): ClientIdentity | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const app = cleanLabelText((value as Record<string, unknown>).app, CLIENT_APP_MAX);
  const label = cleanLabelText((value as Record<string, unknown>).label, CLIENT_LABEL_MAX);
  if (!app && !label) return undefined;
  return { app, label };
}

export interface LeaveFrame {
  id: string;
  type: "leave";
  channel: string;
}

export interface RelayFrame {
  id?: string;
  type: "message" | "progress_update";
  channel: string;
  message: {
    id?: string;
    command?: string;
    result?: unknown;
    error?: unknown;
    type?: string;
    [key: string]: unknown;
  };
}

export type IncomingChannelFrame =
  | PluginJoinFrame
  | McpJoinFrame
  | LeaveFrame
  | RelayFrame;

export interface ChannelJoinResult {
  serverVersion: string;
  pluginVersion: string;
}

export interface ChannelLeaveResult {
  left: true;
  channel: string;
}

/**
 * Non-wire provenance carried only on an error created by `joinChannel`.
 * `Symbol.for` keeps the marker stable across test-isolated module instances;
 * JSON/socket input cannot forge a symbol-keyed property.
 */
export const JOIN_ATTEMPT_RELEASED_CHANNEL = Symbol.for(
  "figmamcp.joinAttemptReleasedChannel",
);

/**
 * Add trusted join-attempt recovery evidence without destroying the error
 * origin's details shape (Change 6, C6-F5).
 *
 * Ordinary JSON records remain flat so existing callers keep their field
 * paths. A record that already owns the reserved `releasedChannel` key is
 * nested whole under `originDetails`; overwriting it would violate origin
 * preservation, while leaving it flat would confuse untrusted and canonical
 * evidence. Every other JSON shape is likewise retained verbatim under
 * `originDetails`; `undefined` has no origin value to retain.
 */
export function mergeReleasedChannelDetails(
  details: unknown,
  releasedChannel: string,
): Record<string, unknown> {
  if (details === undefined) return { releasedChannel };

  if (isPlainDetailsRecord(details)) {
    if (!Object.prototype.hasOwnProperty.call(details, "releasedChannel")) {
      return {
        ...details,
        releasedChannel,
      };
    }
  }

  return { originDetails: details, releasedChannel };
}

/**
 * Preserve join-origin details on either leg while ensuring an origin-authored
 * `releasedChannel` cannot occupy the trusted top-level evidence slot when the
 * actual join attempt released no predecessor.
 */
export function isolateUntrustedReleasedChannelDetails(
  details: unknown,
): unknown {
  return isPlainDetailsRecord(details)
    && Object.prototype.hasOwnProperty.call(details, "releasedChannel")
    ? { originDetails: details }
    : details;
}

function isPlainDetailsRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export const CHANNEL_REFUSALS = {
  PLUGIN_PEER_UNAVAILABLE: (channel: string): ChannelProtocolError => ({
    code: "PLUGIN_PEER_UNAVAILABLE",
    message:
      "Operation Denied: Figma Plugin is not running or available. Please open the Figma document, start the figmamcp plugin, and reconnect.",
    details: { channel, peerCount: 0 },
  }),

  // Delivered to the JOINING plugin peer, never to an MCP caller: a channel
  // holds one plugin slot, so the second plugin is refused here and
  // `channel_join` can never observe two (Change 5, P9-F1).
  //
  // No `peerCount` here. It was previously the literal `2` regardless of how
  // many peers were involved, which presented a constant as an observation
  // (P9-F5). `PLUGIN_PEER_UNAVAILABLE` keeps its count because zero is real.
  PLUGIN_PEER_AMBIGUOUS: (channel: string): ChannelProtocolError => ({
    code: "PLUGIN_PEER_AMBIGUOUS",
    message:
      "Operation Denied: Multiple plugin peers are connected to this channel. Ensure the figmamcp plugin is open in exactly one Figma tab/document.",
    details: { channel },
  }),

  CHANNEL_IN_USE: (channel: string): ChannelProtocolError => ({
    code: "CHANNEL_IN_USE",
    message:
      "Operation Denied: This channel is already in use by another MCP session. Please use a different channel name or disconnect the other session.",
    details: { channel },
  }),

  VERSION_MISMATCH: (
    channel: string,
    serverVersion: string,
    pluginVersion: string,
  ): ChannelProtocolError => ({
    code: "VERSION_MISMATCH",
    message: versionMismatchMessage(serverVersion, pluginVersion),
    details: { channel, serverVersion, pluginVersion },
  }),

  PLUGIN_DISCONNECTED: (
    channel: string,
    pluginPeerId: string,
  ): ChannelProtocolError => ({
    code: "PLUGIN_DISCONNECTED",
    message:
      "The bound Figma plugin peer disconnected. Reopen the plugin and successfully rejoin the channel before calling another tool.",
    details: { channel, pluginPeerId },
  }),
} as const;

/**
 * Refusals raised by the MCP client itself, before any frame reaches the
 * socket. Kept separate from `CHANNEL_REFUSALS` on the same rule the Change 5
 * origin split established: a factory lives where its code can actually be
 * thrown. No `Operation Denied:` prefix — like `PLUGIN_DISCONNECTED`, this
 * reports a missing precondition, not a policy denial (D9 reserves the prefix
 * for policy/verification refusals).
 */
export const CLIENT_REFUSALS = {
  /**
   * `releasedChannel` is present only when a failed `channel_join` gave up a
   * working binding to attempt it (P9-F2), which is the case where the agent
   * needs a specific channel name to get back to where it was.
   */
  CHANNEL_NOT_BOUND: (releasedChannel?: string): ChannelProtocolError => ({
    code: "CHANNEL_NOT_BOUND",
    message: releasedChannel
      ? `No channel is bound to this session: a failed channel_join released the previously joined channel '${releasedChannel}'. Call channel_join with '${releasedChannel}' to reconnect to it before sending another command.`
      : "No channel is bound to this session. Call channel_join with the channel code shown in the Figma plugin's status bar before sending commands.",
    ...(releasedChannel === undefined ? {} : { details: { releasedChannel } }),
  }),
} as const;

/**
 * Canonical form of a self-reported version. Both join paths normalize on
 * ingest so the "is this known?" test and the equality test operate on the
 * same value — previously the former trimmed and the latter did not, so a
 * padded self-report could be counted as known AND as unequal to its own
 * unpadded twin (Change 5, P9-F6).
 */
export function normalizeChannelVersion(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "unknown";
}

/**
 * D13 refuses a known unequal pair. The plugin's build fallback is deliberately
 * `"unknown"` rather than another hard-coded version surface, so an unavailable
 * self-report is not misclassified as a known mismatch.
 */
export function isKnownChannelVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().toLowerCase() !== "unknown"
  );
}

/** Leading `major.minor` of a self-reported build, or null when it is not a plain release number. */
function releaseLine(version: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? `${m[1]}.${m[2]}` : null;
}

/**
 * Patch releases share one server/plugin wire contract; a contract change bumps the minor version.
 * So an AI session whose server started before an upgrade keeps working with the reloaded plugin.
 * Builds that are not plain `x.y.z` (local or dev builds) must match exactly.
 */
export function channelVersionsCompatible(serverVersion: string, pluginVersion: string): boolean {
  if (serverVersion === pluginVersion) return true;
  const a = releaseLine(serverVersion);
  return a !== null && a === releaseLine(pluginVersion);
}

function olderSide(serverVersion: string, pluginVersion: string): "server" | "plugin" | null {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number) ?? null;
  const s = parse(serverVersion);
  const p = parse(pluginVersion);
  if (!s || !p) return null;
  for (let i = 0; i < 3; i++) {
    if (s[i] !== p[i]) return s[i] < p[i] ? "server" : "plugin";
  }
  return null;
}

function versionMismatchMessage(serverVersion: string, pluginVersion: string): string {
  const side = olderSide(serverVersion, pluginVersion);
  if (side === "server") {
    return `Operation Denied: The FigmaMCP server (${serverVersion}) is older than the Figma plugin (${pluginVersion}). This AI session started before FigmaMCP was updated. Reconnect FigmaMCP in the AI app (Claude Code: /mcp, then reconnect figmamcp) or start a new session. Reopening the plugin does not help.`;
  }
  if (side === "plugin") {
    return `Operation Denied: The Figma plugin (${pluginVersion}) is older than the FigmaMCP server (${serverVersion}). Close the FigmaMCP panel in Figma and reopen it from Plugins > Development > FigmaMCP.`;
  }
  return `Operation Denied: The FigmaMCP server (${serverVersion}) and the Figma plugin (${pluginVersion}) are different builds. Reinstall FigmaMCP, then reconnect FigmaMCP in the AI app and reopen the plugin in Figma.`;
}

export function joinErrorFrame(
  id: unknown,
  error: ChannelProtocolError,
) {
  return {
    type: "join_error" as const,
    ...(typeof id === "string" ? { id } : {}),
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

export function acknowledgedResultFrame(
  id: unknown,
  channel: string,
  result: Record<string, unknown>,
) {
  return {
    type: "system" as const,
    message: {
      ...(typeof id === "string" ? { id } : {}),
      result,
    },
    channel,
  };
}
