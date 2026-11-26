import { WebSocket as WsWebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import { normalizeNodeId, normalizeNodeIds } from "./utils.js";
import { logger } from "./logger.js";
import { UNKNOWN_ERROR } from "../shared/errorCodes.js";
import { SERVER_VERSION } from "../shared/version.js";
import { telemetryEnvOff } from "../telemetry.js";
import {
    CLIENT_REFUSALS,
    JOIN_ATTEMPT_RELEASED_CHANNEL,
    mergeReleasedChannelDetails,
} from "../shared/channelProtocol.js";
import type {
    ChannelJoinResult as ProtocolChannelJoinResult,
    ChannelLeaveResult,
    ClientIdentity,
} from "../shared/channelProtocol.js";

// Prefer the runtime's native WebSocket (bun, and node >= 22) over the `ws`
// package's client. The `ws` client mishandles the HTTP 101 upgrade under bun:
// it surfaces the *successful* handshake as "Unexpected server response: 101",
// drops the connection, and reconnect-loops forever. The native WebSocket
// handles the upgrade correctly. Fall back to `ws` on older node (20/21) that
// lack a global WebSocket. We drive it through the browser-style event API
// (addEventListener / event.data), which both implementations support.
const WSImpl: any = (globalThis as any).WebSocket ?? WsWebSocket;
const WS_OPEN = 1; // WebSocket.OPEN === 1 in every implementation

/** FIGMAMCP_TELEMETRY=0 reaches only this process, not the relay started at login, so the relay is told. */
const telemetryFlag = (): { telemetry?: false } => (telemetryEnvOff() ? { telemetry: false } : {});

export class FigmaError extends Error {
    code: string;
    details?: any;
    constructor(errorObj: any) {
        const msg = (errorObj && typeof errorObj === "object" && typeof errorObj.message === "string")
            ? errorObj.message
            : (typeof errorObj === "string" ? errorObj : "Error executing command");
        super(msg);
        this.code = (errorObj && typeof errorObj === "object" && typeof errorObj.code === "string")
            ? errorObj.code
            : UNKNOWN_ERROR;
        this.details = (errorObj && typeof errorObj === "object")
            ? errorObj.details
            : undefined;
        Object.setPrototypeOf(this, FigmaError.prototype);
    }
}

// Define TypeScript interfaces for Figma responses
export interface FigmaResponse {
    id: string;
    result?: any;
    error?: string | { code: string; message: string; details?: any };
}

export type JoinChannelResult = ProtocolChannelJoinResult & {
    /**
     * Internal attempt metadata: a healthy binding that this join released
     * before the socket admitted the requested channel. The channel tool keeps
     * this out of successful output, but needs it if its subsequent
     * get_connect_payload leg fails.
     */
    releasedChannel?: string;
};

export interface ResetChannelOptions {
    /**
     * Preserve a healthy predecessor released earlier in the same channel_join
     * attempt. This keeps the following CHANNEL_NOT_BOUND failure actionable
     * when the post-join scope read fails.
     */
    releasedChannel?: string;
}

function markJoinAttemptReleasedChannel(
    error: FigmaError,
    releasedChannel: string,
): FigmaError {
    Object.defineProperty(error, JOIN_ATTEMPT_RELEASED_CHANNEL, {
        value: releasedChannel,
        enumerable: false,
        configurable: false,
        writable: false,
    });
    return error;
}

// Define interface for command progress updates
export interface CommandProgressUpdate {
    type: 'command_progress';
    commandId: string;
    commandType: string;
    status: 'started' | 'in_progress' | 'completed' | 'error';
    progress: number;
    totalItems: number;
    processedItems: number;
    currentChunk?: number;
    totalChunks?: number;
    chunkSize?: number;
    message: string;
    payload?: any;
    timestamp: number;
}

// Update the getInstanceOverridesResult interface to match the plugin implementation
export interface getInstanceOverridesResult {
    success: boolean;
    message: string;
    sourceInstanceId: string;
    mainComponentId: string;
    overridesCount: number;
}

export interface setInstanceOverridesResult {
    success: boolean;
    status: 'success' | 'partial_success' | 'failed';
    message: string;
    requestedCount: number;
    succeededCount: number;
    failedCount: number;
    skippedCount: number;
    totalAppliedCount: number;
    results: Array<{
        success: boolean;
        status: 'success' | 'failed' | 'skipped';
        nodeId: string;
        instanceName?: string;
        appliedCount?: number;
        error?: string;
        partialMutation?: boolean;
        whatChanged?: string;
        before?: {
            mainComponentId?: string;
            appliedFields?: Array<{ nodeId: string; field: string; before?: unknown }>;
        };
    }>;
}

// Command strings accepted by sendCommandToFigma: the v2.0.0 underscore-namespaced
// tool commands plus the two internal transport commands (`join`, `get_connect_payload`).
// Keep in sync with the tool registrations (src/mcp_server/tools/*) and the plugin
// command router (figma_plugin/src/main.ts). Note: the `channel_join` tool is not a
// wire command — it calls joinChannel(), which sends `join`.
export type FigmaCommand =
    // transport / internal
    | "join"
    | "get_connect_payload"
    // page
    | "page_info"
    // node
    | "node_info"
    | "node_transform"
    | "node_rename"
    | "node_delete"
    | "node_clone"
    | "view_navigate"
    | "node_group"
    | "node_ungroup"
    | "node_flatten"
    | "node_insert_child"
    | "node_set_auto_layout"
    | "node_set_fill"
    | "node_set_stroke"
    | "node_set_corner_radius"
    | "node_set_effects"
    | "node_apply_style"
    | "node_bind_variable"
    | "node_export_visual"
    // create
    | "create_shape"
    | "create_frame"
    | "create_text"
    | "create_svg"
    | "create_component"
    | "create_instance"
    | "create_component_set"
    // style
    | "style_list"
    | "style_manage"
    | "style_delete"
    // text
    | "text_set_content"
    | "text_set_style"
    // component
    | "component_list"
    | "component_manage_property"
    | "component_delete_property"
    // instance
    | "instance_set_property"
    | "instance_get_overrides"
    | "instance_set_overrides"
    // variable
    | "variable_list"
    | "variable_manage"
    | "variable_delete"
    // annotation
    | "annotation_list"
    | "annotation_set"
    // reaction
    | "reaction_list"
    | "reaction_update";

// State management
let ws: any = null;
let wsUrl: string = 'ws://localhost:3155'; // Default
let defaultPort: number = 3155;
let nextBindingGeneration = 0;

type ChannelBindingState =
    // `releasedChannel` records a working binding this client gave up in order
    // to attempt a join that then failed (Change 5, P9-F2). A connection owns
    // at most one socket reservation, so the leave must happen first — but the
    // caller must be told which channel that cost them, or a mistyped channel
    // code silently destroys a live connection with no way back in one step.
    | { status: "unbound"; releasedChannel?: string }
    | {
        status: "bound";
        channel: string;
        serverVersion: string;
        pluginVersion: string;
        generation: number;
    }
    | {
        status: "invalidated";
        channel: string;
        generation: number;
        error: FigmaError;
        requiresLeave: boolean;
    };

let bindingState: ChannelBindingState = { status: "unbound" };

const pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
    lastActivity: number;
    kind: "join" | "leave" | "command" | "list";
    bindingGeneration?: number;
}>();

