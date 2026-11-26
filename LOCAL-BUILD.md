# Local build — version convention and install

This fork (`MrCoder/agentic-local-figma`) carries local patches on top of
upstream `neozhehan/figma-edit-mcp`. This file says how a patched build is
named, built, installed and rolled back.

## Version suffix

Every locally patched build carries this version in `package.json`,
`package-lock.json`, `server.json` (both fields) and `manifest.json`:

```
<upstream-version>-local-patched-<yyyy-mm-dd-hh>
```

Example: `2.3.3-local-patched-2026-11-08-20`.

`channel_join` returns `serverVersion` and `pluginVersion`, and the plugin's
About tab shows the plugin version. A version without `-local-patched-` is an
upstream artifact, so the local patches are not running.

Bump the timestamp part on every rebuild that changes behaviour. Also update
`RELEASE_VERSION` in `src/mcp_server/tests/unit/v2.3.3.phase13.test.ts`, and run
`bun run gen:manifest` (the release-boundary test and `check:generated` pin
these).

## Patches in this build

| Patch | Files | What it does |
|---|---|---|
| Several AI sessions per channel (issue #4) | `src/socket.ts`, `figma_plugin/src/main.ts`, `figma_plugin/ui.html`, `figma_plugin/utils/errors.ts`, `figma_plugin/utils/progressUtils.ts`, `src/shared/errorCodes.ts`, `src/mcp_server/tools/channel.ts` | Off by default. The plugin checkbox "Allow up to 4 AI sessions on this channel" lets the relay admit up to 4 MCP peers. Each session gets a lease inside the editable scope at `channel_join`: explicit (`scopeLinks`), implicit (first session without `scopeLinks`), or read-only. Writes into another session's lease fail with `LEASED_BY_OTHER_SESSION`; variables and styles stay with the implicit holder (`DOCUMENT_WIDE_WRITE_LOCKED`). New tool `channel_leave` frees the lease. |
| Simple model ("open the plugin, then agents edit") | `figma_plugin/manifest.json`, `figma_plugin/src/main.ts`, `figma_plugin/ui.html`, `figma_plugin/handlers/connectHandlers.ts`, `src/socket.ts`, `src/mcp_server/figma-client.ts`, `src/mcp_server/tools/channel.ts`, `src/mcp_server/server.ts` | The plugin reads `figma.fileKey` (needs `enablePrivatePluginApi: true` in the manifest) and uses it as the channel name, and connects by itself on open. A blank link means the whole file (`editableScopeType: "document"`); pages and the document root cannot be deleted, moved, cloned or used as a parent. Variables and Styles are on by default. A session without `scopeLinks` always gets shared write. Any tool binds on demand: the relay answers `list_channels`, one open file is joined, several return `CHANNEL_NOT_BOUND` with the file names, and `channel_join` takes `link`. After a plugin reload the next tool call rejoins the same file with the same `scopeLinks`; it never moves to another file. Design note: `documentation/future/simple-mental-model.md`. |
| Simple panel | `figma_plugin/ui.html`, `figma_plugin/src/main.ts` | The panel shows status with the file name, the AI session count and one "AI can edit this file" switch, which reconnects with the new rights. Link, extra roots, Variables, Styles and port are under Advanced. 4 sessions is always on. The About tab is gone; the version is in the footer. |
| Cross-page `node_clone` | `figma_plugin/src/main.ts`, `figma_plugin/handlers/nodeCreators.ts`, `figma_plugin/handlers/connectHandlers.ts`, `figma_plugin/ui.html`, `src/mcp_server/tools/node.ts`, `src/mcp_server/tools/channel.ts` | `node_clone` takes optional `parentId` + `parentNodeName`. The plugin UI takes "Additional editable roots" (one link per line); a node under the primary root or any additional root is in scope. |

## Build

```bash
cd ~/workspaces/labs/agentic-local-figma   # or a worktree of it
bun install --frozen-lockfile              # root only; do NOT install inside src/mcp_server
bun run build:all                          # dist/ (server + relay) and figma_plugin/code.js
bun test
bun run check:plugin && bun run check:versions && bun run check:generated
npm pack                                   # figma-edit-mcp-<version>.tgz
```

A `bun install` inside `src/mcp_server/` creates a second, older
`@modelcontextprotocol/sdk` there and about 100 tests fail with
`Cannot find module '@modelcontextprotocol/sdk/server/zod-compat.js'`. Delete
`src/mcp_server/node_modules` to recover.

## Install — replace the package in place

Claude Code starts the server from
`~/.local/share/figma-edit-mcp/node_modules/figma-edit-mcp/dist/server.js`
(`~/.claude.json` → `mcpServers["figma-edit"]`), and Figma loads the plugin
from `figma_plugin/manifest.json` in the same package. Install the tarball into
that folder, so no path changes. (The relay is separate; see step 1.)

Keep the tarball in a stable folder: `npm install <tgz>` records a `file:` path
in `~/.local/share/figma-edit-mcp/package.json`, and a later `npm install`
there fails if that file is gone.

```bash
mkdir -p ~/.local/share/figma-edit-mcp/vendor
cp figma-edit-mcp-<version>.tgz ~/.local/share/figma-edit-mcp/vendor/
cd ~/.local/share/figma-edit-mcp
npm install ./vendor/figma-edit-mcp-<version>.tgz
node -p "require('figma-edit-mcp/package.json').version"   # must print the -local-patched- version
```

Semver sorts `2.3.3-local-patched-…` below `2.3.3`, so an `npm update` or a
`^2.3.3` range resolution there goes back to upstream.

Then:

1. Relay on :3055: launchd job `com.agentic-local-figma.relay`
   (`~/Library/LaunchAgents/com.agentic-local-figma.relay.plist`). On
   2026-11-08 its `ProgramArguments` point at the main clone's
   `~/workspaces/labs/agentic-local-figma/dist/socket.js`, which is whatever
   branch that clone has checked out, not the installed package. The
   multi-session patch changes `src/socket.ts`, so point the plist at
   `~/.local/share/figma-edit-mcp/node_modules/figma-edit-mcp/dist/socket.js`
   and reload it (`launchctl bootout gui/$(id -u) <plist>` then
   `launchctl bootstrap gui/$(id -u) <plist>`). A relay restart drops every
   connected session and plugin; reconnect them afterwards.
2. Reconnect the figma-edit MCP server in Claude Code (`/mcp`), so it runs the
   new `dist/server.js`. Proof: `node_clone` lists `parentId`, and
   `channel_join` returns a `-local-patched-` `serverVersion`.
3. Check which manifest Figma actually loads: Figma keeps the imported path in
   `~/Library/Application Support/Figma/settings.json` (`manifestPath` for plugin
   id `1600027898205660796`). On this machine (2026-11-08) it is
   `~/Downloads/Figma Edit MCP Plugin 2.3.3/manifest.json`, not the npm
   package, so copy the built `figma_plugin/code.js`, `ui.html` **and
   `manifest.json`** there (the simple-model patch adds
   `enablePrivatePluginApi` to the manifest; without it `figma.fileKey` is
   undefined and the plugin falls back to a random 4-character code). The
   originals are backed up in
   `~/.local/share/figma-edit-mcp/vendor/plugin-backup-2.3.3/`. Figma
   hot-reloads a development plugin as soon as `code.js` changes on disk, so
   the copy itself drops every connected session.
4. In Figma desktop, close and reopen the plugin. Figma reads `code.js` and
   `ui.html` from disk when a development plugin starts. The About tab, and
   `channel_join`'s `pluginVersion`, must show the `-local-patched-` version.
   Reopening the plugin drops the current channel binding, so pick a moment
   when no other session is editing through it.
5. Every running figma-edit MCP server (one per Claude Code session) keeps the
   old `dist/server.js` in memory until it is restarted, and a server and a
   plugin of different versions refuse each other (`VERSION_MISMATCH`).
   Stop the old `dist/server.js` processes (compare `ps -eo lstart` with the install time). The host starts a new one on that session's next figma-edit call, so nobody needs to restart anything by hand. Stopping a server drops that session's lease and any command in flight.

## Roll back

```bash
cd ~/.local/share/figma-edit-mcp
npm install figma-edit-mcp@2.3.3
```

Then copy `code.js` and `ui.html` back from `vendor/plugin-backup-2.3.3/` into the folder Figma loads, and repeat steps 2–4 above.

## Verification status

Unit tests run against stubs (see CONTRIBUTING § Tests). The two host facts
they cannot show were checked live on 2026-11-08 on the Conf App file
(server and plugin both reported `2.3.3-local-patched-2026-11-08-12` in
`channel_join`):

| Step | Observed |
|---|---|
| Connect: primary = page `20 · 定稿 Approved` (533:831), additional = page `30 · 探索 Explore` (533:832) | `editableScopeType: page`, `additionalScopeRoots: [533:832]` |
| `node_clone` 488:2752 `S18 · Link help (overlay)` with `parentId` 533:832, x/y -5000 | new id 535:837, `parentId: 533:832`, x/y -5000 |
| `node_info` 535:837 | path = page 30 |
| Page 20 before / after | 42 children, 3840 descendants / unchanged |
| Page 30 before / after | 79 children, 5982 descendants / 80, 6016 (+1 frame with 33 descendants) |
| `node_delete` 535:837 (under the additional root) | success; page 30 back to 5982 descendants |

So `appendChild` into another page after `loadAsync()` works, and no copy is
left on the source page. Not checked live: cloning into a frame on another
page (unit-tested only).

## Several AI sessions — limits

| Case | Behaviour |
|---|---|
| A fifth session | `CHANNEL_IN_USE`. |
| Second session without `scopeLinks` (simple model) | Shared write (implicit lease), not read-only. |
| Reads (`node_info`, `page_info`, lists) | Not lease-restricted. Any session reads the whole file. |
| Variables, styles | Not partitioned. Only sessions with the implicit lease (or a lone session) may write them. |
| Session drops without `channel_leave` | The relay sends the plugin a "left" notice with that peer id, and the plugin frees the lease. |
| Plugin closed or re-scoped | All leases are dropped. Simple model: with the file key as channel, each session's next tool call rejoins the same file with its old `scopeLinks`; with a 4-character code, every session must `channel_join` again. |
| Old MCP server against this relay | `VERSION_MISMATCH`: server and plugin versions must match. |

Live check, 2026-11-08 13:10, Conf App file, channel `t0yn`. The plugin box was ticked; the ceiling was page `20 · 定稿 Approved` (533:831) plus additional root page `30 · 探索 Explore` (533:832). Two real MCP SDK clients each spawned the installed `dist/server.js`; server and plugin both reported `2.3.3-local-patched-2026-11-08-13`.

| Step | Observed |
|---|---|
| A `channel_join` with `scopeLinks` [page 20] | `lease: explicit [533:831]` |
| B `channel_join` with `scopeLinks` [page 30] | `lease: explicit [533:832]` |
| Page 20 / page 30 before | 42 / 3840 and 80 / 5982 (children / descendants) |
| A `create_frame` on page 20, B `create_frame` on page 30 | 536:871 and 536:872 created |
| A `node_rename` own frame | success |
| B `node_rename` A's frame 536:871 | `LEASED_BY_OTHER_SESSION`, lease root 533:831 |
| B `create_frame` with parent page 20 | `LEASED_BY_OTHER_SESSION` |
| A rejoin with [page 20, page 30] while B holds page 30 | join fails `LEASED_BY_OTHER_SESSION` (A then rejoined with page 20) |
| B `channel_leave`, then A rejoin with [page 20, page 30] | success, `lease: explicit [533:831, 533:832]` |
| A `node_delete` 536:872 (B's old area) + 536:871 | success |
| Page 20 / page 30 after | 42 / 3840 and 80 / 5982, same as before |

A failed rejoin drops that session's previous lease and binding (the join failure detaches it), so rejoin with the old links to get it back.
