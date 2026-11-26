import path from 'node:path';
import type { Deps } from './types.js';
import { PLUGIN_ID, figmaSettingsPath } from './plan.js';

export interface ImportContext {
  manifestPath: string;
  deps: Deps;
  /** `--restart-figma`: quit Figma gracefully, write, and open it again. */
  restartFigma?: boolean;
  /** Path of Figma.app, used to open it again. */
  figmaApp?: string | null;
}

export interface ImportResult {
  /** 'pending' = nothing is wrong, but the user (or --restart-figma) must still act. */
  status: 'ok' | 'fail' | 'pending';
  /** Machine-readable state: registered | needs-figma-restart | needs-figma-launch. */
  state?: string;
  /** Lines shown under the "Figma plugin" step. */
  lines: string[];
}

/**
 * The seam for getting the plugin into Figma. `registryImporter` writes Figma's own plugin registry;
 * `manualImporter` is the old hand-import instructions, kept as a fallback.
 */
export interface PluginImporter {
  id: string;
  run(ctx: ImportContext): Promise<ImportResult>;
}

// ---------------------------------------------------------------- registry (pure)

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface RegistryView {
  /** The whole parsed settings object (only meaningful when !malformed). */
  settings: Json;
  list: Json[];
  registered: boolean;
  malformed: boolean;
}

/** The three files Figma needs for one plugin, in the order manifest, code, ui. */
export function pluginPaths(pluginDir: string): [string, string, string] {
  return [path.join(pluginDir, 'manifest.json'), path.join(pluginDir, 'code.js'), path.join(pluginDir, 'ui.html')];
}

export function inspectRegistry(text: string, pluginDir: string): RegistryView {
  const bad: RegistryView = { settings: {}, list: [], registered: false, malformed: true };
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return bad;
  }
  if (!isObj(settings)) return bad;
  const raw = settings.localFileExtensions;
  if (raw !== undefined && (!Array.isArray(raw) || !raw.every(isObj))) return bad;
  const list = (raw ?? []) as Json[];
  const [manifest, code, ui] = pluginPaths(pluginDir);
  const m = list.find((e) => e.manifestPath === manifest && isObj(e.fileMetadata) && e.fileMetadata.type === 'manifest');
  let registered = false;
  if (m && isObj(m.fileMetadata)) {
    const meta = m.fileMetadata;
    const c = list.find((e) => e.id === meta.codeFileId);
    const uiId = Array.isArray(meta.uiFileIds) ? meta.uiFileIds[0] : undefined;
    const u = list.find((e) => e.id === uiId);
    registered =
      !!c && c.manifestPath === code && isObj(c.fileMetadata) && c.fileMetadata.type === 'code' && c.fileMetadata.manifestFileId === m.id &&
      !!u && u.manifestPath === ui && isObj(u.fileMetadata) && u.fileMetadata.type === 'ui' && u.fileMetadata.manifestFileId === m.id;
  }
  return { settings, list, registered, malformed: false };
}

/** Adds the three linked entries. Every other key and entry is kept; a half-registered copy of ours is replaced. */
export function withRegistration(view: RegistryView, pluginDir: string): Json {
  const paths = pluginPaths(pluginDir);
  const maxId = view.list.reduce((m, e) => (typeof e.id === 'number' && e.id > m ? e.id : m), 0);
  const n = maxId + 1;
  const kept = view.list.filter((e) => !(typeof e.manifestPath === 'string' && paths.includes(e.manifestPath)));
  const [manifest, code, ui] = paths;
  const added: Json[] = [
    {
      id: n,
      manifestPath: manifest,
      lastKnownName: 'FigmaMCP',
      lastKnownPluginId: PLUGIN_ID,
      fileMetadata: { type: 'manifest', codeFileId: n + 1, uiFileIds: [n + 2] },
      cachedContainsWidget: false,
    },
    { id: n + 1, manifestPath: code, fileMetadata: { type: 'code', manifestFileId: n } },
    { id: n + 2, manifestPath: ui, fileMetadata: { type: 'ui', manifestFileId: n } },
  ];
  return { ...view.settings, localFileExtensions: [...kept, ...added] };
}

