// Entry of the compiled `figmamcp-relay` program: the local WebSocket relay between the plugin and the server.
// src/socket.ts starts the relay itself when it is the entry module (which a compiled program is), so this
// file only answers --version and --help, whose shared parser looks for package.json on disk, and imports it.
import { SERVER_VERSION } from '../shared/version.js';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log(SERVER_VERSION);
} else if (args.includes('--help')) {
  console.log(`figmamcp-relay ${SERVER_VERSION}
Local relay between the Figma plugin and the MCP server. Started at login by FigmaMCP setup.

Options:
  --port <n>   Port to listen on (default: from ~/.figmamcp/config.json, else 3155)
  --host <ip>  Host to listen on (default: localhost)
  --version    Print version and exit`);
} else {
  await import('../socket.js');
}
