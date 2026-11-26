import { describe, it, expect } from 'bun:test';
import { askRelayForOpenFiles } from '../../../../setup/deps.js';

describe('askRelayForOpenFiles', () => {
  it('keeps the plugin version the relay reports for each open file', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: 'localhost',
      fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response('no', { status: 400 }); },
      websocket: {
        message(ws, msg) {
          const data = JSON.parse(String(msg));
          ws.send(JSON.stringify({ type: 'system', message: 'hello' }));
          ws.send(JSON.stringify({ type: 'channel_list', id: data.id, channels: [
            { channel: 'k1', fileName: 'A', pluginVersion: '0.1.0', mcpCount: 2, completedCalls: 5 },
            { channel: 'k2', fileName: '', pluginVersion: 'unknown', mcpCount: 0 },
          ] }));
        },
      },
    });
    try {
      const files = await askRelayForOpenFiles(server.port, 2000);
      expect(files).toEqual([
        { fileName: 'A', aiSessions: 2, pluginVersion: '0.1.0', completedCalls: 5 },
        { fileName: null, aiSessions: 0, pluginVersion: 'unknown', completedCalls: null },
      ]);
    } finally {
      server.stop(true);
    }
  });

  it("never announces itself as an MCP client (doctor/status is read-only, not an AI session)", async () => {
    // askRelayForOpenFiles opens its own socket, independent of figma-client.ts's
    // shared connection — it must never trip the "connected" pixel's presence
    // signal, or every install would report a client connected at all times.
    const received: any[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "localhost",
      fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
      websocket: {
        message(ws, msg) {
          const data = JSON.parse(String(msg));
          received.push(data);
          ws.send(JSON.stringify({ type: "channel_list", id: data.id, channels: [] }));
        },
      },
    });
    try {
      await askRelayForOpenFiles(server.port, 2000);
      expect(received).toEqual([{ type: "list_channels", id: "figmamcp-status" }]);
    } finally {
      server.stop(true);
    }
  });
});
