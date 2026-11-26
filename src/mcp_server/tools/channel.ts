import { askAppToOpenPlugin, type OpenPluginReply } from "../appClient.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
    joinChannel as defaultJoinChannel,
    sendCommandToFigma as defaultSendCommandToFigma,
    resetChannel as defaultResetChannel,
} from "../figma-client.js";
// Local patch (simple model): read through a namespace so that tests which mock
// figma-client with only the three functions above still link.
import * as figmaClient from "../figma-client.js";
import type { ListedChannel } from "../figma-client.js";

type ListChannels = (timeoutMs?: number) => Promise<ListedChannel[]>;
const defaultListChannels: ListChannels = (timeoutMs) => figmaClient.listChannels(timeoutMs);

function codedError(code: string, message: string, details?: unknown): Error {
    return new figmaClient.FigmaError(details !== undefined ? { code, message, details } : { code, message });
}
import { toolResult, looseOutput } from "./_result.js";
import { UNKNOWN_ERROR } from "../../shared/errorCodes.js";
import {
    isolateUntrustedReleasedChannelDetails,
    JOIN_ATTEMPT_RELEASED_CHANNEL,
    mergeReleasedChannelDetails,
} from "../../shared/channelProtocol.js";
import {
    describeThrownForToolBoundary,
    readThrownProperty,
    type DescribedThrownError,
} from "./_error.js";

// Q20 (resolved 2026-07-18, Option A): join failures pass their structured
// codes through verbatim — unknown codes included, never collapsed to
// UNKNOWN_ERROR — and recovery guidance is keyed by code, never derived from
// message prose. The two locally-generated failures are coded at origin in
// figma-client (CHANNEL_JOIN_FAILED on join timeout, PLUGIN_DISCONNECTED on
// connection close). The in-band envelope shape is unchanged (v2.3.4 PRD Q1).
// Guidance receives the originating error so a code with more than one cause
// can name the right one (Change 5, P9-F7): a failure to LEAVE the previous
// channel used to be reported as a join-acknowledgement timeout.
/**
 * Terminates a borrowed origin message so appended recovery reads as its own
 * sentence. Transport errors are not authored for concatenation — a raw
 * `Request timed out after 30000ms` ran straight into the next clause. This is
 * the same run-on Change 8 fixed in `VARIABLE_IN_USE`; here the operand comes
 * from outside, so the join is what has to normalize it.
 */
function asSentence(message: unknown): string {
    const text = typeof message === "string" ? message.trim() : String(message ?? "");
    if (text.length === 0) return text;
    return /[.!?]$/.test(text) ? text : `${text}.`;
}

type JoinRecovery = (channel: string, error: DescribedThrownError) => string;

// Change 13 (C13-F2): a Map makes the recovery inventory own-key-only.
// A future structured code such as `toString` must pass through as unknown,
// never resolve an inherited Object.prototype member and invoke it as guidance.
const JOIN_RECOVERY = new Map<string, JoinRecovery>([
    [
        "CHANNEL_NOT_FOUND",
        (ch) => `Channel '${ch}' was not found. Verify the channel name and that the Figma plugin is running and connected.`,
    ],
    [
        "CHANNEL_JOIN_FAILED",
        (ch, error) =>
            error?.details?.phase === "leave-previous-channel"
                ? `${error.message} The requested join was not sent. This session's local channel binding was cleared, and its socket was closed to release any uncertain bridge reservation. Wait for the automatic bridge reconnect, then call channel_join with '${error.details.previousChannel}' to restore the previous channel or with '${error.details.requestedChannel}' to retry the requested channel.`
                // Change 12 (C12-F1): the scope-payload leg has its own cause.
                // The socket join SUCCEEDED and the plugin then failed to return
                // the editable scope, so the default wording below — "did not
                // acknowledge the join" — would name the wrong step, which is
                // the same wrong-cause defect C6-F7/C6-F3 fixed for the leave leg.
                : error?.details?.phase === "scope-payload"
                    ? `${asSentence(error.message)} The channel was joined, but the Figma plugin did not return the editable scope in time, so no binding was established and this session currently holds none. Call channel_join with '${ch}' again; if it keeps failing, reopen the plugin in Figma and retry.`
                    : `Failed to join channel '${ch}'. The Figma plugin did not acknowledge the join within the expected time. Try reconnecting the plugin.`,
    ],
    [
        "PLUGIN_DISCONNECTED",
        () => "The Figma plugin disconnected before the editable scope could be read. Reopen the plugin and try again.",
    ],
]);

