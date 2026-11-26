# SEO plan, 2026-11-20 to 2026-12-20 (Melbourne time)

Owner ask (2026-11-20): say what SEO work is done, then plan the rest and build it steadily. The weekday build block (`figmamcp-build-block`) takes one item per day from the queue below.

## What exists (checked 2026-11-20 against `site/` and git history)

| Area | State | Evidence |
|---|---|---|
| SEO audit | Done once, fixes merged. Not re-run since the 15 pages of 2026-11-13 and the 8 locale homepages | PRs #41, #48, #51, #53 |
| Keyword pages from Google autocomplete | 35 pages live (P0-P2 plus the 2026-11-13 batch) | `seo-keyword-map.md` |
| Tools pages | 7 live: write, variables, components, auto-layout, design-system, export, prototype | `site/tools/` |
| Alternatives and compare pages | `/alternatives/*` (3), `/compare/*` (9 incl. Figwright), `/figma-mcp-alternative` | `site/alternatives`, `site/compare` |
| Competitor GTM scan | Done (2026-11-20). Output went to outreach drafts and the Figwright page. Doop and Desigma judged not alternatives, no page | `week2-x-and-outreach.md` |
| Tutorial pages | **None.** Zenn tutorial is a draft for the owner, not a site page | no `site/tutorials/` |
| Real Search Console queries | **Not used yet.** The keyword map came from autocomplete only | `seo-keyword-map.md` header |
| Locale homepages | 8 live (ja, zh, zh-hant, de, fr, ko, pl, uk) | `site/*/index.html` |

## What the data says (Search Console, week to 2026-11-16, from `figmamcp-ops/data.js`)

| Page | Query | Impressions | Clicks | Position |
|---|---|---|---|---|
| `/what-is-figma-mcp` | figma mcp server | 198 | 0 | 14.7 |
| `/troubleshooting/not-working` | figma mcp not working | 188 | 3 | 7.9 |
| `/pricing` | figma mcp pricing | 107 | 1 | 8.7 |
| `/figma-mcp-limit-reached` | figma mcp limit reached | 65 | 0 | 8.8 |
| all pages | | 663 | 6 | |

Observed: 0.9% click rate overall. Four pages sit at position 8-9 with almost no clicks. Not yet known: whether titles and descriptions are the cause (a guess until a rewrite is measured). More pages will not fix this; the plan's "not now" list already says so.

## Queue (one item per weekday build block, in order)

| # | Item | Why | Done when |
|---|---|---|---|
| S1 | Rewrite title and meta description of the 6 pages with most impressions (list above plus `/compare/official-figma-mcp`, `/tools`) in one PR | Position 8-9 with 0-1% clicks | Live, then re-read Search Console after 14 days |
| S2 (done 2026-11-20) | Pull real Search Console queries (Search Console UI export, or API if a token exists; else ask owner for one CSV export, 2 min) and update `seo-keyword-map.md` with queries people actually used | Autocomplete shows phrasing, not demand | Map has a "real queries" table |
| S3 | Re-run the `searchfit-seo:seo-audit` on all 63 pages; fix what is safe, list the rest | 15 pages and 8 locales added after the last audit | Report in `documentation/future/`, fixes merged |
| S4 | Tutorial 1: "Edit a Figma file with Claude Code in 5 minutes" with the plugin demo video, numbered steps, HowTo schema | Search intent "how to" has no page; links to setup | Live at `/tutorials/edit-figma-with-claude-code` |
| S5 | Tutorial 2: "Run a design QA pass on a Figma file" (skill `figma-design-qa`, the 1.7 to 10.0 run on Conf App (Copy)) | Real result, shows the product, not a feature list | Live, claims match the run |
| S6 | Tutorial 3: spec to frames, and rename layers (one page each, short) | Skills exist in the public releases repo | Live, linked from `/tools` and `/use-cases` |
| S7 | `/tutorials` hub plus links from home, `/docs/setup`, `/use-cases`; add to sitemap, `llms.txt`, IndexNow | Orphan check | Hub in sitemap, 0 orphans |
| S8 | Competitor-driven pages, only where the scan found a real searcher intent: "FigmaMCP vs Figma's own AI", FAQ line on Doop and Desigma on the home FAQ | GTM scan, searcher intent not yet verified | Research note first; page only if a query exists in S2 data |
| S9 | Weekly: autocomplete rerun and Search Console read (list queries with impressions but no page that answers them; add a row for each real one); prune or merge pages with 0 impressions after 30 days | Keep the site small | Row added to the log below |
| S10 | `/troubleshooting/not-working`: add a "Claude's Figma connector not working" section; `/compare/official-figma-mcp`: add "Figma desktop MCP server" to a heading and the meta description, plus `com.figma.mcp/mcp`; `/compare/framelink`: add `figma-developer-mcp` | S2: connector query at 8.7 with no matching text; "figma desktop mcp" at 47 with no owner page | Live; re-read the two queries on 2026-12-04 |
| S11 | Strengthen `/what-is-figma-mcp` for the head term "figma mcp": internal links with anchor "Figma MCP" from home, `/tools`, `/pricing`, `/docs/setup`; check the page answers "what is Figma MCP" in the first paragraph | S2: 137 of 138 head-term impressions show this page, at 13.5 | Live; position for "figma mcp" read on 2026-12-04 |
| S12 | On 2026-12-08: if `/figma-mcp-free-plan` still has 0 impressions, merge it into `/pricing` with a 301 and move any unique content | S2: "free" intent lands on `/pricing` (68 of 70) | Decision logged; redirect live if merged |
| S13 | On 2026-12-04, if "figma desktop mcp" is still worse than position 20 after S10, build `/figma-desktop-mcp` (what the Figma desktop MCP server is and how it differs from FigmaMCP; official facts carry a check date and source link) | Teardown 2026-11-22 (G1): query "figma desktop mcp", 11 impressions at position 47.1; official docs have separate local and remote install pages | Live; position re-read after 14 days. Note: `competitor-site-teardown-2026-11-22.md` |
| S14 | Add "Tools not loading" and "Slow or stuck" sections to `/troubleshooting/not-working`, from our own runs and issues only | Teardown 2026-11-22 (G2): "figma mcp not working" 188 impressions at 7.9; "claude figma connector not working" 11 at 8.7; official docs have a page per symptom (inference: more specific headings may help; untested) | Live; clicks re-read on 2026-12-18 |

