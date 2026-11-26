/**
 * Figma Plugin Main Entry Point
 * This file bundles all handlers and utilities for the Figma plugin
 */

// Import utilities
import { generateCommandId, sendProgressUpdate, setActiveRequestId } from '../utils/progressUtils.js';
import { sanitizeForPostMessage } from '../utils/sanitize.js';
import { bottomRightPosition } from '../utils/panelPlacement.js';
import { loadInstallId } from '../utils/installId.js';
import { createFirstRun } from '../utils/firstRun.js';
import { createUsageCounter } from '../utils/usageCounter.js';
import { createStaleTakeover, createUsageStore } from '../utils/usageStore.js';
import { findInstanceAncestor, assertNotLocked, assertNotInstanceInterior, assertNotInstanceParent } from '../utils/nodeUtils.js';
import { ERRORS, REFUSALS, formatScopeError as formatScopeErrorForRoot, getStructuredError, notifyBestEffort } from '../utils/errors.js';

// Import handlers
import { getNodesInfo, getPagesInfo } from '../handlers/nodeReaders.js';
import { createShape, createFrame, createText, cloneNode } from '../handlers/nodeCreators.js';
import { transformNode, deleteMultipleNodes, viewNavigate, setNodeName, groupNodes, ungroupNodes, flattenNode, insertChild } from '../handlers/nodeModifiers.js';
import { setFillColor, setStroke, setCornerRadius, setEffects } from '../handlers/stylingHandlers.js';

import { setAutoLayout } from '../handlers/layoutHandlers.js';
import {
    getStyles,
    getComponents,
    createComponentInstance,
    exportNodeAsImage,
    getInstanceOverrides,
    getValidTargetInstances,
    getSourceInstanceData,
    setInstanceOverrides,
    createComponent,
    createComponentSet,
    validateCreateComponentSetPlan,
    setComponentInstanceProperty,
    manageComponentProperty,
    deleteComponentProperty
} from '../handlers/componentHandlers.js';

import { getReactions, updateReactions } from '../handlers/prototypingHandlers.js';
import { setMultipleTextContents, setTextStyle } from '../handlers/textHandlers.js';
import { getAnnotations, setMultipleAnnotations } from '../handlers/annotationHandlers.js';
import { getVariables, setBoundVariable, handleVariableRequest, deleteVariables } from '../handlers/variableHandlers.js';
import { createStyle, applyStyle, deleteStyle } from '../handlers/styleHandlers.js';
import { createNodeFromSvg } from '../handlers/vectorHandlers.js';
import { getConnectPayload } from '../handlers/connectHandlers.js';
import { parseNodeIdFromUrl } from '../utils/scopeLink.js';


// Plugin state
const state: any = {
    serverPort: 3155, // Default port
    scopeRootId: null,
    // Local patch (cross-page node_clone): extra editable roots linked at
    // connect time. A node is in scope when it sits under the primary root OR
    // under any of these. Empty by default, so a single-link connection keeps
    // the original one-root behaviour.
    additionalScopeRootIds: [] as string[],
    // Local patch (multi-MCP): per-MCP-peer leases inside the editable scope
    // (the "ceiling" the human set in the UI). Keyed by the relay's MCP peer id.
    //   explicit: the peer claimed rootIds at join; it may write only under
    //             them, and no other peer may write there.
    //   implicit: no claim; the peer may write anywhere in the ceiling except
    //             under another peer's explicit lease. Several peers may hold
    //             it at once (simple model: shared write, like several
    //             editors on one file; nodeName verification guards each write).
    //   readOnly: the plugin itself is read-only for nodes.
    leases: new Map<string, { kind: "explicit" | "implicit" | "readOnly"; rootIds: string[] }>(),
    allowEditNode: false, // false | "document" | "page" | "node"
    allowEditVariable: false,
    allowEditStyle: false
};

export function getPluginState() {
    return state;
}

// Helper: Format error message with current scope ID
function formatScopeError(errorMessage: any) {
    return formatScopeErrorForRoot(errorMessage, state.scopeRootId);
}

// Local patch (multi-MCP): the MCP peer whose command is executing. Commands
// run one at a time (state.commandQueue), so a module variable is safe. null =
// unstamped command (old relay, unit tests): treated like an implicit lease.
let currentPeerId: string | null = null;
export function setCurrentPeerId(peerId: string | null) { currentPeerId = peerId; }

// Verdict for the current peer on a node, given the node's ancestor chain
// (node itself first). Throws LEASED_BY_OTHER_SESSION for another peer's area.
function peerScopeVerdict(nodeId: string, chainIds: string[]): boolean {
    if (!chainIds.some((id) => isScopeRootId(id))) return false;
    // Unstamped command (old relay, single session): the ceiling alone decides.
    if (!currentPeerId) return true;
    const leases: Map<string, any> = state.leases;
    // Another session's area first, so the refusal names the real cause.
    for (const [peerId, lease] of leases) {
        if (peerId === currentPeerId || lease.kind !== "explicit") continue;
        const hit = lease.rootIds.find((r: string) => chainIds.includes(r));
        if (hit) throw REFUSALS.LEASED_BY_OTHER_SESSION(nodeId, hit);
    }
    const own = leases.get(currentPeerId);
    if (leases.size > 0 && !own) return false;
    if (own && own.kind === "readOnly") return false;
    if (own && own.kind === "explicit" && !own.rootIds.some((r: string) => chainIds.includes(r))) return false;
    return true;
}

// Local patch (multi-MCP): variables and styles are document-wide, so leases
// cannot partition them. Only the implicit holder may write them while other
// sessions are connected; a lone session (or an unstamped command) may too.
function assertDocumentWideWriteAllowed() {
    if (!currentPeerId) return;
    const leases: Map<string, any> = state.leases;
    const own = leases.get(currentPeerId);
    if (own && own.kind === "implicit") return;
    const others = [...leases.keys()].filter((p) => p !== currentPeerId);
    if (others.length === 0) return;
    throw REFUSALS.DOCUMENT_WIDE_WRITE_LOCKED();
}

function isLeaseRootId(id: string): boolean {
    for (const lease of (state.leases as Map<string, any>).values()) {
        if (lease.rootIds.includes(id)) return true;
    }
    return false;
}