function serialize(original: string, next: Json): string {
  const indent = /^\{\r?\n([ \t]+)"/.exec(original)?.[1];
  return JSON.stringify(next, null, indent) + (original.endsWith('\n') ? '\n' : '');
}

// ---------------------------------------------------------------- registry importer

async function readText(deps: Deps, p: string): Promise<string | null> {
  try {
    return (await deps.fs.readFile(p)).toString('utf8');
  } catch {
    return null;
  }
}

async function isRunning(deps: Deps): Promise<boolean | 'unknown'> {
  const r = await deps.exec(['pgrep', '-x', 'Figma']);
  return r.code === 0 ? true : r.code === 1 ? false : 'unknown';
}

const QUIT_WAIT_MS = 30000;

export const registryImporter: PluginImporter = {
  id: 'registry',
  async run({ manifestPath, deps, restartFigma, figmaApp }) {
    const settingsPath = figmaSettingsPath(deps.home);
    const pluginDir = path.dirname(manifestPath);
    const read = async () => {
      const text = await readText(deps, settingsPath);
      return text === null ? null : { text, view: inspectRegistry(text, pluginDir) };
    };

    let cur = await read();
    if (!cur) {
      return { status: 'pending', state: 'needs-figma-launch', lines: ['Figma has not been opened on this Mac yet. Open it once, then run this command again.'] };
    }
    if (cur.view.malformed) return malformed(settingsPath);
    if (cur.view.registered) return done('registered', ['The plugin is already registered in Figma.']);

    // Figma rewrites this file from memory while it runs and when it quits, so it is only safe to edit while Figma is closed.
    let weQuit = false;
    if ((await isRunning(deps)) !== false) {
      if (!restartFigma) {
        return {
          status: 'pending',
          state: 'needs-figma-restart',
          lines: [
            'Figma is open, and it overwrites its plugin list while it runs, so FigmaMCP has not touched it.',
            'Quit Figma (Cmd+Q), then run this command again. Or run it with --restart-figma and FigmaMCP will quit and reopen Figma for you.',
          ],
        };
      }
      const q = await deps.exec(['osascript', '-e', 'tell application "Figma" to quit']);
      if (q.code !== 0) {
        return failed('FigmaMCP could not ask Figma to quit.', 'Quit Figma yourself (Cmd+Q), then run this command again.');
      }
      weQuit = true;
      let closed = false;
      for (let waited = 0; waited <= QUIT_WAIT_MS; waited += 500) {
        if ((await isRunning(deps)) === false) {
          closed = true;
          break;
        }
        await deps.sleep(500);
      }
      if (!closed) {
        return failed('Figma did not quit (it may be asking whether to save).', 'Answer the question in Figma or quit it yourself, then run this command again.');
      }
      cur = await read(); // Figma wrote the file while quitting: start from what it wrote.
    }

    try {
      if (!cur) return failed('Figma’s settings file disappeared while Figma quit.', 'Open Figma once, then run this command again.');
      if (cur.view.malformed) return malformed(settingsPath);
      if (!cur.view.registered) {
        const next = serialize(cur.text, withRegistration(cur.view, pluginDir));
        await deps.fs.writeFile(`${settingsPath}.figmamcp-backup`, cur.text);
        const tmp = `${settingsPath}.figmamcp-tmp-${deps.pid}`;
        await deps.fs.writeFile(tmp, next);
        await deps.fs.rename(tmp, settingsPath);
        const check = await read();
        if (!check || !check.view.registered) return failed('Figma’s plugin list did not take the change.', `Your original settings are saved at ${settingsPath}.figmamcp-backup.`);
      }
    } finally {
      if (weQuit) await deps.exec(figmaApp ? ['open', figmaApp] : ['open', '-a', 'Figma']);
    }
    return done('registered', [
      weQuit ? 'Registered the plugin and reopened Figma.' : 'Registered the plugin in Figma.',
      'In any Figma file choose Plugins > Development > FigmaMCP.',
    ]);
  },
};

function done(state: string, lines: string[]): ImportResult {
  return { status: 'ok', state, lines };
}

function failed(message: string, fix: string): ImportResult {
  return { status: 'fail', lines: [message, fix] };
}

function malformed(settingsPath: string): ImportResult {
  return failed(`Figma’s settings file (${settingsPath}) is not in the expected shape, so FigmaMCP left it untouched.`, 'Open Figma once so it rewrites its settings, then run this command again.');
}

// ---------------------------------------------------------------- manual fallback

export const manualImporter: PluginImporter = {
  id: 'manual',
  async run({ manifestPath, deps }) {
    const copied = (await deps.exec(['pbcopy'], { input: manifestPath })).code === 0;
    return {
      status: 'ok',
      lines: [
        'Do this once in the Figma desktop app (about 20 seconds):',
        '1. Open any Figma or FigJam file.',
        '2. Choose Plugins > Development > Import plugin from manifest...',
        copied
          ? '3. In the file picker press Cmd+Shift+G, paste (the path is already on your clipboard), press Return, then Open.'
          : '3. In the file picker press Cmd+Shift+G, type this path, press Return, then Open:',
        `   ${manifestPath}`,
        '4. Start it with Plugins > Development > FigmaMCP.',
      ],
    };
  },
};

export function chooseImporter(): PluginImporter {
  return registryImporter;
}