Rules unchanged: wording rules in memory (no "unlimited", no "bypass", no open-source claim), official limits carry a check date, claim only what was tested, one main keyword per page. Blocked integration pages stay blocked until `npx figmamcp` exists.

## Measurement

| Metric | Baseline 2026-11-16 | Target 2026-12-14 (a target, not a forecast) |
|---|---|---|
| Search impressions per week | 663 | 2,000 |
| Search clicks per week | 6 | 40 |
| Indexed pages (Search Console) | 12 of 14 sitemap URLs on 11-14 | all content pages in the sitemap |

Log (append one dated line per shipped item):

- 2026-11-20: plan written.
- 2026-11-20: S1 shipped, PR #75 merged and deployed (6 titles/metas rewritten, title-length test added). Live titles verified by curl. Re-read Search Console on 2026-12-04. PR #13 closed as superseded.
- 2026-11-20: S2 done. Read 111 real queries in Search Console (11-08 to 11-17) in the owner's signed-in Chrome, no export needed. Added "Real queries" to `seo-keyword-map.md`. Results: free intent lands on `/pricing`, not `/figma-mcp-free-plan`; head term "figma mcp" goes to `/what-is-figma-mcp` at 13.5; "figma desktop mcp" has no owner page. Added S10-S12. S8: no query for Doop, Desigma or Figma AI, so no page.
- 2026-11-21: S10 and S11 done. S10: added "Claude's Figma connector not working" to `/troubleshooting/not-working`; added a "Figma desktop MCP server and com.figma.mcp/mcp" heading and description text to `/compare/official-figma-mcp`; added `figma-developer-mcp` to `/compare/framelink`. S11: `/what-is-figma-mcp` first paragraph now starts "Figma MCP is..."; added "Figma MCP" anchor links from home, `/tools`, `/pricing` and `/docs/setup`. Re-read the connector and "figma desktop mcp" queries on 2026-12-04.
- 2026-11-21: S4 shipped. `/tutorials/edit-figma-with-claude-code` ("Edit a Figma file with Claude Code in 5 minutes"): demo video, 2 real screenshots, 7 steps, HowTo + BreadcrumbList JSON-LD; linked from `/docs/setup` and `/use-cases`; in sitemap and `llms.txt`. PR #89 into the product branch, PR #90 to main, deployed (version b24cb945), IndexNow HTTP 200 for 61 URLs. Live: 200 and H1 verified by curl. The `/tutorials` hub and its breadcrumb wait for S7.
- 2026-11-21: S5 shipped. `/tutorials/design-qa-figma-file` ("Run a design QA pass on a Figma file with an AI agent"): 7 steps from the `figma-design-qa` skill, the 6 rubric categories, and the rubric's worked example (live run 2026-11-20 on a sign-up card built messy on purpose, 1.7 to 5.2 to 7.7 to 10.0); HowTo + BreadcrumbList JSON-LD; linked from `/tools`, `/use-cases` and the S4 tutorial; in sitemap and `llms.txt`. A test checks that the page's scores equal the rubric's table. The page does not name the Figma file: no run note ties the run to "Conf App (Copy)". PR #92 into the product branch. Merged #92 and sync #94 (main 08fb23c) on local bun test (1563 pass) because GitHub Actions was blocked by billing; deployed version 60642c7c; live 200, H1 present, linked from /tools, /use-cases, S4 tutorial, in sitemap.
- 2026-11-21: S3 done. Audited all 64 HTML files (61 in the sitemap) for titles, descriptions, headings, canonical, OG/Twitter, hreflang, JSON-LD, images, internal links, orphans, sitemap, robots.txt and `llms.txt`. Found 23 defects and fixed all of them: 21 sitemap URLs missing from `llms.txt`, and 2 `twitter:description` values that differed from `og:description`. Added 11 red-proved checks to `siteSeo.test.ts`. Report: `seo-audit-2026-11-21.md` (6 items for owner judgment, including thin linking to 6 pages). PR #93 into the product branch; GitHub Actions blocked by billing, so merged on a green local run (bun test 1567 pass, plus every ci.yml check).
- 2026-11-21: S6 shipped. `/tutorials/spec-to-figma-frames` ("Turn a written spec into Figma frames with an AI agent", 7 steps) and `/tutorials/rename-figma-layers` ("Rename Figma layers with an AI agent", 8 steps), from the `figma-spec-to-frames` and `figma-rename-layers` skills in the releases repo. Both skills' worked examples are expected calls, not recorded runs, so each page says so and claims no result. HowTo + BreadcrumbList JSON-LD; linked from `/tools` and `/use-cases`; in sitemap and `llms.txt`. Audit item 1 done in the same PR: `/compare/figwright`, `/compare/code-connect`, `/figma-mcp-starter-plan`, `/tools/components`, `/tools/auto-layout` and `/tools/prototype` now each have in-body links from 2 or more indexable pages (a test enforces it). PR #96 into the product branch.
- 2026-11-21: S7 shipped. `/tutorials` hub (CollectionPage + ItemList of the 4 tutorials + BreadcrumbList), linked from home, `/docs/setup` and `/use-cases`; all 4 tutorials now have the breadcrumb Home > Tutorials > page. In sitemap and `llms.txt`; 0 orphans. Same PR #96; GitHub Actions still blocked by billing, so merged on a green local run (bun test 1584 pass, 0 fail on the merged head, plus every ci.yml check).
- 2026-11-21: S6 and S7 deployed. Sync PR #97 to main (fe9f415); deployed with `bun run deploy:site` from a detached origin/main worktree, version 4b4845d2-319d-4a84-b92a-416a4269de68, IndexNow HTTP 200 for 65 URLs. Live by curl: `/tutorials` and all 4 tutorials 200 with the right H1; all 4 tutorials show the Tutorials breadcrumb; hub linked from home, `/docs/setup`, `/use-cases` and `/tools`; hub links all 4; 5 `/tutorials` URLs in the sitemap and `llms.txt`; the 7 audit item 1 links present. Re-read Search Console for the tutorial pages on 2026-12-05.
- 2026-11-23: S14 shipped (logged late; found by the build block). `/troubleshooting/not-working` has "Tools not loading" and "Slow or stuck" sections. PR #149 merged straight to `main` (84cefd0) on 2026-11-22, not into the product branch; main CI green. Live by curl: both H2s present, title "Figma MCP not working? 14 symptoms with fixes", canonical correct, URL in sitemap. Re-read "not working" clicks on 2026-12-18. Note: `main` is 6 site commits ahead of the product branch (#149-#154).
- 2026-11-24: S9 weekly run. Search Console (domain property, owner's signed-in Chrome, read only), 7 days 11-15 to 11-21 (latest data available; last update 5.5 hours before the read): 667 impressions, 11 clicks, CTR 1.6%, average position 14, versus the 663 impressions and 6 clicks baseline of 2026-11-16 (the two windows overlap, so this is not independent). Top queries: "figma mcp free" 11 impressions with 2 clicks, "figmamcp" 13/1, "free figma mcp" 7/1, "is figma mcp free" 35, "figma mcp pricing" 34, "figma mcp" 32 (head term; 0 clicks), "figma mcp tools" 14, "figma mcp server" 13, "figma mcp without dev mode" 8. 85 queries in all. "figma desktop mcp" and the connector query are not in the top 10; not read separately (the Search Console URL query filter did not apply), so no move to report. Pages: 30 with impressions, led by `/pricing` 238 (5 clicks), `/figma-mcp-limit-reached` 81, `/what-is-figma-mcp` 72 (0 clicks), `/` 65 (1), `/figma-mcp-without-dev-mode` 62 (4 clicks, new in the data); `/figma-mcp-free-plan` 9 impressions, 0 clicks (it had 0 impressions on the S2 read; S12 decides on 2026-12-08). Autocomplete rerun by curl (8 seeds, `hl=en`, `gl=us`): "figma mcp" suggestions are now server, claude code, claude, limits, rate limit, cursor, setup, cost, codex; "figma desktop mcp" still suggests server, server not working, setup, github, claude, claude code, cursor, codex, opencode; "figma mcp not working" suggests cursor, server, claude figma mcp not working, claude code figma mcp not working; "figma mcp rate limit" still suggests reset, reddit, check, bypass, server, api, claude, local, remote. No comparison against the 2026-11-13 suggestion list was made in this run beyond the seeds above. Prune: 49 sitemap URLs show 0 impressions, but the oldest was first committed on 2026-11-09 (`/integrations/claude-code`, 15 days), so none is 30 days old and nothing was pruned or merged. Re-check on 2026-12-01.