// Helper: Is this id one of the editable scope roots (primary or additional)?
function isScopeRootId(id: string): boolean {
    if (id === state.scopeRootId) return true;
    return Array.isArray(state.additionalScopeRootIds) && state.additionalScopeRootIds.includes(id);
}

// Helper: Check if a node is within the allowed scope
async function checkScopeAccess(nodeId: any) {
    if (!state.allowEditNode) return false;

    // If scope is not set, we assume restricted access (deny) unless strict flow says otherwise.
    // However, based on the flow: "Empty -> Read-Only", "Link -> Scoped".
    // So if we are NOT read-only, we MUST have a scopeRootId.
    if (!state.scopeRootId) return false;

    // Check if scope root still exists
    const scopeNode = await figma.getNodeByIdAsync(state.scopeRootId);
    if (!scopeNode) {
        throw new Error(`${ERRORS.SCOPE_DELETED} (Missing Scope Node ID: ${state.scopeRootId})`);
    }

    let node = await figma.getNodeByIdAsync(nodeId);
    // Be robust against missing nodes
    if (!node) return false;

    // Traverse up, then judge against the ceiling and the peer leases.
    const chain: string[] = [];
    for (let curr: BaseNode | null = node; curr; curr = curr.parent) chain.push(curr.id);
    return peerScopeVerdict(node.id, chain);
}

// Helper: Reference-based scope check (Phase 4 additive helper)
function checkScopeAccessRef(node: BaseNode, scopeRootNode: BaseNode): boolean {
    if (!state.allowEditNode) return false;
    const chain: string[] = [];
    for (let curr: BaseNode | null = node; curr; curr = curr.parent) chain.push(curr.id);
    return peerScopeVerdict(node.id, chain);
}

// Helper: Verify node name matches expected name
async function verifyNodeName(nodeId: any, expectedName: any) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) return false; // Node existence checking should happen elsewhere usually, but if missing here, it's a mismatch technically.

    // Block operation if expectedName is not provided
    if (expectedName === undefined || expectedName === null) {
        return false;
    }

    return node.name === expectedName;
}

// Helper: Assert node is not the scope root
function assertNotScopeRoot(nodeId: string) {
    if (isScopeRootId(nodeId) || isLeaseRootId(nodeId)) {
        throw new Error(`Operation Denied: This node is the current Editable Scope root; deleting/flattening/ungrouping/converting it would invalidate the scope for the rest of the session. Re-scope to a parent first, or ask the user to select a different Editable Scope.`);
    }
}

// Local patch (simple model): pages and the document root are file structure,
// not content. Under a whole-document scope every page is "in scope", so the
// structural tools must refuse them explicitly instead of relying on the page
// being the scope root. Page create/delete stays a human step in Figma.
function assertNotPageOrDocument(node: BaseNode, verb: string) {
    if (node.type === "PAGE" || node.type === "DOCUMENT") {
        throw new Error(`Operation Denied: '${node.name}' is a ${node.type === "PAGE" ? "page" : "document root"} and cannot be ${verb} through figmamcp. Ask the user to do it in Figma.`);
    }
}

// Local patch (simple model): only pages may sit directly under the document
// root, and figmamcp has no page create tool, so the document root is never
// a valid destination parent.
function assertParentNotDocument(parent: BaseNode) {
    if (parent.type === "DOCUMENT") {
        throw new Error(`Operation Denied: the document root cannot be a destination parent. Pass a page, frame or section as the parent.`);
    }
}

// Helper: Unified single-node write validation
async function validateSingleNodeWrite(params: any, options: { checkScopeRoot?: boolean, checkLocked?: boolean, instanceCheckVerb?: string, checkRemoteAsset?: boolean }) {
    if (!state.allowEditNode) throw new Error(ERRORS.READ_ONLY_MODE);
    if (!(await checkScopeAccess(params ? params.nodeId : null))) throw new Error(formatScopeError(ERRORS.OUTSIDE_SCOPE));
    if (!(await verifyNodeName(params ? params.nodeId : null, params ? params.nodeName : null))) throw new Error(ERRORS.NAME_MISMATCH);
    const node = await figma.getNodeByIdAsync(params?.nodeId);
    if (node) {
        if (options.checkScopeRoot) {
            assertNotScopeRoot(node.id);
            assertNotPageOrDocument(node, options.instanceCheckVerb || "changed");
        }
        if (options.checkLocked) assertNotLocked(node);
        if (options.instanceCheckVerb) assertNotInstanceInterior(node, options.instanceCheckVerb);
        if (options.checkRemoteAsset && ('remote' in node) && (node as any).remote === true) {
            throw new Error(`Operation Denied: '${node.name}' is a remote library asset (style/variable/component) and is read-only in this file. Edit it in its source library.`);
        }
    }
}

// Helper: Unified parent-write validation
async function validateParentWrite(params: any, options: { checkLocked?: boolean, instanceCheckVerb?: string }) {
    if (!state.allowEditNode) throw new Error(ERRORS.READ_ONLY_MODE);
    if (!(await checkScopeAccess(params ? params.parentId : null))) throw new Error(formatScopeError(ERRORS.PARENT_OUTSIDE_SCOPE));
    await verifyParentNameOrThrow(params ? params.parentId : null, params ? params.parentNodeName : null);
    const parent = await figma.getNodeByIdAsync(params?.parentId);
    if (parent) {
        assertParentNotDocument(parent);
        if (options.checkLocked) assertNotLocked(parent);
        if (options.instanceCheckVerb) assertNotInstanceParent(parent, options.instanceCheckVerb);
    }
}

// Helper: Verify parent name matches expected name, throwing the coded D6
// refusal (Q22, Rev 31) with distinct causes — missing vs. mismatched — so an
// agent that omits the name is not steered into swapping a correct parentId.
// Defense in depth: the server schema already requires parentNodeName, so a
// conforming client never reaches the "missing" branch.
async function verifyParentNameOrThrow(parentId: any, expectedParentName: any) {
    // C9: omission is nullish (undefined/null), not falsy — a present empty
    // string is a real value (a parent legitimately named "") and must be
    // compared exactly, so "" against a non-empty parent is MISMATCH, not
    // MISSING, and an empty-named parent can still be targeted.
    if (expectedParentName == null) throw REFUSALS.PARENT_NAME_MISSING();
    const node = await figma.getNodeByIdAsync(parentId);
    if (!node || node.name !== expectedParentName) {
        throw REFUSALS.PARENT_NAME_MISMATCH(node ? node.name : "(parent not found)", expectedParentName);
    }
}

