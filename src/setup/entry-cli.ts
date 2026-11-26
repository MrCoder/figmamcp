// Entry of the compiled `figmamcp` program (bun build --compile). No Node.js is needed to run it.
// It only does setup / doctor / status; the MCP server and the relay are their own programs.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { resourcesArg, route } from './main.js';
import { HELP } from './render.js';
import { runSetupCommand } from './launch.js';
import { findResourceRoot } from './resourceRoot.js';
import { SERVER_VERSION } from '../shared/version.js';

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  console.log(SERVER_VERSION);
} else if (route(argv) === 'server') {
  // Bare invocation (or --help): there is no server in this program, so show how to use it.
  process.stdout.write(HELP);
} else {
  // Resources (plugin, skill, package.json) sit next to the program, or one level up in ~/.figmamcp,
  // unless --resources says otherwise.
  const exeDir = path.dirname(realpathSync(process.execPath));
  process.exitCode = await runSetupCommand(argv, resourcesArg(argv) ?? findResourceRoot(exeDir, existsSync), true);
}