function rejectPendingForBinding(generation: number, error: FigmaError) {
    for (const [id, request] of pendingRequests.entries()) {
        if (request.bindingGeneration !== generation) continue;
        clearTimeout(request.timeout);
        request.reject(error);
        pendingRequests.delete(id);
    }
}

function invalidateBoundChannel(error: FigmaError, requiresLeave: boolean) {
    if (bindingState.status !== "bound") return;
    const { channel, generation } = bindingState;
    bindingState = {
        status: "invalidated",
        channel,
        generation,
        error,
        requiresLeave,
    };
    rejectPendingForBinding(generation, error);
}

// Who this session is, for the plugin panel (see clientLabel.ts). Local only:
// sent over the localhost relay to the plugin, never to analytics.
let identitySource: (() => ClientIdentity | null | undefined) | null = null;
let lastSentIdentity: string | null = null;

export function setClientIdentitySource(source: (() => ClientIdentity | null | undefined) | null) {
    identitySource = source;
    lastSentIdentity = null;
}

function currentIdentity(): ClientIdentity | undefined {
    try {
        const identity = identitySource?.();
        return identity ? { app: identity.app, label: identity.label } : undefined;
    } catch {
        return undefined;
    }
}

/** Identity for an outgoing hello or join frame; records it as sent. */
function identityForFrame(): { client?: ClientIdentity } {
    const client = currentIdentity();
    if (!client) return {};
    lastSentIdentity = JSON.stringify(client);
    return { client };
}