// Defense-in-depth duplicate-target guard for the batch tools (Q23 Option B /
// ratification 6). The first-class rejection is the schema `.superRefine()` on
// the batch inputs, so a conforming client never reaches this; a non-conforming
// client that bypasses the schema still fails closed. Both throws are prose on
// the UNKNOWN_ERROR fallback (legacy surface, v2.3.4 burn-down) — no new code is
// minted here. Node-ID spellings are normalized (`1-2` vs `1:2`) before compare.
function assertNoDuplicateTargets(items: any[]) {
    const seen = new Set<string>();
    for (const item of items) {
        if (!item || !item.nodeId) throw new Error("Missing nodeId parameter");
        const normalizedId = String(item.nodeId).replace(/-/g, ":");
        if (seen.has(normalizedId)) {
            throw new Error(`Operation Denied: Duplicate node ID detected: ${item.nodeId}. Batches must not contain duplicate targets.`);
        }
        seen.add(normalizedId);
    }
}

// Helper: Clone node validation
async function validateCloneWrite(params: any) {
    if (!state.allowEditNode) throw new Error(ERRORS.READ_ONLY_MODE);
    if (!params || !params.nodeId) throw new Error("Missing nodeId parameter");

    const source = await figma.getNodeByIdAsync(params.nodeId);
    if (!source) {
        throw new Error(`Node not found with ID: ${params.nodeId}`);
    }

    // Check source scope
    if (!(await checkScopeAccess(source.id))) {
        throw new Error(formatScopeError(ERRORS.CLONING_SOURCE_NODE_OUTSIDE_SCOPE));
    }
    // Verify source name matches expected name
    if (!(await verifyNodeName(source.id, params.nodeName))) {
        throw new Error(ERRORS.NAME_MISMATCH);
    }

    // Reject locked source nodes and locked ancestors
    assertNotLocked(source);

    // Reject source nodes inside component-instance interiors
    const sourceInstanceAncestor = findInstanceAncestor(source);
    if (sourceInstanceAncestor) {
        throw new Error(`Operation Denied: Cannot clone '${source.name}' because it is inside a component instance.`);
    }

    // Require source.parent
    const sourceParent = source.parent;
    if (!sourceParent) {
        throw new Error(`node_clone: '${source.name}' has no parent and cannot be cloned.`);
    }

    // Local patch (cross-page node_clone): an explicit destination parent may be
    // given; it must carry its verified name, exactly like the create_* tools.
    // Without it the destination stays the source's own parent.
    let parent: any = sourceParent;
    if (params.parentId !== undefined && params.parentId !== null) {
        await verifyParentNameOrThrow(params.parentId, params.parentNodeName);
        parent = await figma.getNodeByIdAsync(params.parentId);
        if (!parent) {
            throw new Error(`node_clone: destination parent not found with ID: ${params.parentId}`);
        }
    }

    // Require an appendable destination parent. The typings make this guard statically unreachable
    // (source.parent is (BaseNode & ChildrenMixin) | null, so every non-null parent has appendChild);
    // it is kept as runtime defense in depth — do not delete as dead code. The inline cast avoids the
    // never-narrowing a direct check would produce. (v2.3.3 PRD Rev 21)
    if (!("appendChild" in (parent as BaseNode))) {
        throw new Error(`node_clone: parent '${parent.name}' (type ${parent.type}) cannot accept cloned children.`);
    }

    assertParentNotDocument(parent);

    // Reject destination parents outside the current scope, including the scope-root clone case
    if (!(await checkScopeAccess(parent.id))) {
        throw new Error(formatScopeError(ERRORS.PARENT_OUTSIDE_SCOPE));
    }

    // Reject locked destination parents and locked ancestors
    assertNotLocked(parent);

    // Reject destination parents that are an INSTANCE node or inside an instance interior
    assertNotInstanceParent(parent, "appended to");
}


// Scope-link parsing lives in utils/scopeLink.ts so it is testable without
// importing this module's Figma UI bindings (see that file for the Phase 14
// no-`URL` measurement that removed the dead `new URL()` branch).

// Local patch (multi-MCP): give the joining peer its lease. Returns a
// connect-payload error object, or null on success. Unstamped joins (old relay,
// tests) take no lease, so single-session behaviour is unchanged.
function leaseFailure(refusal: { code: string; message: string; details?: any }) {
    return { errorCode: refusal.code, errorMessage: refusal.message, ...(refusal.details ? { details: refusal.details } : {}) };
}

export async function acquireLease(peerId: string | null, scopeLinks: any): Promise<null | { errorCode: string; errorMessage: string; details?: any }> {
    if (!peerId) return null;
    const leases: Map<string, any> = state.leases;
    leases.delete(peerId); // a rejoin replaces the old lease
    const links: string[] = Array.isArray(scopeLinks) ? scopeLinks.map((l: any) => String(l).trim()).filter((l: string) => l) : [];
    if (!state.allowEditNode) {
        if (links.length > 0) return leaseFailure(REFUSALS.SCOPE_LEASE_REFUSED("the plugin is connected read-only for nodes, so no editing area can be leased"));
        leases.set(peerId, { kind: "readOnly", rootIds: [] });
        return null;
    }
    if (links.length === 0) {
        // Local patch (simple model): no claim = shared write. A second
        // session without scopeLinks used to get readOnly.
        leases.set(peerId, { kind: "implicit", rootIds: [] });
        return null;
    }
    const rootIds: string[] = [];
    for (const link of links) {
        const id = parseNodeIdFromUrl(link) || (/^\d+:\d+$/.test(link) ? link : null);
        if (!id) return leaseFailure(REFUSALS.SCOPE_LEASE_REFUSED("not a Figma link or node id", link));
        const node = await figma.getNodeByIdAsync(id);
        if (!node || node.type === "DOCUMENT") return leaseFailure(REFUSALS.SCOPE_LEASE_REFUSED(`node "${id}" not found or not leasable`, link));
        const chain: string[] = [];
        for (let curr: BaseNode | null = node; curr; curr = curr.parent) chain.push(curr.id);
        if (!chain.some((c) => isScopeRootId(c))) return leaseFailure(REFUSALS.SCOPE_LEASE_REFUSED(`node "${id}" is outside the editable scope the user set in the plugin`, link));
        for (const [otherPeer, lease] of leases) {
            if (lease.kind !== "explicit") continue;
            for (const other of lease.rootIds) {
                const otherNode = await figma.getNodeByIdAsync(other);
                const otherChain: string[] = [];
                for (let curr: BaseNode | null = otherNode; curr; curr = curr.parent) otherChain.push(curr.id);
                if (chain.includes(other) || otherChain.includes(id)) {
                    return leaseFailure(REFUSALS.LEASED_BY_OTHER_SESSION(id, other));
                }
            }
            void otherPeer;
        }
        if (!rootIds.includes(id)) rootIds.push(id);
    }
    leases.set(peerId, { kind: "explicit", rootIds });
    return null;
}

