import { readFileSync } from "fs";
import { join } from "path";

/**
 * Asserts version synchronization across version control descriptors:
 * - package.json version
 * - server.json version (top-level)
 * - server.json packages[0].version
 * - manifest.json version
 */
const root = process.cwd();

try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const srv = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
    const man = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

    const versions = {
        "package.json": pkg.version,
        "server.json (top-level)": srv.version,
        "server.json (package version)": srv.packages?.[0]?.version,
        "manifest.json": man.version,
    };

    const distinct = new Set(Object.values(versions));

    if (distinct.size > 1) {
        console.error("Error: version mismatch detected across descriptors!");
        console.error(JSON.stringify(versions, null, 2));
        process.exit(1);
    }

    // MCP Registry: the MCPB download must be this release's bundle, with a real hash.
    const pk = srv.packages?.[0];
    if (pk?.identifier !== undefined) {
        const problems: string[] = [];
        if (!String(pk.identifier).includes(`/v${pkg.version}/`)) problems.push(`identifier does not point at tag v${pkg.version}`);
        if (!String(pk.identifier).includes(`-${pkg.version}-`)) problems.push(`identifier file name does not contain ${pkg.version}`);
        if (!/mcp/i.test(String(pk.identifier))) problems.push('identifier must contain "mcp"');
        if (!/^[0-9a-f]{64}$/.test(String(pk.fileSha256 ?? ""))) problems.push("fileSha256 is not a 64-char hex SHA-256");
        if (problems.length) {
            console.error("Error: server.json package does not match this release:", problems.join("; "));
            process.exit(1);
        }
    }

    console.log(`Success: All version descriptors are synchronized at v${pkg.version}`);
    process.exit(0);
} catch (error: any) {
    console.error("Error: check-versions script encountered a failure:", error.message);
    process.exit(1);
}
