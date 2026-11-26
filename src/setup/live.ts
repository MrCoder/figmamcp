import type { Deps, Live, OpenFile } from './types.js';
import { channelVersionsCompatible, isKnownChannelVersion } from '../shared/channelProtocol.js';

/** Same rule as the relay's VERSION_MISMATCH refusal: only a known version from another release line is outdated. */
export function isOutdated(version: string, f: OpenFile): boolean {
  const v = f.pluginVersion ?? null;
  return isKnownChannelVersion(v) && !channelVersionsCompatible(version, v.trim());
}

/** Files where FigmaMCP is open and usable now (a panel from an older version is refused, so it does not count). */
export function usableFiles(version: string, files: OpenFile[]): OpenFile[] {
  return files.filter((f) => !isOutdated(version, f));
}

/** A FigmaMCP server process: the compiled binary, or the npm build run by node. Not the `figmamcp` CLI itself. */
const SERVER = /(?:^|\/)figmamcp-server(?:\s|$)|\/figmamcp\/dist\/server\.js|\.figmamcp\/[^ ]*dist\/server\.js/;
const CLIENTS: { key: 'claude' | 'codex'; re: RegExp }[] = [
  { key: 'claude', re: /(?:^|\/)claude(?:\s|$)|@anthropic-ai\/claude-code|claude-code\/cli\.js/ },
  { key: 'codex', re: /(?:^|\/)codex(?:\s|$)|@openai\/codex/ },
];

/**
 * Counts running FigmaMCP servers by the AI client that started them, from `ps -Axo pid=,ppid=,command=`.
 * Each client session starts its own server, so 0 for a connected client means it has not loaded FigmaMCP:
 * it was already running when setup wrote its settings, and has to be restarted. The client is found up to
 * four levels up, so `sh -c` and `npx` wrappers are crossed. When some server's client cannot be named,
 * a client with 0 is reported as unknown (null), never as "not loaded".
 */
export function countLoaded(psOut: string): { claude: number | null; codex: number | null } {
  const procs = new Map<number, { ppid: number; cmd: string }>();
  for (const line of psOut.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), cmd: m[3] });
  }
  const counts = { claude: 0, codex: 0 };
  let unknown = 0;
  for (const p of procs.values()) {
    if (!SERVER.test(p.cmd)) continue;
    let owner: 'claude' | 'codex' | null = null;
    let up = procs.get(p.ppid);
    for (let i = 0; i < 4 && up && !owner; i++) {
      owner = CLIENTS.find((c) => c.re.test(up!.cmd))?.key ?? null;
      up = procs.get(up.ppid);
    }
    if (owner) counts[owner]++;
    else unknown++;
  }
  return {
    claude: counts.claude === 0 && unknown > 0 ? null : counts.claude,
    codex: counts.codex === 0 && unknown > 0 ? null : counts.codex,
  };
}

export async function gatherLive(deps: Deps, port: number | null): Promise<Live> {
  let openFiles: OpenFile[] | null = null;
  if (port !== null && deps.openFiles) {
    try {
      openFiles = await deps.openFiles(port);
    } catch {
      openFiles = null; // relay down or busy: no claim either way
    }
  }
  const ps = await deps.exec(['ps', '-Axo', 'pid=,ppid=,command=']);
  return { openFiles, loaded: ps.code === 0 ? countLoaded(ps.stdout) : null };
}