export function getCurrentLease() {
    return currentPeerId ? (state.leases as Map<string, any>).get(currentPeerId) : undefined;
}

// Local patch (cross-page node_clone): turn the optional extra scope links
// into node ids. Rules: extra roots need a primary root (no extras in read-only
// mode); every link must parse and resolve; the document root is never an
// editable root (that would make every page writable).
export async function resolveAdditionalScopeRoots(
    links: string[],
    primaryId: string | null | undefined,
): Promise<{ ok: true; ids: string[] } | { ok: false; reason: string }> {
    if (links.length === 0) return { ok: true, ids: [] };
    if (!primaryId) {
        return { ok: false, reason: "Additional editable roots need a primary 'Link to Selection'. Add one, or clear the additional links for Read-Only mode." };
    }
    const ids: string[] = [];
    for (const link of links) {
        const id = parseNodeIdFromUrl(link);
        if (!id) return { ok: false, reason: `Invalid Figma URL in additional editable roots: ${link}` };
        const node = await figma.getNodeByIdAsync(id);
        if (!node) return { ok: false, reason: `Additional editable root not found in current document: ${id}` };
        if (node.type === "DOCUMENT") return { ok: false, reason: "The document root cannot be an editable root. Link a page or a layer." };
        if (id !== primaryId && !ids.includes(id)) ids.push(id);
    }
    return { ok: true, ids };
}

declare const __PLUGIN_VERSION__: string;
// Fallback must NOT be a version literal — that would be a fifth hardcoded
// version surface, the exact drift class D2 eliminates. "unknown" surfaces a
// broken define instead of silently reporting a stale version.
const PLUGIN_VERSION = typeof __PLUGIN_VERSION__ !== "undefined" ? __PLUGIN_VERSION__ : "unknown";

// Show UI
// themeColors: the panel uses Figma's --figma-color-* variables, so it follows
// light and dark. The UI measures its content and asks for the height (resize-ui).
figma.showUI(__html__, { width: 280, height: 96, themeColors: true });

// Local patch (simple model): the file key names the channel, so an agent that
// has the file's link can find this plugin without a code. figma.fileKey needs
// "enablePrivatePluginApi" in manifest.json (works for development plugins);
// without it the value is undefined and the UI falls back to a random code.
function readFileKey(): string | null {
    try {
        const key = (figma as any).fileKey;
        return typeof key === "string" && /^[A-Za-z0-9]{6,64}$/.test(key) ? key : null;
    } catch (_e) {
        return null;
    }
}

// Post version to UI on startup
function readFileName(): string | null {
    try {
        return figma.root && typeof figma.root.name === "string" ? figma.root.name : null;
    } catch (_e) {
        return null;
    }
}
figma.ui.postMessage({ type: "plugin-version", version: PLUGIN_VERSION, fileKey: readFileKey(), fileName: readFileName(), rootId: figma.root ? figma.root.id : null });
// The UI sends the load count once it has the install ID (or after a short wait without one).
const installIdPosted = loadInstallId(figma.clientStorage).then((installId) => figma.ui.postMessage({ type: "install-id", installId }));
// First-run hint in the panel: shown until the first successful tool call in this install.
const firstRun = createFirstRun(figma.clientStorage, (pending) => figma.ui.postMessage({ type: "first-run", pending }));
firstRun.load();

// Local patch (simple model): Figma has no rename event, so while the panel is connected (the UI starts and
// stops this) check the file name every 2 seconds and tell the UI when it changes. A rename made while
// disconnected is caught on the first check after reconnecting, because lastFileName is not reset.
let lastFileName = readFileName();
let fileNameTimer: ReturnType<typeof setInterval> | null = null;
function watchFileName(on: boolean) {
    if (fileNameTimer !== null) {
        clearInterval(fileNameTimer);
        fileNameTimer = null;
    }
    if (!on) return;
    fileNameTimer = setInterval(() => {
        const name = readFileName();
        if (name !== lastFileName) {
            lastFileName = name;
            figma.ui.postMessage({ type: "file-name", fileName: name });
        }
    }, 2000);
}
// Selection and page changes mean the user is working in this file, so it is listed first.
const reportFileActive = () => figma.ui.postMessage({ type: "file-active" });
figma.on("selectionchange", reportFileActive);
figma.on("currentpagechange", reportFileActive);

// Plugin commands from UI
// Anonymous usage counts (timing in usageCounter.ts): the first call of a session at once, then 15 s after
// the first unsent call and at most once a minute, or at once every 20 calls. Unsent counts and reports the UI
// has not confirmed are kept in clientStorage and sent on the next start, or by another open plugin within a minute
// once they are 5 min old. The close-time flush is best effort.
// Each open copy of the plugin saves under its own key; see usageStore.ts.
let usageSessionId = "";
for (let i = 0; i < 12; i++) usageSessionId += Math.floor(Math.random() * 16).toString(16);
const usageStore = createUsageStore(figma.clientStorage, { sessionId: usageSessionId });
const usage = createUsageCounter({
    send: (query, id) => figma.ui.postMessage({ type: "usage", query, id }),
    save: usageStore.save,
});
// Counts left by closed plugins: checked at start and every 60 s while this one is open.
// It starts after the UI has the install ID, so re-sent reports are not dropped for want of it.
const usageTakeover = createStaleTakeover({ store: usageStore, restore: usage.restore });
installIdPosted.then(() => usageTakeover.start()).catch(() => {});
figma.on("close", () => {
    usageTakeover.stop();
    usage.flush();
});

