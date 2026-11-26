// Entry of the compiled `figmamcp-server` program: the MCP server on stdio. stdout is the MCP channel.
// --version and --help are answered here because the shared option parser looks for package.json on disk.
import { SERVER_VERSION } from '../shared/version.js';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log(SERVER_VERSION);
} else if (args.includes('--help')) {
  console.log(`figmamcp-server ${SERVER_VERSION}
MCP server for FigmaMCP (stdio). Started by Claude Code or Codex; you do not run it yourself.

Options:
  --port <n>   Relay port (default: the one setup recorded in ~/.figmamcp/config.json)
  --version    Print version and exit`);
} else {
  await import('../mcp_server/server.js');
}