interface ChannelToolDependencies {
    joinChannel: typeof defaultJoinChannel;
    sendCommandToFigma: typeof defaultSendCommandToFigma;
    resetChannel: typeof defaultResetChannel;
    listChannels?: ListChannels;
    openPlugin?: () => Promise<OpenPluginReply | null>;
    sleep?: (ms: number) => Promise<void>;
}

// Built per call, not once at load: the imported bindings are live, and tests
// re-mock figma-client between cases.
function defaultDependencies(): ChannelToolDependencies {
    return {
        joinChannel: defaultJoinChannel,
        sendCommandToFigma: defaultSendCommandToFigma,
        resetChannel: defaultResetChannel,
        listChannels: defaultListChannels,
        openPlugin: () => askAppToOpenPlugin(),
    };
}

// Local patch (simple model): the plugin names its channel after the file key,
// so the key in any Figma link is the channel name.
export function fileKeyFromLink(link: string): string | null {
    const match = /figma\.com\/(?:design|file|board|proto|slides)\/([A-Za-z0-9]+)/.exec(link);
    return match ? match[1] : null;
}

function describeChannels(channels: ListedChannel[]): string {
    return channels.map((c) => `'${c.fileName ?? "(unnamed file)"}' (channel ${c.channel})`).join(", ");
}

// The last successful join of this session. A stable channel name (the file
// key) survives a plugin reload, so the auto-binder rejoins it with the same
// scopeLinks and the session keeps its lease.
let lastJoin: { channel: string; scopeLinks?: string[] } | null = null;

// Names this session in the plugin panel. The label is kept by the provider,
// so an autobind rejoin after a plugin reload still carries it.
let identityProvider: { setExplicitLabel(label: string | null | undefined): void } | null = null;
export function setIdentityProvider(provider: typeof identityProvider) {
    identityProvider = provider;
}

/** Test seam: forget the remembered join. */
export function resetRememberedJoin() {
    lastJoin = null;
}

type ChannelChoice =
    | { ok: "yes"; channel: string; scopeLinks?: string[] }
    | { ok: "no"; errorCode: string; errorMessage: string; errorDetails?: unknown };

async function chooseChannel(
    listChannels: ListChannels,
    preferred: { channel: string; scopeLinks?: string[] } | null,
): Promise<ChannelChoice> {
    let channels: ListedChannel[];
    try {
        channels = await listChannels();
    } catch (error: any) {
        const described = describeThrownForToolBoundary(error);
        return { ok: "no", errorCode: described.code, errorMessage: described.message };
    }
    if (preferred) {
        if (channels.some((c) => c.channel === preferred.channel)) {
            return { ok: "yes", channel: preferred.channel, scopeLinks: preferred.scopeLinks };
        }
        // Never move a session to another file without being asked.
        return {
            ok: "no",
            errorCode: "CHANNEL_NOT_BOUND",
            errorMessage: `The file this session was editing (channel ${preferred.channel}) no longer has the plugin open. Ask the user to reopen the plugin there, or call channel_join with a link to pick another file.`,
            errorDetails: { channels },
        };
    }
    if (channels.length === 1) return { ok: "yes", channel: channels[0].channel };
    if (channels.length === 0) {
        return {
            ok: "no",
            errorCode: "CHANNEL_NOT_BOUND",
            errorMessage: "No Figma plugin is connected. Ask the user to open the FigmaMCP plugin in the file to edit, then retry.",
        };
    }
    return {
        ok: "no",
        errorCode: "CHANNEL_NOT_BOUND",
        errorMessage: `Several Figma files have the plugin open: ${describeChannels(channels)}. Call channel_join with a link to the file to edit.`,
        errorDetails: { channels },
    };
}

