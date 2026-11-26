import { realDeps } from './deps.js';
import { runCli } from './main.js';

/** Runs setup / doctor / status against the real machine and returns the exit code. */
export async function runSetupCommand(argv: string[], pkgRoot: string, binary: boolean): Promise<number> {
  const deps = realDeps(pkgRoot, binary);
  return runCli(argv, deps, {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
}
