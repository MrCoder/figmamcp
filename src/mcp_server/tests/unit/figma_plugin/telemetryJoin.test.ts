import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";

const ui = readFileSync("figma_plugin/ui.html", "utf8");

// Runs ui.html's real connectToServer against a fake WebSocket and returns the join frame it sends.
// The relay sends the usage events, so the plugin's install ID must reach it in the join.
function joinFrame(state: any): any {
  const start = ui.indexOf("    function connectToServer(port)");
  const end = ui.indexOf("\n    function disconnectFromServer", start);
  const validStart = ui.indexOf("    function validInstallId()");
  const validEnd = ui.indexOf("\n    }\n", validStart) + 6;
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(validStart).toBeGreaterThan(-1);
  const sent: string[] = [];
  class FakeWebSocket {
    onopen: any;
    constructor(public url: string) {}
    send(data: string) { sent.push(data); }
  }
  const body = `${ui.slice(validStart, validEnd)}\n${ui.slice(start, end)}\nreturn connectToServer;`;
  const noop = () => {};
  const connect = new Function("state", "WebSocket", "generateChannelName", "setView", "scheduleRetry", "renderSessions", "parent", body)(
    state, FakeWebSocket, () => "chan", noop, noop, noop, { postMessage: noop },
  );
  connect(3155);
  state.socket.onopen();
  return JSON.parse(sent[0]);
}

describe("plugin join frame: telemetry fields", () => {
  it("carries the random install ID and the window ID", () => {
    const frame = joinFrame({ fileKey: "FileKey1", fileName: "Design", pluginVersion: "0.1.24", installId: "0123456789abcdef", pluginSession: "abc123def456" });
    expect(frame).toMatchObject({ type: "join", clientType: "plugin", installId: "0123456789abcdef", pluginSession: "abc123def456" });
  });

  it("leaves the install ID out until it is a valid one", () => {
    const frame = joinFrame({ fileKey: "FileKey1", pluginVersion: "0.1.24", installId: "", pluginSession: "abc123def456" });
    expect(frame.installId).toBeUndefined();
  });

  it("sends the install ID to the relay when it arrives after the join", () => {
    const start = ui.indexOf('case "install-id":');
    const block = ui.slice(start, ui.indexOf("break;", start));
    expect(block).toContain("sendPluginStatus({ installId: state.installId })");
  });
});