figma.ui.onmessage = async (msg: any) => {
    switch (msg.type) {
        case "update-settings":
            updateSettings(msg);
            break;
        case "notify":
            notifyBestEffort(msg.message);
            break;
        case "resize-ui":
            // The panel never scrolls: it reports its content height on every change.
            if (typeof msg.height === "number" && Number.isFinite(msg.height)) {
                const width = typeof msg.width === "number" && Number.isFinite(msg.width)
                    ? Math.min(Math.max(Math.ceil(msg.width), 70), 280)
                    : 280;
                const height = Math.min(Math.max(Math.ceil(msg.height), 24), 600);
                figma.ui.resize(width, height);
                // Once collapsed, the window lives in the bottom-right corner,
                // expanded or not, so it stays out of the way of the design.
                if (msg.anchor === "bottom-right") {
                    try {
                        const p = bottomRightPosition(figma.viewport.bounds, figma.viewport.zoom, width, height);
                        figma.ui.reposition(p.x, p.y);
                    } catch (_e) {
                        // Older Figma without reposition: keep the window where it is.
                    }
                }
            }
            break;
        case "watch-file-name":
            watchFileName(msg.on === true);
            break;
        case "usage-sent":
            usage.ack(msg.id);
            break;
        case "close-plugin":
            usage.flush();
            figma.closePlugin();
            break;
        case "validate-scope-link":
            const nodeId = parseNodeIdFromUrl(msg.link);
            if (!nodeId) {
                figma.ui.postMessage({ type: "scope-validation-result", valid: false, reason: "Invalid Figma URL" });
                return;
            }
            const node = await figma.getNodeByIdAsync(nodeId);
            if (node) {
                figma.ui.postMessage({
                    type: "scope-validation-result",
                    valid: true,
                    nodeName: node.name,
                    nodeId: node.id,
                    nodeType: node.type
                });
            } else {
                figma.ui.postMessage({ type: "scope-validation-result", valid: false, reason: "Node not found in current document" });
            }
            break;
        case "set-scope": {
            // Local patch (cross-page node_clone): resolve the optional extra
            // scope links BEFORE committing any state, and fail closed — a bad
            // link refuses the whole connection instead of silently narrowing it.
            const additionalLinks: string[] = Array.isArray(msg.additionalScopeLinks)
                ? msg.additionalScopeLinks.map((l: any) => String(l).trim()).filter((l: string) => l.length > 0)
                : [];
            // Local patch (simple model): the whole document is one scope; extra
            // roots inside it would be redundant, so they are ignored.
            const documentScope = msg.scopeNodeType === "DOCUMENT" && msg.scopeNodeId === figma.root.id;
            const additional = documentScope
                ? { ok: true as const, ids: [] as string[] }
                : await resolveAdditionalScopeRoots(additionalLinks, msg.scopeNodeId);
            if (!additional.ok) {
                figma.ui.postMessage({ type: "scope-rejected", requestId: msg.requestId, reason: additional.reason });
                break;
            }
            if (msg.scopeNodeId) {
                state.scopeRootId = msg.scopeNodeId;
                state.additionalScopeRootIds = additional.ids;
                state.leases.clear();
                state.allowEditNode = documentScope ? "document" : (msg.scopeNodeType === "PAGE" ? "page" : "node");
                state.allowEditVariable = !!msg.allowEditVariable;
                state.allowEditStyle = !!msg.allowEditStyle;
                notifyBestEffort(additional.ids.length > 0
                    ? `Scope locked to nodes: ${[msg.scopeNodeId, ...additional.ids].join(", ")}`
                    : `Scope locked to node: ${msg.scopeNodeId}`);
            } else {
                state.scopeRootId = null;
                state.additionalScopeRootIds = [];
                state.leases.clear();
                state.allowEditNode = false;
                state.allowEditVariable = !!msg.allowEditVariable;
                state.allowEditStyle = !!msg.allowEditStyle;
                notifyBestEffort("Connected in Read-Only Mode for nodes");
            }
            // Scope readiness is authoritative here, after every permission
            // field is committed. The UI must match this one-shot request ID
            // before it opens and joins the WebSocket.
            figma.ui.postMessage({
                type: "scope-ready",
                requestId: msg.requestId,
                pluginVersion: PLUGIN_VERSION,
            });
            break;
        }
        case "execute-command":
            // Execute commands received from UI (which gets them from WebSocket)
            // Use a promise chain (queue) to serialize execution and prevent race conditions
            state.commandQueue = (state.commandQueue || Promise.resolve()).then(async () => {
                setCurrentPeerId(typeof msg.peerId === "string" ? msg.peerId : null);
                setActiveRequestId(typeof msg.id === "string" ? msg.id : null);
                try {
                    const result = await handleCommand(msg.command, msg.params);
                    const errorCode = result && typeof result === "object" ? (result as any).errorCode : undefined;
                    usage.record(msg.command, !errorCode, errorCode);
                    if (!errorCode) firstRun.noteSuccess();
                    // Send result back to UI. Sanitize first: any field that is
                    // figma.mixed (a Symbol) — or any other non-cloneable — would
                    // otherwise throw "Cannot unwrap symbol" on postMessage and
                    // fail a command whose mutation already succeeded.
                    figma.ui.postMessage({
                        type: "command-result",
                        id: msg.id,
                        result: sanitizeForPostMessage(result),
                    });
                } catch (error: any) {
                    usage.record(msg.command, false, typeof error?.code === "string" ? error.code : "THROWN");
                    figma.ui.postMessage({
                        type: "command-error",
                        id: msg.id,
                        error: getStructuredError(error),
                    });
                } finally {
                    setCurrentPeerId(null);
                    setActiveRequestId(null);
                }
            });
            break;
        case "peer-left":
            // Local patch (multi-MCP): the relay told the UI an MCP peer left;
            // free its lease. Queued so it cannot interleave with a command.
            state.commandQueue = (state.commandQueue || Promise.resolve()).then(() => {
                if (typeof msg.peerId === "string") state.leases.delete(msg.peerId);
            });
            break;
    }
};

// Listen for plugin commands from menu
figma.on("run", ({ command }: any) => {
    // Auto-connect removed to enforce Scope Selection workflow.
    // figma.ui.postMessage({ type: "auto-connect" });
});

// Update plugin settings
function updateSettings(settings: any) {
    if (settings.serverPort) {
        state.serverPort = settings.serverPort;
    }

    figma.clientStorage.setAsync("settings", {
        serverPort: state.serverPort,
    });
}

