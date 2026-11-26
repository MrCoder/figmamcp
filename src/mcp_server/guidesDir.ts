import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Finds skills/figmamcp/references/. An npm install keeps it near the bundled module;
 * a compiled program has a virtual module path, so it looks next to the executable and, for the installed bin/ layout, one level up.
 */
export function resolveGuidesDir(moduleUrl: string, execPath: string, exists: (url: URL) => boolean): URL {
    const relative = "skills/figmamcp/references/";
    const candidates = [
        new URL(`../${relative}`, moduleUrl),
        new URL(`../../${relative}`, moduleUrl),
        new URL(relative, pathToFileURL(path.dirname(execPath) + "/")),
        new URL(`../${relative}`, pathToFileURL(path.dirname(execPath) + "/")),
    ];
    return candidates.find(exists) ?? candidates[0];
}