type ReleasedChannelContext =
    | { source: "client-join"; releasedChannel?: string }
    | { source: "join-attempt"; releasedChannel?: string };

function joinFailure(
    channel: string,
    error: any,
    releaseContext: ReleasedChannelContext,
) {
    // Change 13 (C13-F1): take one safe snapshot. A readable code/message must
    // not be lost merely because optional details are hostile, and no later
    // recovery/guidance step may re-read the untrusted origin object.
    const described = describeThrownForToolBoundary(error);
    const {
        hasExplicitCode,
        code: errorCode,
        message: originMessage,
        details: originDetails,
    } = described;
    const guidance = JOIN_RECOVERY.get(errorCode);
    // Codes without local guidance keep their originating message verbatim —
    // a D9 message already embeds its own recovery. This includes an explicit
    // UNKNOWN_ERROR from the plugin: only a code-less value gets the generic
    // fallback wrapper.
    const baseMessage = guidance
        ? guidance(channel, described)
        : hasExplicitCode
            ? originMessage
            : `An unexpected error occurred while joining the channel: ${originMessage}.`;

    // P9-F2: a failed join can only be attempted after releasing whatever
    // channel this session already held. Saying so in the always-visible
    // message — not only in errorDetails — is what keeps recovery to one round
    // trip when the cause was a mistyped channel code.
    // Both legs receive trusted attempt context, including authoritative
    // absence. Leg 1 reads a non-wire Symbol set only by joinChannel; leg 2
    // uses the local result metadata. Origin details can never fabricate it.
    const releasedCandidate = releaseContext.releasedChannel;
    const released = typeof releasedCandidate === "string"
        && releasedCandidate.length > 0
        ? releasedCandidate
        : undefined;
    const errorMessage = typeof released === "string" && released.length > 0
        ? `${baseMessage} This attempt also disconnected the previously joined channel '${released}'; call channel_join with '${released}' to restore it.`
        : baseMessage;
    const errorDetails = typeof released === "string" && released.length > 0
        ? releaseContext.source === "client-join"
            // joinChannel already merged and provenance-marked these details.
            ? originDetails
            : mergeReleasedChannelDetails(originDetails, released)
        : isolateUntrustedReleasedChannelDetails(originDetails);

    return {
        status: "error",
        channel,
        errorCode,
        errorMessage,
        ...(errorDetails !== undefined ? { errorDetails } : {}),
    };
}

/**
 * Codes an uncoded scope-payload (leg 2) failure as `CHANNEL_JOIN_FAILED`.
 *
 * Change 12 (C12-F1). `joinChannel` already codes leg 1's locally-generated
 * failures at origin (Q20), but leg 2 goes through the generic
 * `sendCommandToFigma` path, whose request timeout rejects with a plain `Error`.
 * The identical agent-visible outcome — the join failed, any previous binding
 * was released, and a rejoin is required — was therefore coded on leg 1 and
 * `UNKNOWN_ERROR` on leg 2. Live-reproduced on channel `gt93`.
 *
 * This is not coded at origin because `sendCommandToFigma` serves every tool;
 * a timeout there is not a join failure in general. Leg 2 is the layer that
 * knows the command was part of a join attempt.
 *
 * Q20 is preserved exactly: the test is the structural ABSENCE of a code, never
 * message prose, and any explicit code passes through untouched — including an
 * explicit `UNKNOWN_ERROR`, which C6-F4 established must keep its authored
 * message rather than being reclassified.
 */
function codeScopePayloadFailure(error: any) {
    const described = describeThrownForToolBoundary(error);
    if (described.hasExplicitCode) {
        const {
            hasExplicitCode: _hasExplicitCode,
            ...safeOrigin
        } = described;
        return safeOrigin;
    }
    return {
        code: "CHANNEL_JOIN_FAILED",
        message: described.message,
        details: { phase: "scope-payload" },
    };
}

