import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The repo's working tree as git sees it, tracked and untracked files alike.
const treeState = () => execSync("git status --porcelain --untracked-files=all", { encoding: "utf8" });

describe("check-versions script regression self-test", () => {
    it("succeeds when all version surfaces are synchronized, and fails on any mismatch", () => {
        // This test must not touch the repo: until 2026-11-19 it wrote into, then deleted,
        // src/mcp_server/tests/unit/temp_version_test, and so deleted files committed there.
        const before = treeState();
        const tempDir = mkdtempSync(join(tmpdir(), "check-versions-"));

        const pkg = { version: "2.3.2" };
        const srv = { version: "2.3.2", packages: [{ version: "2.3.2" }] };
        const man = { version: "2.3.2" };

        const writeFiles = (p: typeof pkg, s: typeof srv, m: typeof man) => {
            writeFileSync(join(tempDir, "package.json"), JSON.stringify(p, null, 2));
            writeFileSync(join(tempDir, "server.json"), JSON.stringify(s, null, 2));
            writeFileSync(join(tempDir, "manifest.json"), JSON.stringify(m, null, 2));
        };

        const runScript = () => {
            const scriptPath = join(process.cwd(), "scripts/check-versions.ts");
            try {
                execSync(`bun run ${scriptPath}`, { cwd: tempDir, stdio: "pipe" });
                return 0;
            } catch (err: any) {
                return err.status || 1;
            }
        };

        // 1. All match -> exit code 0
        writeFiles(pkg, srv, man);
        expect(treeState()).toBe(before);
        expect(runScript()).toBe(0);

        // 2. package.json mismatch -> exit code 1
        writeFiles({ version: "2.3.3" }, srv, man);
        expect(runScript()).toBe(1);

        // 3. server.json top-level mismatch -> exit code 1
        writeFiles(pkg, { version: "2.3.3", packages: [{ version: "2.3.2" }] }, man);
        expect(runScript()).toBe(1);

        // 4. server.json packages[0] mismatch -> exit code 1
        writeFiles(pkg, { version: "2.3.2", packages: [{ version: "2.3.3" }] }, man);
        expect(runScript()).toBe(1);

        // 5. manifest.json mismatch -> exit code 1
        writeFiles(pkg, srv, { version: "2.3.3" });
        expect(runScript()).toBe(1);

        // 6. Registry package: identifier and hash must belong to this release
        const hash = "a".repeat(64);
        const id = "https://github.com/MrCoder/figmamcp-releases/releases/download/v2.3.2/figmamcp-2.3.2-darwin.mcpb";
        const withPkg = (identifier: string, fileSha256: string) => ({
            version: "2.3.2",
            packages: [{ version: "2.3.2", identifier, fileSha256 }],
        });
        writeFiles(pkg, withPkg(id, hash) as any, man);
        expect(runScript()).toBe(0);
        // stale identifier (old release) -> fail
        writeFiles(pkg, withPkg(id.replace(/2\.3\.2/g, "2.3.1"), hash) as any, man);
        expect(runScript()).toBe(1);
        // placeholder / missing hash -> fail
        writeFiles(pkg, withPkg(id, "TODO") as any, man);
        expect(runScript()).toBe(1);

        // Clean up
        rmSync(tempDir, { recursive: true, force: true });
        expect(treeState()).toBe(before);
    });
});