// Handle commands from UI
async function handleCommand(command: any, params: any) {
    switch (command) {
        case "get_connect_payload": {
            const leaseError = await acquireLease(currentPeerId, params && params.scopeLinks);
            if (leaseError) return leaseError;
            const payload: any = await getConnectPayload();
            // Local patch (multi-MCP): report this session's lease.
            const lease = getCurrentLease();
            if (lease && payload && !payload.errorCode) {
                const roots: any[] = [];
                for (const id of lease.rootIds) {
                    const n = await figma.getNodeByIdAsync(id);
                    roots.push({ nodeId: id, nodeName: n ? n.name : null, type: n ? n.type : null });
                }
                payload.lease = { kind: lease.kind, roots };
            }
            return payload;
        }
        case "node_set_fill":
            await validateSingleNodeWrite(params, { checkLocked: true });
            return await setFillColor(params);
        case "node_set_stroke":
            await validateSingleNodeWrite(params, { checkLocked: true });
            return await setStroke(params);
        case "node_set_corner_radius":
            await validateSingleNodeWrite(params, { checkLocked: true });
            return await setCornerRadius(params);
        case "node_set_auto_layout":
            await validateSingleNodeWrite(params, { checkLocked: true });
            return await setAutoLayout(params);
        case "node_bind_variable":
            await validateSingleNodeWrite(params, { checkLocked: true });
            return await setBoundVariable(params);
        case "node_rename":
            await validateSingleNodeWrite(params, { checkLocked: true });
            return await setNodeName(params);

        case "node_group":
            if (!state.allowEditNode) throw new Error(ERRORS.READ_ONLY_MODE);
            if (!params || !params.nodes || !Array.isArray(params.nodes)) throw new Error("Missing or Invalid nodes parameter");

            // Explicitly validate all nodes share the same parent
            if (params.nodes.length > 0) {
                const firstNode = await figma.getNodeByIdAsync(params.nodes[0].nodeId);
                if (!firstNode) throw new Error(`Node ${params.nodes[0].nodeId} not found`);
                const parentId = firstNode.parent?.id;

                for (const item of params.nodes) {
                    if (!(await checkScopeAccess(item.nodeId))) throw new Error(formatScopeError(`Operation denied: Node ${item.nodeId} outside editable scope`));
                    if (!(await verifyNodeName(item.nodeId, item.nodeName))) throw new Error(ERRORS.NAME_MISMATCH);

                    // Check parent consistency
                    const node = await figma.getNodeByIdAsync(item.nodeId);
                    if (node) {
                        assertNotLocked(node);
                        assertNotInstanceInterior(node, "grouped");
                    }
                    // @ts-expect-error TS18047: 'node' is possibly 'null'.
                    if (node.parent?.id !== parentId) {
                        // @ts-expect-error TS18047: 'node' is possibly 'null'.
                        throw new Error(`Invalid Grouping: All nodes must share the same parent. Node "${node.name}" is under a different parent than "${firstNode.name}". Use 'insert_child' to reparent them first.`);
                    }
                }
            }
            return await groupNodes(params);

        case "node_ungroup":
            await validateSingleNodeWrite(params, { checkScopeRoot: true, checkLocked: true, instanceCheckVerb: "ungrouped" });
            return await ungroupNodes(params);

        case "node_flatten":
            await validateSingleNodeWrite(params, { checkScopeRoot: true, checkLocked: true, instanceCheckVerb: "flattened" });
            return await flattenNode(params);

        case "node_insert_child":
            if (!state.allowEditNode) throw new Error(ERRORS.READ_ONLY_MODE);
            // Validate parent
            await validateParentWrite(params, { checkLocked: true, instanceCheckVerb: "inserted into" });
            
            // Validate child
            if (!(await checkScopeAccess(params ? params.childId : null))) throw new Error(formatScopeError(ERRORS.OUTSIDE_SCOPE));
            if (!(await verifyNodeName(params ? params.childId : null, params ? params.childNodeName : null))) throw new Error(ERRORS.NAME_MISMATCH);
            const childNode = await figma.getNodeByIdAsync(params?.childId);
            if (childNode) {
                assertNotPageOrDocument(childNode, "reparented");
                assertNotLocked(childNode);
                assertNotInstanceInterior(childNode, "reparented");
            }
            return await insertChild(params);

        case "node_transform":
            await validateSingleNodeWrite(params, { checkLocked: true });
            return await transformNode(params);
        case "node_clone":
            await validateCloneWrite(params);
            return await cloneNode(params);

        case "create_shape":
            await validateParentWrite(params, { checkLocked: true, instanceCheckVerb: "appended to" });
            return await createShape(params);
        case "create_frame":
            await validateParentWrite(params, { checkLocked: true, instanceCheckVerb: "appended to" });
            return await createFrame(params);
        case "create_text":
            await validateParentWrite(params, { checkLocked: true, instanceCheckVerb: "appended to" });
            return await createText(params);
        case "create_instance":
            await validateParentWrite(params, { checkLocked: true, instanceCheckVerb: "appended to" });
            return await createComponentInstance(params);

        case "text_set_content":
            if (!state.allowEditNode) throw new Error(ERRORS.READ_ONLY_MODE);
            if (!params || !params.text || !Array.isArray(params.text)) throw new Error("Missing or Invalid text parameter");
            
            if (!state.scopeRootId) throw new Error(formatScopeError(ERRORS.OUTSIDE_SCOPE));
            const textScopeRoot = await figma.getNodeByIdAsync(state.scopeRootId);
            if (!textScopeRoot) {
                throw new Error(`${ERRORS.SCOPE_DELETED} (Missing Scope Node ID: ${state.scopeRootId})`);
            }

            assertNoDuplicateTargets(params.text);
            for (const item of params.text) {
                const node = await figma.getNodeByIdAsync(item.nodeId);
                if (!node) {
                    throw new Error(`Node ${item.nodeId} not found`);
                }
                if (!checkScopeAccessRef(node, textScopeRoot)) {
                    throw new Error(formatScopeError(ERRORS.OUTSIDE_SCOPE));
                }
                if (node.name !== item.nodeName) {
                    throw new Error(ERRORS.NAME_MISMATCH);
                }
                assertNotLocked(node);
                if (node.type !== "TEXT") {
                    throw new Error(`Node is not a text node: ${node.id} (type: ${node.type})`);
                }
            }
            return await setMultipleTextContents(params);

        case "text_set_style":
            await validateSingleNodeWrite(params, { checkLocked: true });
            return await setTextStyle(params);

        case "annotation_set":
            if (!state.allowEditNode) throw new Error(ERRORS.READ_ONLY_MODE);
            if (!params || !params.annotations || !Array.isArray(params.annotations)) throw new Error("Missing or Invalid annotations parameter");
            
            if (!state.scopeRootId) throw new Error(formatScopeError(ERRORS.OUTSIDE_SCOPE));
            const annScopeRoot = await figma.getNodeByIdAsync(state.scopeRootId);
            if (!annScopeRoot) {
                throw new Error(`${ERRORS.SCOPE_DELETED} (Missing Scope Node ID: ${state.scopeRootId})`);
            }

            for (const item of params.annotations) {
                const node = await figma.getNodeByIdAsync(item.nodeId);
                if (!node) {
                    throw new Error(`Node ${item.nodeId} not found`);
                }
                if (!checkScopeAccessRef(node, annScopeRoot)) {
                    throw new Error(formatScopeError(ERRORS.OUTSIDE_SCOPE));
                }
                if (node.name !== item.nodeName) {
                    throw new Error(ERRORS.NAME_MISMATCH);
                }
                assertNotLocked(node);
                if (!("annotations" in node)) {
                    throw new Error(`Node type ${node.type} does not support annotations`);
                }
            }
            return await setMultipleAnnotations(params);

        case "node_delete":
            if (!state.allowEditNode) throw new Error(ERRORS.READ_ONLY_MODE);
            if (!params || !params.nodes || !Array.isArray(params.nodes)) throw new Error("Missing or Invalid nodes parameter");

            if (!state.scopeRootId) throw new Error(formatScopeError(ERRORS.OUTSIDE_SCOPE));
            const deleteScopeRoot = await figma.getNodeByIdAsync(state.scopeRootId);
            if (!deleteScopeRoot) {
                throw new Error(`${ERRORS.SCOPE_DELETED} (Missing Scope Node ID: ${state.scopeRootId})`);
            }

            assertNoDuplicateTargets(params.nodes);
            const nodeIdsToDelete: any[] = [];
            for (const item of params.nodes) {
                const node = await figma.getNodeByIdAsync(item.nodeId);
                if (!node) {
                    throw new Error(`Node ${item.nodeId} not found`);
                }
                if (!checkScopeAccessRef(node, deleteScopeRoot)) {
                    throw new Error(formatScopeError(ERRORS.OUTSIDE_SCOPE));
                }
                if (node.name !== item.nodeName) {
                    throw new Error(ERRORS.NAME_MISMATCH);
                }
                assertNotScopeRoot(node.id);
                assertNotPageOrDocument(node, "deleted");
                assertNotLocked(node);
                assertNotInstanceInterior(node, "deleted");
                nodeIdsToDelete.push(item.nodeId);
            }

            return await deleteMultipleNodes({ nodeIds: nodeIdsToDelete });

        case "instance_set_overrides":
            if (!state.allowEditNode) throw new Error(ERRORS.READ_ONLY_MODE);

            if (params && params.targetNodes) {
                if (!Array.isArray(params.targetNodes)) {
                    throw new Error("targetNodes must be an array");
                }

                if (!state.scopeRootId) throw new Error(formatScopeError(ERRORS.OUTSIDE_SCOPE));
                const instScopeRoot = await figma.getNodeByIdAsync(state.scopeRootId);
                if (!instScopeRoot) {
                    throw new Error(`${ERRORS.SCOPE_DELETED} (Missing Scope Node ID: ${state.scopeRootId})`);
                }

                // Verify source instance exists and is an INSTANCE node
                if (!params.sourceInstanceId) {
                    throw new Error(ERRORS.MISSING_SOURCE_INSTANCE_ID);
                }
                const sourceNode = await figma.getNodeByIdAsync(params.sourceInstanceId);
                if (!sourceNode) {
                    throw new Error(`Node ${params.sourceInstanceId} not found`);
                }
                if (sourceNode.type !== "INSTANCE") {
                    throw new Error(`Source node is not an instance: ${sourceNode.id} (type: ${sourceNode.type})`);
                }

                assertNoDuplicateTargets(params.targetNodes);
                // Validation-time pass: fail fast with specifically-coded errors.
                // R2 re-asserts this same predicate set at use-time inside
                // getValidTargetInstances (immediately before execution), so a
                // shared-document change between here and the swap fails closed.
                for (const item of params.targetNodes) {
                    const node = await figma.getNodeByIdAsync(item.nodeId);
                    if (!node) {
                        throw new Error(`Node ${item.nodeId} not found`);
                    }
                    if (!checkScopeAccessRef(node, instScopeRoot)) {
                        throw new Error(formatScopeError(`Operation denied: Target instance ${item.nodeId} outside editable scope`));
                    }
                    if (node.name !== item.nodeName) {
                        throw new Error(ERRORS.NAME_MISMATCH);
                    }
                    assertNotLocked(node);
                    if (node.type !== "INSTANCE") {
                        throw new Error(`Target is not an instance node: ${node.id} (type: ${node.type})`);
                    }
                }

                // P6-5: these are pre-execution refusals — throw so they surface
                // as proper errors (isError), not as an envelope-less success
                // payload that the three-layer contract cannot classify. Prose
                // messages ride the UNKNOWN_ERROR fallback (legacy surface,
                // v2.3.4 burn-down).
                // R2 (second recheck): resolve every fallible/awaited dependency
                // BEFORE the final target gate. Source resolution awaits
                // getNodeByIdAsync/getMainComponentAsync, so running it after the
                // gate reopened a drift window between validation and mutation.
                let sourceInstanceData = await getSourceInstanceData(params.sourceInstanceId);
                if (!sourceInstanceData.success) {
                    notifyBestEffort(sourceInstanceData.message || "Failed to resolve source instance");
                    throw new Error(sourceInstanceData.message || "Failed to resolve source instance");
                }

                // R2: re-assert the full predicate set (identity, INSTANCE type,
                // exact name, scope membership, lock) against the original request
                // and current scope root.
                const targetNodesResult = await getValidTargetInstances(params.targetNodes, instScopeRoot);
                if (!targetNodesResult.success) {
                    notifyBestEffort(targetNodesResult.message);
                    throw new Error(targetNodesResult.message);
                }

                // The guard lets the handler re-assert the SAME predicate set
                // synchronously immediately before each swapComponent(), closing
                // the windows opened by its own awaits.
                return await setInstanceOverrides(
                    targetNodesResult.targetInstances,
                    sourceInstanceData,
                    { items: params.targetNodes, scopeRoot: instScopeRoot }
                );
            }
            throw new Error(ERRORS.MISSING_TARGET_NODE_IDS);

        case "instance_set_property":
            await validateSingleNodeWrite(params, { checkLocked: true });
            return await setComponentInstanceProperty(params);

        case "component_manage_property":
            await validateSingleNodeWrite(params, { checkLocked: true, checkRemoteAsset: true });
            return await manageComponentProperty(params);

        case "component_delete_property":
            await validateSingleNodeWrite(params, { checkLocked: true, checkRemoteAsset: true });
            return await deleteComponentProperty(params);

        case "page_info":
            return await getPagesInfo(params);
        case "node_info":
            // 1. Prepare nodeIds (Empty-args dispatch)
            const effectiveNodeIds = (params && params.nodeIds && Array.isArray(params.nodeIds) && params.nodeIds.length > 0) 
                ? params.nodeIds 
                : ((getCurrentLease() && getCurrentLease().kind === "explicit")
                    ? getCurrentLease().rootIds.slice()
                    : (state.allowEditNode === "document"
                        // Local patch (simple model): never walk the whole
                        // document by default; list each page and its
                        // top-level layers, like a page-scope join.
                        ? figma.root.children.map((page: any) => page.id)
                        : (state.scopeRootId ? [state.scopeRootId] : [])));
            const documentDefault = state.allowEditNode === "document"
                && !(params && Array.isArray(params.nodeIds) && params.nodeIds.length > 0)
                && !(getCurrentLease() && getCurrentLease().kind === "explicit");
            
            // 2. Read-Only Mode check for empty-args
            if (effectiveNodeIds.length === 0 && !state.allowEditNode) {
                return { nodes: [] };
            }

            // 3. Call unified handler path
            // NOTE: Avoid object spread (...) — Figma's plugin sandbox JS engine does not support it.
            return await getNodesInfo(Object.assign({}, params, {
                nodeIds: effectiveNodeIds,
                commandId: (params && params.commandId) ? params.commandId : generateCommandId()
            }, (documentDefault && (params == null || params.maxDepth === undefined)) ? { maxDepth: 1 } : {}));

        case "style_list":
            return await getStyles();
        case "component_list":
            return await getComponents(params);
        case "node_export_visual":
            return await exportNodeAsImage(params);
        case "annotation_list":
            return await getAnnotations(params);
        case "instance_get_overrides":
            if (!params || !params.instanceNodeId) {
                throw new Error("Missing instanceNodeId parameter");
            }
            // Get the instance node by ID
            const instanceNode = await figma.getNodeByIdAsync(params.instanceNodeId);
            if (!instanceNode) {
                throw new Error(`Instance node not found with ID: ${params.instanceNodeId}`);
            }
            return await getInstanceOverrides(instanceNode);
        case "reaction_list":
            if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
                throw new Error(ERRORS.MISSING_NODE_IDS);
            }
            return await getReactions(params.nodeIds);
        case "reaction_update":
            await validateSingleNodeWrite(params, { checkLocked: true });
            return await updateReactions(params);

        case "view_navigate":
            return await viewNavigate(params);
        case "variable_list":
            return await getVariables(params);

        case "variable_manage":
            if (!state.allowEditVariable) throw new Error(ERRORS.VARIABLE_EDITS_DISABLED);
            assertDocumentWideWriteAllowed();
            // Document level, no scope check needed for creation? 
            // Often variables are global. But if we are scoped to a page/frame... variables are collection based.
            // Collections are document global. So we allow it if not read-only.
            return await handleVariableRequest(params);

        case "variable_delete":
            if (!state.allowEditVariable) throw new Error(ERRORS.VARIABLE_EDITS_DISABLED);
            assertDocumentWideWriteAllowed();
            return await deleteVariables(params);

        case "style_manage":
            if (!state.allowEditStyle) throw new Error(ERRORS.STYLE_EDITS_DISABLED);
            assertDocumentWideWriteAllowed();
            // Styles are document global.
            return await createStyle(params);

        case "style_delete":
            if (!state.allowEditStyle) throw new Error(ERRORS.STYLE_EDITS_DISABLED);
            assertDocumentWideWriteAllowed();
            return await deleteStyle(params);

        case "node_apply_style":
            await validateSingleNodeWrite(params, { checkLocked: true });
            return await applyStyle(params);

        case "create_component":
            await validateSingleNodeWrite(params, {
                checkScopeRoot: true,
                checkLocked: true,
                instanceCheckVerb: "converted to a component",
            });
            return await createComponent(params);

        case "create_component_set": {
            if (!state.allowEditNode) throw new Error(ERRORS.READ_ONLY_MODE);
            if (!state.scopeRootId) throw new Error(formatScopeError(ERRORS.OUTSIDE_SCOPE));
            const compSetScopeRoot = await figma.getNodeByIdAsync(state.scopeRootId);
            if (!compSetScopeRoot) {
                throw new Error(`${ERRORS.SCOPE_DELETED} (Missing Scope Node ID: ${state.scopeRootId})`);
            }
            const plan = await validateCreateComponentSetPlan(params, compSetScopeRoot);
            // Local patch (multi-MCP): the plan validator checks the primary root
            // only; also apply the peer-lease verdict to every input node and
            // the destination parent.
            for (const item of (params && params.components) || []) {
                if (!(await checkScopeAccess(item.nodeId))) throw new Error(formatScopeError(ERRORS.OUTSIDE_SCOPE));
            }
            if (params && params.parentId && !(await checkScopeAccess(params.parentId))) {
                throw new Error(formatScopeError(ERRORS.PARENT_OUTSIDE_SCOPE));
            }
            return await createComponentSet(plan);
        }

        case "create_svg":
            await validateParentWrite(params, { checkLocked: true, instanceCheckVerb: "appended to" });
            return await createNodeFromSvg(params);

        case "node_set_effects":
            await validateSingleNodeWrite(params, { checkLocked: true });
            return await setEffects(params);

        default:
            throw new Error(`Unknown command: ${command}`);
    }
}
