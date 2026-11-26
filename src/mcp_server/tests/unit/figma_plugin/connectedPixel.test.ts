import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";

const ui = readFileSync("figma_plugin/ui.html", "utf8");

// sendConnectedPixel lives in ui.html between its own declaration and the
// next function's comment; load just that body and bind it to a fake `state`
// and `Image`, the same technique statusPill.test.ts uses for the panel-mode
// reducer. Returns both the callable function and the Image instances it created.
function buildSendConnectedPixel(state: any) {
  const start = ui.indexOf("function sendConnectedPixel");
  expect(start).toBeGreaterThan(-1);
  const end = ui.indexOf("\n\n    // Owner decision 2026-11-18: batched counts", start);
  expect(end).toBeGreaterThan(start);
  const body = ui.slice(start, end);

  const instances: { src?: string }[] = [];
  class FakeImage {
    set src(value: string) {
      (this as any)._src = value;
      instances.push(this as any);
    }
    get src() {
      return (this as any)._src;
    }
  }

  const fn = new Function("state", "Image", `${body}\nreturn sendConnectedPixel;`)(
    state,
    FakeImage,
  ) as () => void;
  return { fn, instances };
}

describe("plugin connected pixel: wire shape", () => {
  it("requests the pixel with the plugin version and the anonymous install ID only", () => {
    expect(ui).toContain("https://figmamcp.dev/c.gif?v=${encodeURIComponent(");
    const line = ui.split("\n").find((l) => l.includes("/c.gif?v="))!;
    expect(line).not.toMatch(/fileKey|documentName|channel|fileName/i);
  });

  it("is wired to the relay's presence notice and to the peer-join fallback", () => {
    const presence = ui.indexOf('data.message === "An MCP client is connected"');
    expect(presence).toBeGreaterThan(-1);
    expect(ui.slice(presence, presence + 150)).toContain("sendConnectedPixel()");

    const peerJoined = ui.indexOf('"A new user has joined the channel"');
    expect(peerJoined).toBeGreaterThan(-1);
    const joinBlock = ui.slice(peerJoined, ui.indexOf("\n              }", peerJoined));
    expect(joinBlock).toContain("sendConnectedPixel()");

    // The plugin's own successful relay join (no MCP client involved: it is
    // the FigmaMCP app's own socket reaching the relay) must not call it.
    const ownJoinedStart = ui.indexOf("// Successfully joined channel");
    const ownJoinBlock = ui.slice(ownJoinedStart, ui.indexOf("\n              }", ownJoinedStart));
    expect(ownJoinBlock).not.toContain("sendConnectedPixel()");
  });

  it("is also retried from the install-id handler, for the race where the id arrives late", () => {
    const start = ui.indexOf('case "install-id":');
    expect(start).toBeGreaterThan(-1);
    const block = ui.slice(start, ui.indexOf("break;", start));
    expect(block).toContain("sendConnectedPixel()");
  });
});

describe("plugin connected pixel: behavior", () => {
  it("fires exactly once even when called repeatedly (same guard as the load pixel)", () => {
    const state: any = { mcpSeen: true, pluginVersion: "0.1.18", installId: "0123456789abcdef" };
    const { fn, instances } = buildSendConnectedPixel(state);
    fn();
    fn();
    expect(instances).toHaveLength(1);
    expect(instances[0].src).toBe("https://figmamcp.dev/c.gif?v=0.1.18&i=0123456789abcdef");
  });

  it("fires in either order: presence seen first and the id arrives late, or the id first", () => {
    const presenceFirst: any = { mcpSeen: true, pluginVersion: "0.1.18", installId: "" };
    const a = buildSendConnectedPixel(presenceFirst);
    a.fn();
    expect(a.instances).toHaveLength(0);
    presenceFirst.installId = "0123456789abcdef";
    a.fn();
    expect(a.instances).toHaveLength(1);

    const idFirst: any = { mcpSeen: false, pluginVersion: "0.1.18", installId: "0123456789abcdef" };
    const b = buildSendConnectedPixel(idFirst);
    b.fn();
    expect(b.instances).toHaveLength(0);
    idFirst.mcpSeen = true;
    b.fn();
    expect(b.instances).toHaveLength(1);
  });

  it("never fires without a known plugin version or a valid install id", () => {
    const noVersion = buildSendConnectedPixel({ mcpSeen: true, pluginVersion: "unknown", installId: "0123456789abcdef" });
    noVersion.fn();
    expect(noVersion.instances).toHaveLength(0);

    const badId = buildSendConnectedPixel({ mcpSeen: true, pluginVersion: "0.1.18", installId: "not-hex" });
    badId.fn();
    expect(badId.instances).toHaveLength(0);
  });
});
