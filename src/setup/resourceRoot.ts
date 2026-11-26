import path from 'node:path';

/** Where a compiled `figmamcp` finds package.json, the plugin and the skill. */
export function findResourceRoot(exeDir: string, exists: (file: string) => boolean): string {
  const parent = path.dirname(exeDir);
  if (!exists(path.join(exeDir, 'package.json')) && exists(path.join(parent, 'package.json'))) return parent;
  return exeDir;
}