async function detachAfterJoinFailure(
    resetChannel: typeof defaultResetChannel,
    releasedChannel?: string,
) {
    try {
        if (typeof releasedChannel === "string" && releasedChannel.length > 0) {
            await resetChannel({ releasedChannel });
        } else {
            await resetChannel();
        }
    } catch {
        // resetChannel clears the local binding before awaiting the socket leave
        // acknowledgement. Preserve the originating scope/transport failure;
        // the client remains fail-closed even if the bridge cannot acknowledge.
    }
}

async function performJoin(
    dependencies: ChannelToolDependencies,
    channel: string,
    scopeLinks: string[] | undefined,
): Promise<any> {
    const { joinChannel, sendCommandToFigma, resetChannel } = dependencies;
        try {
            let versions: { serverVersion: string; pluginVersion: string };
            let releasedChannel: string | undefined;
            try {
                const joined = await joinChannel(channel);
                versions = {
                    serverVersion: joined.serverVersion,
                    pluginVersion: joined.pluginVersion,
                };
                releasedChannel = joined.releasedChannel;
            } catch (error: any) {
                const releasedChannelRead =
                    error !== null && typeof error === "object"
                        ? readThrownProperty(
                            error,
                            JOIN_ATTEMPT_RELEASED_CHANNEL,
                        )
                        : { readable: false };
                const releasedChannel =
                    releasedChannelRead.readable
                    && typeof releasedChannelRead.value === "string"
                        ? releasedChannelRead.value
                        : undefined;
                return (joinFailure(channel, error, {
                    source: "client-join",
                    releasedChannel,
                }));
            }

            // Get connect payload
            let payload: any;
            try {
                payload = await sendCommandToFigma(
                    "get_connect_payload",
                    Array.isArray(scopeLinks) && scopeLinks.length > 0 ? { scopeLinks } : undefined,
                );
            } catch (error: any) {
                await detachAfterJoinFailure(resetChannel, releasedChannel);
                // C12-F1: an uncoded failure on this leg becomes
                // CHANNEL_JOIN_FAILED with its own phase, matching leg 1.
                return (joinFailure(channel, codeScopePayloadFailure(error), {
                    source: "join-attempt",
                    releasedChannel,
                }));
            }

            // Handle structured plugin error. `details` is forwarded when
            // present (P4-4 follow-up, 2026-07-23) — this leg previously
            // dropped it unconditionally, inconsistent with joinFailure()
            // below, which already relays `errorDetails` on the other leg.
            if (payload && payload.errorCode) {
                await detachAfterJoinFailure(resetChannel, releasedChannel);
                return (joinFailure(channel, {
                    code: payload.errorCode,
                    message: payload.errorMessage,
                    ...(payload.details !== undefined
                        ? { details: payload.details }
                        : {}),
                }, {
                    source: "join-attempt",
                    releasedChannel,
                }));
            }

            // Success path
            // `releasedChannel` is internal attempt metadata. A successful
            // scope read completes the switch, so do not expose it in the
            // public success envelope.
            lastJoin = { channel, ...(Array.isArray(scopeLinks) && scopeLinks.length > 0 ? { scopeLinks } : {}) };
            return ({
                ...payload,
                status: "success",
                channel,
                ...versions,
            });
        } catch (error: any) {
            const described = describeThrownForToolBoundary(error);
            return ({
                status: "error",
                channel,
                errorCode: UNKNOWN_ERROR,
                errorMessage: `An unexpected error occurred while joining the channel: ${described.message}.`
            });
        }
}

/**
 * Local patch (simple model): the auto-binder installed by server.ts. It runs
 * before a tool's first command while this session holds no live binding:
 * rejoin the last channel (with its scopeLinks) when that plugin is back,
 * else join the only connected plugin, else fail with a coded error that names
 * the open files. It never runs after a command frame was sent.
 */
async function noPluginOpen(listChannels: ListChannels): Promise<boolean> {
    try {
        return (await listChannels()).length === 0;
    } catch {
        return false;
    }
}

const PLUGIN_OPEN_POLLS = 20;
const PLUGIN_OPEN_POLL_MS = 500;

