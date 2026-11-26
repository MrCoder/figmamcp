import { SERVER_VERSION } from './shared/version.js';
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Setup records the port it picked; everything else follows it.
export function resolveDefaultPort(home: string = homedir()): number {
  try {
    const { port } = JSON.parse(readFileSync(join(home, ".figmamcp", "config.json"), "utf-8"));
    if (Number.isInteger(port)) return port;
  } catch {
    // No config yet, or an unreadable one: use the default.
  }
  return 3155;
}

export function parseCliArgs(binName: string) {
  const args = process.argv.slice(2);

  if (args.includes('--version')) {
    console.log(SERVER_VERSION);
    process.exit(0);
  }

  if (args.includes('--help')) {
    console.log(`${binName}
Usage: ${binName} [options]
       ${binName} setup [--dry-run]   Install and connect everything (macOS)
       ${binName} doctor              Check each setup step, change nothing

Options:
  --version    Print version and exit
  --help       Print this help message and exit
  --host <ip>  Set WebSocket host (default: "localhost", env: FIGMAMCP_SOCKET_HOST)
  --port <n>   Set WebSocket port (default: from setup, or 3155, env: FIGMAMCP_SOCKET_PORT)`);
    process.exit(0);
  }

  let port = process.env.FIGMAMCP_SOCKET_PORT ? parseInt(process.env.FIGMAMCP_SOCKET_PORT, 10) : resolveDefaultPort();
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1 && args[portIdx + 1]) {
    port = parseInt(args[portIdx + 1], 10);
  }

  let host = process.env.FIGMAMCP_SOCKET_HOST || "localhost";
  const hostIdx = args.indexOf('--host');
  if (hostIdx !== -1 && args[hostIdx + 1]) {
    host = args[hostIdx + 1];
  }

  return { port, host };
}