/**
 * Re-resolve the identity and tell the relay only when it changed: a desktop
 * session is titled after its first turns, and users rename sessions.
 */
export function refreshClientIdentity(): void {
    if (!ws || ws.readyState !== WS_OPEN) return;
    const client = currentIdentity();
    if (!client) return;
    const key = JSON.stringify(client);
    if (key === lastSentIdentity) return;
    try {
        ws.send(JSON.stringify({ type: "client_info", client }));
        lastSentIdentity = key;
    } catch (error) {
        logger.debug(`client_info send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export function setFigmaServerUrl(url: string) {
    wsUrl = url;
}

export function connectToFigma(port: number = defaultPort) {
    // If already connected, do nothing
    if (ws && ws.readyState === WS_OPEN) {
        logger.info('Already connected to Figma');
        return;
    }

    // If port is passed, and we are on localhost default, append it.
    // The logic in server.ts: const wsUrl = serverUrl === 'localhost' ? `${WS_URL}:${port}` : WS_URL;
    // Here wsUrl should already be constructed properly or we construct it.
    // To match server.ts logic exactly:
    let finalUrl = wsUrl;
    if (wsUrl.startsWith('ws://localhost') || wsUrl.startsWith('ws://127.0.0.1')) {
        // Check if it already has port
        const hasPort = wsUrl.split(':').length > 2;
        if (!hasPort) {
            finalUrl = `${wsUrl}:${port}`;
        }
    }

    logger.info(`Connecting to Figma socket server at ${finalUrl}...`);
    ws = new WSImpl(finalUrl);

    ws.addEventListener('open', () => {
        logger.info('Connected to Figma socket server');
        // Announce at once, before any channel is chosen: autoBind only joins on
        // the first real tool call, so without this an idle, already-running
        // server would be invisible to a plugin that opens while it waits.
        ws.send(JSON.stringify({ type: 'hello', clientType: 'mcp', ...identityForFrame(), ...telemetryFlag() }));
    });

    ws.addEventListener("message", (event: any) => {
        try {
            interface ProgressMessage {
                message: FigmaResponse | any;
                type?: string;
                id?: string;
                [key: string]: any;
            }

            // event.data is a string for text frames under native WebSocket; the
            // `ws` package may hand back a Buffer — normalize to a string either way.
            const raw = typeof event.data === "string"
                ? event.data
                : (event.data?.toString?.() ?? String(event.data));
            const json = JSON.parse(raw) as ProgressMessage;

            // The socket bridge emits this only when the plugin peer bound to
            // this MCP session leaves. Generic room broadcasts are not binding
            // evidence. Invalidate the exact channel generation immediately so
            // later tool calls fail before a frame can be sent.
            if (json.type === "peer_disconnected") {
                if (
                    bindingState.status === "bound"
                    && typeof json.channel === "string"
                    && json.channel === bindingState.channel
                ) {
                    invalidateBoundChannel(new FigmaError({
                        code: typeof json.code === "string" ? json.code : "PLUGIN_DISCONNECTED",
                        message: typeof json.message === "string"
                            ? json.message
                            : "The bound Figma plugin peer disconnected.",
                        ...(json.details !== undefined ? { details: json.details } : {}),
                    }), true);
                }
                return;
            }

            // Local patch (simple model): reply to listChannels().
            if (json.type === 'channel_list') {
                const requestId = json.id || '';
                const request = requestId ? pendingRequests.get(requestId) : undefined;
                if (request && request.kind === "list") {
                    clearTimeout(request.timeout);
                    pendingRequests.delete(requestId);
                    request.resolve(Array.isArray(json.channels) ? json.channels : []);
                }
                return;
            }

            // Handle join_error
            if (json.type === 'join_error') {
                const requestId = json.id || '';
                if (requestId && pendingRequests.has(requestId)) {
                    const request = pendingRequests.get(requestId)!;
                    clearTimeout(request.timeout);
                    
                    // Pass through the whole message: FigmaError cherry-picks
                    // code/message/details and defaults an absent code to
                    // UNKNOWN_ERROR (Q16 — no ad-hoc codes). Passing `json`
                    // itself (not a hand-picked {code, message} literal) is
                    // what carries `details` through if the socket ever sends
                    // one — matching the `new FigmaError(myResponse.error)`
                    // pattern used below for ordinary command responses.
                    const error = new FigmaError(json);
                    request.reject(error);
                    
                    pendingRequests.delete(requestId);
                }
                return;
            }

            // Handle progress updates
            if (json.type === 'progress_update') {
                const progressData = json.message.data as CommandProgressUpdate;
                const requestId = json.id || '';

                if (requestId && pendingRequests.has(requestId)) {
                    const request = pendingRequests.get(requestId)!;

                    // Update last activity timestamp
                    request.lastActivity = Date.now();

                    // Reset the timeout to prevent timeouts during long-running operations
                    clearTimeout(request.timeout);

                    // Create a new timeout
                    request.timeout = setTimeout(() => {
                        if (pendingRequests.has(requestId)) {
                            logger.error(`Request ${requestId} timed out after extended period of inactivity`);
                            pendingRequests.delete(requestId);
                            request.reject(new Error('Request to Figma timed out'));
                        }
                    }, 60000); // 60 second timeout for inactivity

                    // Log progress
                    logger.info(`Progress update for ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`);

                    // For completed updates:
                    if (progressData.status === 'completed' && progressData.progress === 100) {
                        logger.info(`Operation ${progressData.commandType} completed, waiting for final result`);
                    }
                }
                return;
            }

            // Handle regular responses
            const myResponse = json.message;
            logger.debug(`Received message: ${JSON.stringify(myResponse)}`);
            // logger.log('myResponse' + JSON.stringify(myResponse)); // Removed extra log

            // Handle response to a request
            if (
                myResponse.id &&
                pendingRequests.has(myResponse.id) &&
                (myResponse.result !== undefined || myResponse.error !== undefined) // Checks result or error presence
            ) {
                const request = pendingRequests.get(myResponse.id)!;
                clearTimeout(request.timeout);

                // A response queued for an older binding must never resolve a
                // command after reset/rejoin. The socket performs peer-bound
                // routing too; this is the client-side generation backstop.
                if (
                    request.kind === "command"
                    && (
                        bindingState.status !== "bound"
                        || request.bindingGeneration !== bindingState.generation
                    )
                ) {
                    request.reject(
                        bindingState.status === "invalidated"
                            ? bindingState.error
                            : new FigmaError({
                                code: "PLUGIN_DISCONNECTED",
                                message: "The channel binding changed before the command response arrived.",
                            }),
                    );
                    pendingRequests.delete(myResponse.id);
                    return;
                }

                if (myResponse.error) {
                    logger.error(`Error from Figma: ${typeof myResponse.error === "object" ? JSON.stringify(myResponse.error) : myResponse.error}`);
                    request.reject(new FigmaError(myResponse.error));
                } else {
                    request.resolve(myResponse.result);
                }

                pendingRequests.delete(myResponse.id);
            } else {
                // Handle broadcast messages or events
                logger.info(`Received broadcast message: ${JSON.stringify(myResponse)}`);
            }
        } catch (error) {
            logger.error(`Error parsing message: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    ws.addEventListener('error', (event: any) => {
        const detail = event?.message ?? event?.error ?? event?.type ?? event;
        logger.error(`Socket error: ${detail}`);
    });

    ws.addEventListener('close', () => {
        logger.info('Disconnected from Figma socket server');
        ws = null;

        const disconnectError = new FigmaError({
            code: "PLUGIN_DISCONNECTED",
            message: "Connection closed",
        });
        invalidateBoundChannel(disconnectError, false);

        // Reject all pending requests. Coded at origin (Q20): the plugin peer's
        // connection dropped, so the code is PLUGIN_DISCONNECTED — never
        // reconstructed from message prose downstream.
        for (const [id, request] of pendingRequests.entries()) {
            clearTimeout(request.timeout);
            request.reject(disconnectError);
            pendingRequests.delete(id);
        }

        // Attempt to reconnect. unref() so a pending reconnect alone never
        // keeps the process alive — when the MCP host disconnects, the server
        // must be free to exit instead of lingering as an orphan that spins
        // this loop forever (see server.ts shutdown wiring).
        const reconnectTimer = setTimeout(() => connectToFigma(port), 2000);
        reconnectTimer.unref?.();
    });
}

function sendLeaveRequest(channel: string, timeoutMs: number = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WS_OPEN) {
            reject(new FigmaError({
                code: "PLUGIN_DISCONNECTED",
                message: "Cannot leave the channel because the socket connection is closed.",
            }));
            return;
        }

        const id = uuidv4();
        const timeout = setTimeout(() => {
            if (!pendingRequests.has(id)) return;
            pendingRequests.delete(id);
            reject(new Error(`Leave request timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        pendingRequests.set(id, {
            resolve: (value) => {
                const acknowledgement = value as Partial<ChannelLeaveResult> | null;
                if (
                    acknowledgement?.left === true
                    && acknowledgement.channel === channel
                ) {
                    resolve();
                    return;
                }
                reject(new Error(
                    `Channel leave acknowledgement was malformed for '${channel}'`,
                ));
            },
            reject,
            timeout,
            lastActivity: Date.now(),
            kind: "leave",
        });

        try {
            ws.send(JSON.stringify({ id, type: "leave", channel }));
            logger.debug(`Sent channel leave: ${channel}`);
        } catch (error) {
            clearTimeout(timeout);
            pendingRequests.delete(id);
            reject(error);
        }
    });
}

export async function resetChannel(
    options: ResetChannelOptions = {},
): Promise<void> {
    const releasedChannel = typeof options.releasedChannel === "string"
        && options.releasedChannel.length > 0
        ? options.releasedChannel
        : undefined;
    const nextUnboundState: ChannelBindingState = releasedChannel
        ? { status: "unbound", releasedChannel }
        : { status: "unbound" };

    if (bindingState.status === "unbound") {
        // A transport failure may have cleared the newly admitted binding
        // before the channel tool performs its leg-2 cleanup. Do not lose the
        // healthy predecessor that this same join attempt already released.
        if (releasedChannel) bindingState = nextUnboundState;
        return;
    }

    const previousBinding = bindingState;
    bindingState = nextUnboundState;
    rejectPendingForBinding(
        previousBinding.generation,
        new FigmaError({
            code: "PLUGIN_DISCONNECTED",
            message: "The channel binding was reset before the command completed.",
        }),
    );

    const mustLeave = previousBinding.status === "bound"
        || previousBinding.requiresLeave;
    if (!mustLeave) return;

    try {
        await sendLeaveRequest(previousBinding.channel);
        logger.info(`Left channel: ${previousBinding.channel}`);
    } catch (error) {
        // A socket close is the protocol's final cleanup path. Do not leave a
        // stale server-side MCP reservation after local state is already clear.
        try {
            ws?.close?.();
        } catch {
            // Preserve the leave failure for the caller.
        }
        throw error;
    }
}

// How long channel_join waits for the relay socket to open. A fresh server
// process starts the socket in CONNECTING; joining before it opens used to fail
// with an uncoded "Not connected to Figma" (tester report, 0.1.11).
let connectWaitMs = 5000;
export function setConnectWaitMs(ms: number) {
    connectWaitMs = ms;
}

export async function joinChannel(channelName: string): Promise<JoinChannelResult> {
    // Fast path stays synchronous: an open socket sends the join frame in the
    // same tick, as before.
    if ((!ws || ws.readyState !== WS_OPEN) && !(await waitForOpenSocket(connectWaitMs))) {
        throw new FigmaError({
            code: "CONNECTION_NOT_READY",
            message:
                `The local figmamcp relay connection did not open within ${Math.round(connectWaitMs / 1000)}s. ` +
                "Check that the FigmaMCP app (relay) is running and the plugin is open in Figma, then retry channel_join, " +
                "or call page_info, which binds to the open plugin on its own.",
        });
    }

    let socketAdmittedJoin = false;
    // Non-empty only when this attempt gave up a live binding to make room.
    let releasedChannel: string | undefined;
    try {
        // A connection owns at most one channel reservation. Detach the old
        // pair before attempting a switch or rejoin; a failed new join therefore
        // cannot silently leave later tools targeting the previous plugin.
        if (bindingState.status !== "unbound") {
            const previousBinding = bindingState;
            const previousChannel = previousBinding.channel;
            try {
                await resetChannel();
            } catch (leaveError: any) {
                // P9-F7: this is NOT a join-acknowledgement timeout. Tag the
                // phase so recovery guidance can name the real cause instead of
                // telling the caller the plugin was slow to accept a join it
                // never saw.
                throw new FigmaError({
                    code: "CHANNEL_JOIN_FAILED",
                    message: `Could not leave the current channel '${previousChannel}', so the join to '${channelName}' was not attempted: ${leaveError?.message ?? String(leaveError)}`,
                    details: {
                        phase: "leave-previous-channel",
                        previousChannel,
                        requestedChannel: channelName,
                    },
                });
            }
            // Only a healthy bound state qualifies. An invalidated binding is
            // already unusable, so naming it as a channel this attempt "cost"
            // would fabricate recovery evidence. A same-channel rejoin DOES
            // qualify: the live reservation was released before the failed
            // replacement attempt.
            if (previousBinding.status === "bound") {
                releasedChannel = previousChannel;
            }
        }

        const result = await sendCommandToFigma("join", { channel: channelName });
        socketAdmittedJoin = true;
        if (
            result === null
            || typeof result !== "object"
            || typeof (result as any).serverVersion !== "string"
            || typeof (result as any).pluginVersion !== "string"
        ) {
            throw new Error("Channel join acknowledgement omitted serverVersion or pluginVersion");
        }

        const joined: JoinChannelResult = {
            serverVersion: (result as any).serverVersion,
            pluginVersion: (result as any).pluginVersion,
            ...(releasedChannel ? { releasedChannel } : {}),
        };
        bindingState = {
            status: "bound",
            channel: channelName,
            serverVersion: joined.serverVersion,
            pluginVersion: joined.pluginVersion,
            generation: ++nextBindingGeneration,
        };
        logger.info(`Joined channel: ${channelName}`);
        return joined;
    } catch (error) {
        // A successful wire acknowledgement reserves this MCP peer before the
        // client validates its payload. If that acknowledgement is malformed,
        // explicitly leave so local fail-closed state cannot strand a server-
        // side CHANNEL_IN_USE reservation.
        if (socketAdmittedJoin) {
            try {
                await sendLeaveRequest(channelName);
            } catch {
                // Preserve the malformed-ack failure. Local state stays unbound;
                // force-close so the bridge cannot retain a stale reservation.
                try {
                    ws?.close?.();
                } catch {
                    // The originating malformed acknowledgement remains primary.
                }
            }
        }
        logger.error(`Failed to join channel: ${error instanceof Error ? error.message : String(error)}`);

        // P9-F2: the failed attempt already cost the caller a live binding.
        // Record it so later commands can say so, and attach it to the error so
        // the join result names the channel that must be rejoined.
        if (releasedChannel) {
            bindingState = { status: "unbound", releasedChannel };
        }

        // Q20: code the join flow's locally-generated failures at origin. An
        // already-coded error (socket CHANNEL_NOT_FOUND, close-handler
        // PLUGIN_DISCONNECTED) passes through untouched; an uncoded local
        // failure — e.g. the request timeout — becomes CHANNEL_JOIN_FAILED.
        // The check is structural (absence of a code), never message prose.
        if (error !== null && typeof error === "object" && typeof (error as any).code === "string") {
            if (releasedChannel) {
                // Preserve code and message verbatim (Q20) and add the released
                // channel alongside whatever details the origin supplied.
                throw markJoinAttemptReleasedChannel(
                    new FigmaError({
                        code: (error as any).code,
                        message: (error as any).message,
                        details: mergeReleasedChannelDetails(
                            (error as any).details,
                            releasedChannel,
                        ),
                    }),
                    releasedChannel,
                );
            }
            throw error;
        }
        const joinError = new FigmaError({
            code: "CHANNEL_JOIN_FAILED",
            message: error instanceof Error ? error.message : String(error),
            ...(releasedChannel ? { details: { releasedChannel } } : {}),
        });
        throw releasedChannel
            ? markJoinAttemptReleasedChannel(joinError, releasedChannel)
            : joinError;
    }
}

// Local patch (simple model): a session binds to the plugin on demand instead
// of requiring an explicit channel_join first. The binder (installed by
// server.ts, see tools/channel.ts) runs only while this client holds no live
// binding, BEFORE any command frame is sent, so nothing has executed in Figma
// when it fails. Concurrent calls share one in-flight bind.
let autoBinder: (() => Promise<void>) | null = null;
let autoBindInFlight: Promise<void> | null = null;

export function setAutoBinder(binder: (() => Promise<void>) | null) {
    autoBinder = binder;
}

export interface ListedChannel {
    channel: string;
    fileName: string | null;
    pluginVersion: string;
    mcpCount: number;
    maxMcpPeers: number;
}

function waitForOpenSocket(timeoutMs: number): Promise<boolean> {
    if (ws && ws.readyState === WS_OPEN) return Promise.resolve(true);
    // CLOSING/CLOSED: start a fresh attempt instead of waiting for the 2s
    // reconnect timer.
    if (!ws || ws.readyState >= 2) connectToFigma();
    return new Promise((resolve) => {
        const started = Date.now();
        const poll = setInterval(() => {
            if (ws && ws.readyState === WS_OPEN) {
                clearInterval(poll);
                resolve(true);
            } else if (Date.now() - started >= timeoutMs) {
                clearInterval(poll);
                resolve(false);
            }
        }, 50);
        poll.unref?.();
    });
}

/** Local patch (simple model): ask the relay which plugins are connected. */
export async function listChannels(timeoutMs: number = 3000): Promise<ListedChannel[]> {
    if (!(await waitForOpenSocket(timeoutMs))) {
        throw new FigmaError({
            code: "PLUGIN_DISCONNECTED",
            message: "Cannot reach the local figmamcp relay. Check that it is running.",
        });
    }
    const id = uuidv4();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new FigmaError({ code: "CHANNEL_JOIN_FAILED", message: "The relay did not answer list_channels in time; it may predate this build." }));
        }, timeoutMs);
        pendingRequests.set(id, {
            resolve: resolve as (value: unknown) => void,
            reject,
            timeout,
            lastActivity: Date.now(),
            kind: "list",
        });
        ws.send(JSON.stringify({ type: "list_channels", id }));
    });
}

// Not `async`: when no auto-bind is needed the direct promise is returned as
// is, so callers see the same microtask timing as before this patch.
export function sendCommandToFigma(
    command: FigmaCommand,
    params: unknown = {},
    timeoutMs: number = 30000
): Promise<unknown> {
    if (
        autoBinder
        && command !== "join"
        && command !== "get_connect_payload"
        && bindingState.status !== "bound"
    ) {
        if (!autoBindInFlight) {
            autoBindInFlight = autoBinder().finally(() => { autoBindInFlight = null; });
        }
        return autoBindInFlight.then(() => sendCommandToFigmaDirect(command, params, timeoutMs));
    }
    return sendCommandToFigmaDirect(command, params, timeoutMs);
}

function sendCommandToFigmaDirect(
    command: FigmaCommand,
    params: unknown = {},
    timeoutMs: number = 30000
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const requiresChannel = command !== "join";
        const activeBinding = bindingState.status === "bound"
            ? bindingState
            : null;

        // Binding validity is checked before socket connectivity so a peer
        // invalidation remains the stable, actionable failure until channel_join
        // succeeds. No command frame is emitted while unbound/invalidated.
        if (requiresChannel && !activeBinding) {
            if (bindingState.status === "invalidated") {
                reject(bindingState.error);
            } else {
                // Rev 57: coded CHANNEL_NOT_BOUND rather than a bare Error on
                // the UNKNOWN_ERROR fallback. P9-F2 made this a new reachable
                // state — a failed join can now release a working binding — so
                // D9's "adds or edits" rule applies and the code earns its own
                // playbook entry. The factory carries the released channel when
                // there is one, so recovery stays one round trip either way.
                // Narrowed explicitly rather than read off the union: only the
                // "unbound" member carries `releasedChannel`, and TypeScript
                // cannot infer from `!activeBinding` that "bound" is excluded
                // here. Runtime-identical — the property does not exist on the
                // other members — but it is the difference between this file
                // type-checking and not (Change 29, F6).
                reject(new FigmaError(
                    CLIENT_REFUSALS.CHANNEL_NOT_BOUND(
                        bindingState.status === "unbound" ? bindingState.releasedChannel : undefined,
                    ),
                ));
            }
            return;
        }

        // If not connected, try to connect first
        if (!ws || ws.readyState !== WS_OPEN) {
            connectToFigma();
            reject(new Error("Not connected to Figma. Attempting to connect..."));
            return;
        }

        const id = uuidv4();

        // Normalize node IDs in params (convert URL format to API format)
        const normalizedParams = { ...(params as any) };

        // Handle single nodeId parameter
        if (normalizedParams.nodeId) {
            normalizedParams.nodeId = normalizeNodeId(normalizedParams.nodeId);
        }

        // Handle nodeIds array parameter
        if (normalizedParams.nodeIds) {
            normalizedParams.nodeIds = normalizeNodeIds(normalizedParams.nodeIds);
        }

        // Handle ids array parameter (used in view_navigate)
        if (normalizedParams.ids) {
            normalizedParams.ids = normalizeNodeIds(normalizedParams.ids);
        }

        // Handle sourceInstanceId (used in set_instance_overrides)
        if (normalizedParams.sourceInstanceId) {
            normalizedParams.sourceInstanceId = normalizeNodeId(normalizedParams.sourceInstanceId);
        }

        // Handle targetNodeIds array (used in set_instance_overrides) - DEPRECATED
        if (normalizedParams.targetNodeIds) {
            normalizedParams.targetNodeIds = normalizeNodeIds(normalizedParams.targetNodeIds);
        }

        // Handle nodes array (used in delete_multiple_nodes)
        if (normalizedParams.nodes && Array.isArray(normalizedParams.nodes)) {
            normalizedParams.nodes = normalizedParams.nodes.map((item: any) => ({
                ...item,
                nodeId: normalizeNodeId(item.nodeId) || item.nodeId
            }));
        }

        // Handle targetNodes array (used in set_instance_overrides)
        if (normalizedParams.targetNodes && Array.isArray(normalizedParams.targetNodes)) {
            normalizedParams.targetNodes = normalizedParams.targetNodes.map((item: any) => ({
                ...item,
                nodeId: normalizeNodeId(item.nodeId) || item.nodeId
            }));
        }

        // Handle parentId parameter
        if (normalizedParams.parentId) {
            normalizedParams.parentId = normalizeNodeId(normalizedParams.parentId);
        }

        // Handle text array for set_multiple_text_contents
        if (normalizedParams.text && Array.isArray(normalizedParams.text)) {
            normalizedParams.text = normalizedParams.text.map((item: any) => ({
                ...item,
                nodeId: normalizeNodeId(item.nodeId) || item.nodeId
            }));
        }

        // Handle annotations array for set_multiple_annotations
        if (normalizedParams.annotations && Array.isArray(normalizedParams.annotations)) {
            normalizedParams.annotations = normalizedParams.annotations.map((annotation: any) => ({
                ...annotation,
                nodeId: normalizeNodeId(annotation.nodeId) || annotation.nodeId
            }));
        }

        const request = {
            id,
            type: command === "join" ? "join" : "message",
            ...(command === "join"
                ? {
                    channel: normalizedParams.channel,
                    clientType: "mcp",
                    serverVersion: SERVER_VERSION,
                    ...identityForFrame(),
                    ...telemetryFlag(),
                }
                : { channel: activeBinding!.channel }),
            message: {
                id,
                command,
                params: {
                    ...normalizedParams,
                    commandId: id, // Include the command ID in params
                },
            },
        };

        // Set timeout for request
        const timeout = setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                reject(new Error(`Request timed out after ${timeoutMs}ms`));
            }
        }, timeoutMs);

        pendingRequests.set(id, {
            resolve,
            reject,
            timeout,
            lastActivity: Date.now(),
            kind: command === "join" ? "join" : "command",
            ...(activeBinding ? { bindingGeneration: activeBinding.generation } : {}),
        });

        try {
            ws.send(JSON.stringify(request));
            logger.debug(`Sent command: ${command}`);
        } catch (error) {
            pendingRequests.delete(id);
            reject(error);
        }
    });
}
