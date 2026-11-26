# Proposal: "open the plugin, then agents edit the file"

Status: proposal, not implemented. Fork-only (MrCoder/agentic-local-figma). Builds on PR #3 (cross-page `node_clone`, merged) and PR #5 (several sessions per channel with leases, open).

## The model we want

Editing a Figma file through this server should feel like several agents editing one Markdown file:

| Markdown file | figma-edit today | figma-edit proposed |
|---|---|---|
| File path | 4-character channel code + port 3055 | The file key from the Figma link the agent already has |
| Read: no lock | Reads are not lease-restricted | Unchanged |
| Write: Claude's `Edit` fails if `old_string` no longer matches; reread and retry (optimistic concurrency) | Every write must pass `nodeName` back verbatim; a mismatch is refused | Keep it. This is the primary conflict guard |
| No file lock | Leases: a session claims an area at join time | Leases become optional (off by default) |
| Writes are serialized by the file system | The plugin sandbox is single-threaded; commands run one at a time | Unchanged; at most a per-command queue inside the plugin, invisible to agents |

The only step a human must take: open the plugin in the Figma desktop app. Opening it is the consent for agents to edit that file. Everything else is a default.

```
human:  open plugin in Figma ──► done
agent:  edit https://www.figma.com/design/<fileKey>/...
          │
  MCP server ──► relay (localhost) ──► plugin registered under <fileKey> ──► write
```

## What changes

| Concept | Why it exists | Proposal |
|---|---|---|
| Port 3055 | Figma plugins cannot listen; they connect out to a local relay | Already a fixed default. Keep hidden |
| Channel code | The relay routes by channel name; the plugin UI generates a random name | Plugin joins with `channel = figma.fileKey`. Agents pass a Figma link; the server extracts the key and joins that channel |
| `channel_join` / `channel_leave` | Follows from the channel code | Implicit: the first tool call that carries a link (or the only connected plugin) binds the session |
| Leases, "Allow up to 4 AI sessions" | PR #5: keep sessions out of each other's area | Several sessions allowed by default. A session without `scopeLinks` gets shared write (today: `readOnly` when the implicit lease is taken). `scopeLinks` stays as an opt-in reservation |
| Scope link, additional roots | Upstream's scope locking (`SAFETY.md`, `DESIGN_PHILOSOPHY.md`) | Default: whole document editable. Needs a new scope type: today the plugin refuses the document root as an editable root. Narrower scopes stay available |
| Variables / Styles checkboxes | Upstream default off | Default follows the scope: whole document scope allows them |

Checks that stay on in every mode: `nodeName` verification, batch pre-validation, variable-consumer check, localhost-only relay.

## Pairing by file key

Expected (Figma docs): `figma.fileKey` is available to private plugins when `manifest.json` sets `enablePrivatePluginApi: true`, and "setting this will also enable local plugins to work with these APIs during development".

Observed (2026-11-08, Figma desktop, this fork's development plugin `2.3.3-local-patched-2026-11-08-13`): with `enablePrivatePluginApi: true` added and a one-line probe (`figma.notify("FILEKEY_PROBE=" + figma.fileKey)`), the plugin showed the same key as the file's URL. The probe was removed afterwards.

Limits:

- Upstream's published Community plugin cannot read `fileKey` (private plugins and Figma-owned resources only). Fallback when the key is missing: if exactly one plugin is connected, pair with it; if several are, match by document name plus a page id and page name taken from the link, and refuse if still ambiguous.
- One file open in two windows (or two machines on one relay) gives two plugins for one key. The relay already refuses a second plugin on the same channel name (`PLUGIN_PEER_AMBIGUOUS`). Proposal: keep that refusal and name the fix in the error ("close the plugin in the other window").
- Auto-pairing with "the only connected plugin" needs a relay frame that lists connected plugins. Today the relay exposes no list of channels; that changes.

## Side effect found during the probe

Figma desktop hot-reloads a development plugin when its `code.js` changes on disk. The reload drops the channel for every connected session. Installing a new build therefore disconnects all sessions; the install steps should say so.

## Relation to upstream

Upstream's design philosophy is "safer by programmatic checks", and scope locking is one of those checks. This proposal keeps every check and changes only defaults and addressing. A narrow scope and leases remain one option away for tasks that want them.

## Open items

1. Implement the document scope type and measure `documentAccess: "dynamic-page"` cost for whole-document reads and writes.
2. Decide whether shared write between sessions needs a per-node "changed since your last read" check beyond `nodeName` (Markdown analogy: `old_string` checks content, not only the name).
3. Live-test two sessions writing the same frame under shared write.
