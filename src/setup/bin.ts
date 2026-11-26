// Entry for the `figmamcp` bin. Keep this file free of output on the server path: stdout is the MCP channel.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { resourcesArg, route } from './main.js';

const argv = process.argv.slice(2);
const target = route(argv);
const here = path.dirname(fileURLToPath(import.meta.url));

if (target === 'server') {
  // Same process, same argv: the server's own --version/--help/--port handling is unchanged.
  await import(pathToFileURL(path.join(here, 'server.js')).href);
} else {
  const { findPkgRoot } = await import('./deps.js');
  const { runSetupCommand } = await import('./launch.js');
  process.exitCode = await runSetupCommand(argv, resourcesArg(argv) ?? findPkgRoot(here), false);
}