// The plugin needs a moment to start and connect after the app clicks the menu item.
async function openPluginThroughApp(
    dependencies: ChannelToolDependencies,
    listChannels: ListChannels,
    fallback: ChannelChoice,
): Promise<ChannelChoice> {
    const reply = await dependencies.openPlugin?.();
    if (!reply) return fallback;
    if (!reply.ok) {
        return { ok: "no", errorCode: "CHANNEL_NOT_BOUND", errorMessage: `FigmaMCP could not open the plugin. ${reply.message}` };
    }
    const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let poll = 0; poll < PLUGIN_OPEN_POLLS; poll++) {
        const chosen = await chooseChannel(listChannels, null);
        if (chosen.ok === "yes") return chosen;
        await sleep(PLUGIN_OPEN_POLL_MS);
    }
    return fallback;
}

export function createAutoBinder(dependencies: ChannelToolDependencies = defaultDependencies()) {
    const listChannels = dependencies.listChannels ?? defaultListChannels;
    return async () => {
        let chosen = await chooseChannel(listChannels, lastJoin);
        if (chosen.ok === "no" && !lastJoin && (await noPluginOpen(listChannels))) {
            chosen = await openPluginThroughApp(dependencies, listChannels, chosen);
        }
        if (chosen.ok === "no") {
            throw codedError(chosen.errorCode, chosen.errorMessage, chosen.errorDetails);
        }
        const result = await performJoin(dependencies, chosen.channel, chosen.scopeLinks);
        if (result.status !== "success") {
            throw codedError(result.errorCode, result.errorMessage, result.errorDetails);
        }
    };
}

