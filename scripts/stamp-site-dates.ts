// Sets each page's last-updated date from git, in three places that must agree:
// the sitemap <lastmod>, the visible "Last updated:" line and the JSON-LD dateModified.
// A page with uncommitted changes gets today's date (Melbourne). Run before committing
// a content change: `bun run site:dates`. src/mcp_server/tests/siteSeo.test.ts checks they agree.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne" }).format(new Date());

function pageDate(file: string): string {
  if (git("status", "--porcelain", "--", file)) return today;
  return git("log", "-1", "--format=%cs", "--", file) || today;
}

const sitemapPath = join(root, "site/sitemap.xml");
let sitemap = readFileSync(sitemapPath, "utf8");
let changed = 0;
for (const [, loc] of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
  const path = new URL(loc).pathname;
  const file = path === "/" ? "site/index.html" : `site${path}/index.html`;
  const date = pageDate(file);
  sitemap = sitemap.replace(new RegExp(`(<loc>${loc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</loc><lastmod>)[^<]+`), `$1${date}`);
  const html = readFileSync(join(root, file), "utf8");
  const next = html
    .replace(/(<p class="[^"]*\bupdated\b[^"]*">[^<]*<time datetime=")[^"]+(">)[^<]+(<\/time>)/, `$1${date}$2${date}$3`)
    .replace(/"dateModified":"[^"]+"/, `"dateModified":"${date}"`);
  if (next !== html) {
    writeFileSync(join(root, file), next);
    changed++;
  }
}
writeFileSync(sitemapPath, sitemap);
console.log(`Stamped dates on ${changed} pages and the sitemap.`);
