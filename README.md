# FigmaMCP

Let Claude Code or Codex read and edit the Figma file you have open, on your own Mac. Free, local, and with no call quota.

This plugin empowers your AI assistant to become a Figma assistant, executing design updates **Safer**, **Cleaner**, and **Faster** than a human ever could.

This plugin allows you as a Designer to focus purely on creative decision-making, leaving the error-prone & repetitive manual changes to the automated systems.

📖 **Documentation:** [figmamcp.dev](https://figmamcp.dev/)

## What This Does for You

The project has three goals: **Safer**, **Cleaner**, and **Faster**.

- 🛡️ **Safer:** The plugin checks every action the AI requests before that action runs. If an action would damage the file, the plugin refuses it and tells the AI why. For example, the plugin will not delete a color variable while layers still use it. Figma itself does not warn you when you delete a variable that is in use — the deletion leaves broken references that are very hard to find afterwards.
- ✨ **Cleaner:** Because damaging actions are refused, the file does not accumulate broken references or leftover values. Bulk updates cover every layer that matches your request, not just the layers a person remembers to check.
- ⚡ **Faster:** The AI applies one change across hundreds of layers in seconds. For example, it can replace a product name in every text layer on a page, or copy the overrides from one component instance to fifty others.

These goals support each other: when the plugin refuses mistakes, the file stays consistent, and a consistent file is easier for both you and the AI to work with.


## What the AI Cannot Do to Your File

AI assistants sometimes invent things. An AI can name a layer that does not exist, or misremember which layer it was editing. This plugin does not depend on the AI being right. The plugin checks every edit itself, inside Figma, and refuses any edit that fails a check. The AI cannot skip these checks.

What the plugin enforces:

1. **The AI edits only the open file where the switch is on.** The FigmaMCP panel in Figma has an **AI can edit this file** switch. With the switch on, the whole open file is the editable area (the document and its pages themselves stay protected). With the switch off, the AI can read the file but cannot change it.
2. **Every edit must name its exact target layer.** The plugin compares the layer name the AI supplies with the real layer's name. If the names do not match, the plugin refuses the edit. This stops the AI from editing a layer it invented or misremembered.
3. **A bulk edit with one bad item changes nothing.** The plugin validates every item in a bulk edit before it changes the first one. If any item fails validation, the plugin rejects the entire bulk edit.
4. **Protected layers stay protected.** The plugin refuses edits to locked layers and to assets from shared libraries. It also refuses to add, delete, or move layers inside a component instance.
5. **The AI cannot delete its own working area.** The plugin refuses any action that would delete or replace the root of the editable area.
6. **You hold the switch, not the AI.** The switch is in the plugin panel, not in a tool the AI can call. Turning it off makes the session read-only, including variables and styles, which follow the same switch. The change applies at once.

One honest limit: the plugin checks *where* an edit happens and *which layer* it touches. It cannot check whether the edit is the one you wanted. A wrong edit that follows all the rules will go through. So you review the AI's work the same way you would review a colleague's work.


## How the Work Is Divided

You do not need to know every Figma feature to direct this system. The work splits three ways:

- **You** decide what the design should be. You describe the change in plain language, and you judge the result. You do not need to know which Figma menu or panel performs the change.
- **The AI assistant** turns your request into specific Figma operations and carries out the repetitive work across many layers.
- **The plugin** runs inside Figma, checks each operation, and refuses the unsafe ones.

The AI contributes scale. The plugin contributes protection. You contribute the design judgment.

## Quick Start

FigmaMCP runs on macOS only for now. Other platforms: manual setup is not supported yet. You need the Figma desktop app.

### 1. The Mac app (recommended)

1. [Download FigmaMCP for Mac](https://figmamcp.dev/download) and open it.
2. Click **Add to Figma**. Figma restarts once, and only if it was running and the plugin was not yet installed.
3. Optional: allow Accessibility when asked. Then FigmaMCP can open the plugin for your AI, so you do not have to.

That is all. Ask Claude Code or Codex to change your open Figma file. If Claude Code or Codex was already running, restart it so it loads the new tool.

### 2. Or use the terminal

The setup command is inside the Mac app. Install the app first, then run:

```bash
/Applications/FigmaMCP.app/Contents/Resources/bin/figmamcp setup
```

This registers the plugin in Figma, connects Claude Code and Codex, installs the agent skill, and starts a small local background service on a free port (it picks one itself). If the app cannot open the plugin for you (no Accessibility grant), open it once per Figma file: **Plugins > Development > FigmaMCP** in the Figma desktop app. Leave it open while the AI works.

### 3. Other MCP clients

Claude Code and Codex are set up automatically. For any other client that can launch a local MCP server, add this to its MCP config (for example `~/.cursor/mcp.json` for Cursor):

```json
{
  "mcpServers": {
    "figmamcp": {
      "command": "/Users/<you>/.figmamcp/current/bin/figmamcp-server"
    }
  }
}
```

Run setup first (the Mac app or the command above): it installs that server program and registers the plugin in Figma. The AI-facing guidance is also served as MCP resources under `figmamcp://guide/*`.

FigmaMCP is distributed outside Figma Community, so the plugin is installed by the app or by `setup`, not from the Community page.

---

## MCP Tools

Tools are grouped into a two-level, underscore-separated namespace (`group_action`). Reads are `*_list` / `*_info`; writes use verb leaves. Anything that mutates a node lives under `node_*`.

### `page` — pages

| Tool | Description |
|---|---|
| `page_info` | List the document's pages; with `pageIds`, return those pages and their top-level children |

### `node` — read, transform, and style any node

| Tool | Description |
|---|---|
| `node_info` | Read one or more nodes — recursive traversal with `properties`, `filter`, and `maxDepth` (the workhorse read; also returns bound variables / explicit modes) |
| `node_transform` | Move and/or resize a node by setting absolute `x` / `y` / `width` / `height` |
| `node_rename` | Rename a node |
| `node_delete` | Delete one or more nodes in a single validated batch |
| `node_clone` | Duplicate a node, optionally at a new position |
| `view_navigate` | Navigate the editor view to a page or node(s) |
| `node_group` | Wrap nodes in a new group |
| `node_ungroup` | Dissolve a group, promoting its children |
| `node_flatten` | Flatten a node and its children into a single vector |
| `node_insert_child` | Reparent a node under a new parent at an optional index |
| `node_set_auto_layout` | Configure a frame's auto-layout (mode, padding, spacing, alignment, sizing) |
| `node_set_fill` | Set a node's fill to a color or image, or clear it |
| `node_set_stroke` | Set stroke color and weight (uniform or per-side) |
| `node_set_corner_radius` | Set corner radius (uniform or per-corner) |
| `node_set_effects` | Set the effect array (shadows, blurs) |
| `node_apply_style` | Link a node to a shared library style (paint/text/effect/grid) |
| `node_bind_variable` | Bind a variable to a node property, or set an explicit variable mode |
| `node_export_visual` | Render a node to an image (PNG / JPG / SVG / PDF) |

### `create` — make new nodes

| Tool | Description |
|---|---|
| `create_shape` | Create a rectangle, ellipse, polygon, or star (`type`) with optional fill/stroke |
| `create_frame` | Create a frame with optional fill/stroke and full auto-layout |
| `create_text` | Create a text node with optional font size/weight/color |
| `create_svg` | Create a node from an SVG markup string |
| `create_component` | Convert an existing frame into a main component |
| `create_instance` | Instantiate a component at a position |
| `create_component_set` | Combine components into a component set (variants) |

### `style` — shared styles

| Tool | Description |
|---|---|
| `style_list` | List all local styles (paint/text/effect/grid) |
| `style_manage` | Create a named style, or update one when `styleId` is given |
| `style_delete` | Delete a local style by id (detaches consumers, which keep their resolved values) |

### `text` — text content & typography

| Tool | Description |
|---|---|
| `text_set_content` | Batch-set the text of one or more text nodes |
| `text_set_style` | Set any combination of typography properties on a text node |

### `component` — components & variants

| Tool | Description |
|---|---|
| `component_list` | List components, with filtering and scope options |
| `component_manage_property` | Add or edit a component-property definition (BOOLEAN/TEXT/INSTANCE_SWAP) |
| `component_delete_property` | Remove a component-property definition |

### `instance` — component instances

| Tool | Description |
|---|---|
| `instance_set_property` | Set one property on an instance (toggle, text, swap, or variant) |
| `instance_get_overrides` | Read the override properties from a source instance |
| `instance_set_overrides` | Apply copied overrides to target instances |

### `variable` — variables & collections

| Tool | Description |
|---|---|
| `variable_list` | List variables/collections, or detail by ID; optionally scan consumers |
| `variable_manage` | Create collections and variables and set values/aliases |
| `variable_delete` | Delete variables or a collection (rejected if still in use) |

### `annotation` — Dev Mode annotations

| Tool | Description |
|---|---|
| `annotation_list` | Read annotations on a node; optionally include categories |
| `annotation_set` | Batch create or update native annotations (markdown) |

### `reaction` — prototype reactions

| Tool | Description |
|---|---|
| `reaction_list` | Read prototype reactions (click flows, overlays) from nodes |
| `reaction_update` | Replace a node's reactions with a full new array |

### `channel` — connection

| Tool | Description |
|---|---|
| `channel_join` | Pick which Figma file to work in. Needed only when several files have the plugin open; otherwise the server finds the open file itself. Optional `label` names this session in the plugin panel |

---

## MCP Prompts

Built-in prompts guide complex multi-step design tasks:

| Prompt | Description |
|---|---|
| `swap_overrides_instances` | Transfer component instance overrides from a source to multiple targets |

---

## Agent Skills

| Skill | What it does | Installed by setup |
|---|---|---|
| [`figmamcp`](skills/figmamcp/SKILL.md) | The plugin's constraints, error codes, and how to pick a tool | Yes |
| [`figma-design-qa`](skills/figma-design-qa/SKILL.md) | Loop on one frame: export it with `node_export_visual`, score it against a rubric (alignment, spacing, type scale, contrast, naming, auto-layout), fix the lowest categories, export again, and stop when every category is 9/10 or more | No, copy it |

To use `figma-design-qa` in Claude Code, copy the `skills/figma-design-qa` folder to `~/.claude/skills/` (Codex: `~/.codex/skills/`). Then ask, for example: "Run design QA on the frame *Sign-up card* until every category scores 9 or more." The rubric is in [skills/figma-design-qa/references/rubric.md](skills/figma-design-qa/references/rubric.md).

---

## Best Practices

When working with FigmaMCP:

1. Start with `page_info`, then `node_info`, and pass layer names back exactly as read.
2. If several Figma files have the plugin open, the server asks you to pick one with `channel_join`.

---

## Notes
### Automatic Node ID Normalization

Node IDs copied from Figma URLs use dashes (`20485-41`), but the plugin API expects colons (`20485:41`).  The MCP server automatically converts dash-format IDs before forwarding, so either format works without manual intervention.

---

## Credits

FigmaMCP is a fork of [figma-edit-mcp](https://github.com/neozhehan/figma-edit-mcp) by Neo Product LLC, which was originally written by [sonnylazuardi](https://github.com/sonnylazuardi). Not affiliated with Figma, Inc.

Built on prior work by [sonnylazuardi](https://github.com/sonnylazuardi) and the contributors to [grab/cursor-talk-to-figma-mcp](https://github.com/grab/cursor-talk-to-figma-mcp). Thank you for the foundation this project builds on.

Thanks to [@dusskapark](https://github.com/dusskapark) for the following contributions:

- **Bulk text content replacement** — Batch-update text across large designs efficiently. [Demo video](https://www.youtube.com/watch?v=j05gGT3xfCs)
- **Instance override propagation** — Propagate component instance overrides from a source to multiple targets in a single command, dramatically reducing repetitive design work. [Demo video](https://youtu.be/uvuT8LByroI)

---

## License

MIT. See [`LICENSE`](LICENSE). Signed, notarized Mac builds are on the [releases page](https://github.com/MrCoder/figmamcp-releases/releases).