export function registerChannelTools(
    server: McpServer,
    dependencies: ChannelToolDependencies = defaultDependencies(),
) {
    const { resetChannel } = dependencies;
    const listChannels = dependencies.listChannels ?? defaultListChannels;

    // 1. Join Channel Tool
    server.registerTool(
        "channel_join",
        {
            title: "Join Channel",
            description: "Bind this session to the Figma file that has the plugin open. Usually unnecessary: any tool binds automatically when exactly one file has the plugin open. Pass `link` (any Figma link to the file) to pick a file, or `channel` for a plugin that shows a 4-character code.",
            inputSchema: z.object({
                channel: z
                    .string()
                    // An empty channel name is detectable from the payload alone,
                    // so it is a Layer 1 schema rejection (the Q23 precedent), not
                    // a round trip to the handler. The `MISSING_CHANNEL` branch
                    // below is retained as defense in depth for non-conforming
                    // clients (the Q2 precedent), which is why it needs no
                    // error-playbook entry.
                    .min(1, "channel must not be empty. Omit it to bind to the only open plugin, or pass `link` (any Figma link to the file).")
                    .optional()
                    .describe("Channel name: the file key, or the 4-character code an older plugin shows. Optional: omit it and pass `link`, or pass neither to bind to the only open plugin."),
                link: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("Local patch (simple model): any Figma link to the file to edit; its file key names the channel."),
                scopeLinks: z
                    .array(z.string().min(1))
                    .max(20)
                    .optional()
                    .describe("Local patch (multi-MCP): Figma links or node IDs of the frames or pages this session will edit. Used only when the plugin allows several AI sessions. Each must be inside the editable scope the user set in the plugin and must not overlap another session's lease. Omit to take the implicit lease (everything not leased by others, plus variables and styles), or read-only if another session already holds it."),
                label: z
                    .string()
                    .max(80)
                    .optional()
                    .describe("Optional name for this session in the plugin panel. Omit it: the panel already shows the session title or working folder. Kept for later rejoins; stays on this computer."),
            }),
            outputSchema: looseOutput({
                status: z.enum(["success", "error"]).describe("Connection status"),
                channel: z.string().describe("Channel name"),
                errorCode: z.string().optional().describe("Error code if status is error"),
                errorMessage: z.string().optional().describe("Error message if status is error"),
                errorDetails: z.any().optional().describe("Structured error context if status is error and the underlying failure carried any"),
                serverVersion: z.string().optional().describe("Self-reported MCP server build version (present on every successful join)"),
                pluginVersion: z.string().optional().describe("Self-reported bound Figma plugin build version (present on every successful join)"),
                allowEditNode: z.union([z.boolean(), z.string()]).optional().describe("false | 'document' | 'page' | 'node'"),
                allowEditVariable: z.boolean().optional().describe("Whether variable edits are allowed"),
                allowEditStyle: z.boolean().optional().describe("Whether style edits are allowed"),
                editableScopeType: z.string().optional().describe("readonly, document, page, or node"),
                additionalScopeRoots: z.array(z.object({
                    nodeId: z.string(),
                    nodeName: z.string().nullable(),
                    type: z.string().nullable(),
                })).optional().describe("Local patch: extra editable roots linked at connect time (a node under any of them is in scope; node_clone may place copies there)"),
                lease: z.object({
                    kind: z.enum(["explicit", "implicit", "readOnly"]),
                    roots: z.array(z.object({
                        nodeId: z.string(),
                        nodeName: z.string().nullable(),
                        type: z.string().nullable(),
                    })),
                }).optional().describe("Local patch (multi-MCP): this session's lease inside the editable scope. Absent when the relay does not stamp sessions (single-session mode)."),
                scopeRootId: z.string().nullable().optional().describe("Editable scope root node ID"),
                documentId: z.string().optional().describe("Figma document ID"),
                documentName: z.string().optional().describe("Figma document name"),
                pageCount: z.number().optional().describe("Number of pages in the document"),
                pages: z.array(z.object({
                    pageId: z.string(),
                    pageName: z.string(),
                    descendantCount: z.number().optional(),
                    children: z.array(z.object({
                        id: z.string(),
                        name: z.string(),
                        type: z.string()
                    })).optional()
                })).optional(),
                node: z.object({
                    nodeId: z.string(),
                    nodeName: z.string(),
                    type: z.string(),
                    path: z.array(z.array(z.string())).optional(),
                    descendantCount: z.number().optional(),
                    children: z.array(z.object({
                        id: z.string(),
                        name: z.string(),
                        type: z.string()
                    })).optional()
                }).optional()
            }),
            annotations: {
                idempotentHint: true,
                openWorldHint: true
            }
        },
        async ({ channel, link, scopeLinks, label }: any) => {
            if (typeof label === "string") identityProvider?.setExplicitLabel(label);
            let target: string | null = typeof channel === "string" && channel.length > 0 ? channel : null;
            if (!target && typeof link === "string" && link.length > 0) {
                target = fileKeyFromLink(link);
                if (!target) {
                    return toolResult({
                        status: "error",
                        channel: "",
                        errorCode: "MISSING_CHANNEL",
                        errorMessage: `'${link}' is not a Figma file link. Pass a link like https://www.figma.com/design/<fileKey>/...`,
                    });
                }
            }
            if (!target) {
                const chosen = await chooseChannel(listChannels, null);
                if (chosen.ok === "no") {
                    return toolResult({ status: "error", channel: "", errorCode: chosen.errorCode, errorMessage: chosen.errorMessage, ...(chosen.errorDetails !== undefined ? { errorDetails: chosen.errorDetails } : {}) });
                }
                target = chosen.channel;
            }
            return toolResult(await performJoin(dependencies, target, scopeLinks));
        }
    );

    // Local patch (multi-MCP): release this session's channel binding, and
    // with it the plugin-side lease, without closing the socket.
    server.registerTool(
        "channel_leave",
        {
            title: "Leave Channel",
            description: "Leave the current plugin channel. Frees this session's lease so another AI session can take that area. A later channel_join reconnects.",
            inputSchema: z.object({}),
            outputSchema: looseOutput({
                status: z.enum(["success", "error"]),
                errorCode: z.string().optional(),
                errorMessage: z.string().optional(),
            }),
            annotations: { idempotentHint: true, openWorldHint: true },
        },
        async () => {
            // An explicit leave ends the session's claim on that file.
            lastJoin = null;
            try {
                await resetChannel();
                return toolResult({ status: "success" });
            } catch (error: any) {
                const described = describeThrownForToolBoundary(error);
                return toolResult({
                    status: "error",
                    errorCode: UNKNOWN_ERROR,
                    errorMessage: `Leaving the channel failed: ${described.message}. The local binding is cleared; the socket was closed to release the relay reservation.`,
                });
            }
        }
    );
}
