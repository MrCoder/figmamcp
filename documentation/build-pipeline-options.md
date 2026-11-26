# Build pipeline options: can the Mac release move off the owner's Mac?

Status: research and proof of concept, 2026-11-19 (Melbourne); option E added 2026-11-20. The live release path is unchanged:
[CONTRIBUTING.md § Versioning and releases](../CONTRIBUTING.md#versioning-and-releases).

**Recommendation:** use GitHub Actions macOS runners (option C) for the build, the signing and the
notarization. Keep the current local path (option A) as the release path until a full signed and
notarized run passes in CI. Do not use Xcode Cloud (option B): its cloud signing cannot sign the DMG
or the Bun helper binaries, so it needs the same exported certificate as GitHub Actions, and it adds
an Xcode project, an App Store Connect app record and a manual artifact upload on top. Do not use a
Claude Code cloud session (option E) either: it runs only on Linux, which cannot compile the Swift app
shell, and it can hold signing keys only as environment variables that the agent can read.

## 1. Current pipeline

```
 owner's Mac (an AI session runs every step)
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ bun run build:all ──► scripts/build-binaries.sh ──► app/build.sh         │
 │ (server, relay,       (bun --compile arm64 + x64,   (swift build, .app,  │
 │  plugin)               lipo → dist-bin/universal)     codesign, DMG)     │
 │                                                          │               │
 │                       app/build.sh notarize ◄────────────┘               │
 │                       (notarytool + keychain profile "figmamcp",         │
 │                        staple app, rebuild DMG, staple DMG, spctl)       │
 └───────────────┬─────────────────────────────────────────────────────────┘
                 ▼
  gh release create/upload ──► MrCoder/figmamcp-releases (DMG, .mcpb, server.json)
                                   └─► mcp-registry.yml (GitHub OIDC) ──► MCP Registry
```

| Part | What it is | Where |
|---|---|---|
| Mac app shell | SwiftPM package (`app/Package.swift`), macOS 14+, no `.xcodeproj` | `app/Sources` |
| Bundled programs | `figmamcp`, `figmamcp-server`, `figmamcp-relay`, compiled with `bun build --compile`, fat binaries via `lipo` | `scripts/build-binaries.sh` |
| `.app` assembly | Hand-built by `app/build.sh` (copies binaries into `Contents/Resources/bin`, writes `Info.plist`) | `app/build.sh` |
| Signing | `Developer ID Application: Peng Xiao (V7P333H7L7)`, hardened runtime, inside-out; the Bun programs get `BunRuntime.entitlements` (JIT) | owner's login keychain |
| Notarization | `xcrun notarytool submit --keychain-profile figmamcp --wait`, app first, then DMG; both stapled | owner's keychain profile |
| Publish | `gh release` to `MrCoder/figmamcp-releases`; `mcp-registry.yml` there publishes `server.json` with GitHub OIDC | GitHub |
| CI today | `ci.yml` on `ubuntu-latest`: tests, build, checks. No Mac build. `publish.yml` is the old npm workflow and is not used | GitHub Actions |

Steps that need the owner's Mac today: the Developer ID private key (login keychain) and the
notarytool keychain profile. Nothing else is tied to that machine.

## 2. Xcode Cloud: fit check

Sources are Apple's documentation unless marked "forum".

| Question | Finding | Evidence |
|---|---|---|
| Builds Mac apps for distribution outside the Mac App Store? | Partly. An archive action exports a Developer ID–signed copy (`CI_DEVELOPER_ID_SIGNED_APP_PATH`), and a "Notarize – macOS" post-action exists. The documented Deployment Preparation options are only None, TestFlight (internal), and TestFlight and App Store. | [Environment variable reference](https://developer.apple.com/documentation/xcode/environment-variable-reference), [Configuring your workflow's actions](https://developer.apple.com/documentation/xcode/configuring-your-xcode-cloud-workflow-s-actions) |
| Can it sign our DMG and our extra binaries? | **No.** Cloud signing is used only by Xcode and `xcodebuild`; the identity is never in the build keychain, so `codesign` in a script cannot use it. Apple DTS lists the workarounds: ship a zip, leave the DMG unsigned, or pass your own (not cloud-managed) Developer ID identity to Xcode Cloud as a secret. | Forum, Apple DTS (Quinn), Sep 2025: [thread 799215](https://developer.apple.com/forums/thread/799215); forum, Apr 2026 (0 identities in `ci_post_xcodebuild.sh`): [thread 824803](https://developer.apple.com/forums/thread/824803) |
| Non-Xcode steps (install Bun, compile the server)? | Yes. `ci_post_clone.sh`, `ci_pre_xcodebuild.sh` and `ci_post_xcodebuild.sh` in `ci_scripts/`, with Homebrew available. No `sudo`. Files that a script creates are deleted afterwards and are not in the downloadable artifacts. | [Writing custom build scripts](https://developer.apple.com/documentation/xcode/writing-custom-build-scripts), [Workflow reference § Environment](https://developer.apple.com/documentation/xcode/xcode-cloud-workflow-reference) |
| Needs an Xcode project? | Yes: "a consistent Xcode project or workspace", shared schemes, archive enabled, and an app record in App Store Connect. Our app is a SwiftPM package that `app/build.sh` assembles by hand. | [Setting up your project to use Xcode Cloud](https://developer.apple.com/documentation/xcode/setting-up-your-project-to-use-xcode-cloud) |
| Private GitHub repo? Which branch? | Yes (github.com, GitHub Enterprise, GitLab, Bitbucket). Connecting needs repo admin. Start conditions choose branches, tags or PRs. | [Source code management setup](https://developer.apple.com/documentation/xcode/source-code-management-setup), same setup page |
| Artifacts and retention | The archive and logs are build artifacts in App Store Connect. Retention is not stated in the pages checked. Developers report that getting the notarized app out needs their own upload (S3) from a script, and that the script runs before the Notarize post-action. | Forum, 2024: [thread 745224](https://developer.apple.com/forums/thread/745224) |
| Upload to GitHub Releases with a secret? | Possible: secret environment variables are redacted in logs and readable by scripts. The upload must happen in `ci_post_xcodebuild.sh`. | [Workflow reference § Custom environment variables](https://developer.apple.com/documentation/xcode/xcode-cloud-workflow-reference) |
| Cost | 25 compute hours a month included with the Apple Developer Program; 100 h for US$49.99/month and up; unused hours do not roll over. | [Xcode Cloud](https://developer.apple.com/xcode-cloud/), [Get started](https://developer.apple.com/xcode-cloud/get-started/) |
| Owner-only steps | Create the app record (Account Holder, Admin or App Manager), grant GitHub access (repo admin, OAuth), manage the plan (Account Holder), and still export the Developer ID `.p12` for the DMG. | setup page above |

Verdict: the work that Xcode Cloud would save (holding the signing key) is the work it cannot do for
this app. FigmaMCP signs three Bun executables with their own JIT entitlements, then the `.app`, then
a DMG. Cloud signing reaches only what `xcodebuild` exports. So Xcode Cloud would still need our own
`.p12` as a secret, plus an Xcode project conversion, an app record, and our own artifact upload.

## 2b. Claude Code cloud session (option E): fit check

Evidence: [Cloud environments](https://code.claude.com/docs/en/cloud-environments) and
[Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web), read 2026-11-20.

| Question | Finding |
|---|---|
| OS | "a fresh virtual machine (VM) running Ubuntu 24.04 on x86_64". No macOS hosts. 4 vCPU, 16 GB RAM, 30 GB disk |
| Tools | Node 20/21/22, npm, pnpm, bun (with "known proxy compatibility issues" for package fetching), Rust/cargo, Docker, `gh`. Setup scripts run as root, so `apt install` works |
| Secrets | Environment variables: "Anyone who uses the environment can read the values", and commands the agent runs see them. Network secrets stay outside the VM but are only added as HTTP headers to listed hosts |
| Network | None, Limited (package registries, GitHub, cloud SDKs, plus listed domains) or Full. `appstoreconnect.apple.com` is not on the default list, so notarization needs Full or an added domain |
| GitHub | Through a proxy, for repositories attached to the session only. The proxy "rejects branch deletions and pushes of anything other than a branch, such as a tag", and rejects GraphQL (for example `gh pr`, `gh issue`). REST `gh api` works. Whether release asset uploads (`uploads.github.com`) pass is not documented: unverified |

What a Linux VM can do for FigmaMCP:

| Step | On Linux | Evidence |
|---|---|---|
| Bun server bundle and `bun build --compile --target=bun-darwin-*` programs | Possible | Bun cross-compiles to darwin targets; `scripts/build-binaries.sh` already does it. Not run in a cloud VM |
| Fat binaries (`lipo`) | Possible with `llvm-lipo` | LLVM tool; not tested |
| `.mcpb` bundle | Possible | `npx @anthropic-ai/mcpb pack` is plain Node |
| **Swift app shell (`app/Package.swift`, AppKit)** | **Impossible** | Swift on Linux has no macOS SDK. Cross-compiling needs the macOS SDK from Xcode, whose licence allows it only on Apple-branded computers ([Xcode and Apple SDKs Agreement](https://apple.com.cn/legal/sla/docs/xcode.pdf), [forum 114179](https://developer.apple.com/forums/thread/114179)) |
| Developer ID signing (Mach-O, `.app`, DMG) with `rcodesign` and a `.p12` | Possible per its docs, including nested signing and DMG signing | [rcodesign signing](https://gregoryszorc.com/docs/apple-codesign/main/apple_codesign_rcodesign_signing.html). Not tested: running the downloaded `rcodesign` binary was blocked by this session's permission rules |
| Notarization with an App Store Connect API key | Possible: `rcodesign notary-submit --staple` uses Apple's Notary API | [rcodesign notarizing](https://gregoryszorc.com/docs/apple-codesign/main/apple_codesign_rcodesign_notarizing.html) |
| Stapling | Possible for `.app` bundles and DMGs (`rcodesign staple`) | same page |
| Building the DMG | Needs a third-party HFS+ tool (for example libdmg-hfsplus); `rcodesign` "Cannot Sign File Contents of DMGs" and does not create DMGs | [Known issues](https://gregoryszorc.com/docs/apple-codesign/main/apple_codesign_quirks.html) |
| Publish to `figmamcp-releases` | Partly: needs the repository attached to the session; tags only via the REST release API; asset upload unverified | cloud-environments page |

Verdict: E can produce at most the `.mcpb` and signed Bun programs. It cannot build the `.app`, so it
cannot replace any Mac. Its secret model is also weaker than GitHub Actions encrypted secrets, and
every release would spend Claude plan usage on mechanical steps.

## 3. Options compared

| | A. Current (owner's Mac) | B. Xcode Cloud | C. GitHub Actions macOS runner | D. Hybrid: C builds, A stays as fallback | E. Claude Code cloud session |
|---|---|---|---|---|---|
| Who or what must be present for a release | Owner's Mac awake, logged in, keychain unlocked | Nobody once set up; GitHub and App Store Connect connected | Nobody once the secrets are set | Nobody normally; owner's Mac only if CI breaks | Cannot produce the Mac app at all (Linux only, section 2b) |
| Setup work | none | Xcode project + shared scheme, app record, GitHub grant, `ci_scripts`, own `.p12` secret for the DMG, own upload script | One workflow (prototype in this PR), 5 repository secrets | C + keep `app/build.sh` local defaults (done: they are unchanged) | Cloud environment with Full network or extra allowed domains; `rcodesign`; a Linux DMG tool; secrets as plain environment variables |
| Cost | US$0 | 25 h/month included; plenty for ~1 release a day | macOS runner US$0.062/min ([GitHub pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)); a ~10 min signed run ≈ US$0.62; the unsigned dry run was ~2 billed minutes ≈ US$0.12; before any included minutes | as C | No separate VM charge; counts toward the Claude plan's usage limits |
| Speed | build ~2–4 min + notarization wait (local) | queue + build + notarization | build 1 min 35 s measured unsigned (section 5) + notarization wait | as C | Not measured (would need a cloud session) |
| Secret handling | Private key in login keychain; notarytool profile with an app-specific password | Cloud-managed cert for the `.app`, but our `.p12` still needed for the DMG | `.p12` + password and an App Store Connect **API key** as encrypted secrets, imported into a temporary keychain per run, deleted after | as C; local keychain kept | **Weak.** Environment variables are readable by anyone who uses the environment and by the agent; network secrets only add HTTP headers, so they cannot hold a `.p12` or sign a notary JWT |
| Reproducibility | Depends on the owner's Xcode, Bun and Swift versions | Pinned Xcode/macOS in the workflow | Pinned runner image (`macos-15`) and Bun 1.3.0; logs kept by GitHub | as C | Fresh Ubuntu 24.04 x86_64 VM per session; non-deterministic agent steps |
| Effect of switching to the org (P&D VISION PTY LTD, planned 2027-01-01) | Install the new certificate, create a new notarytool profile, change the `SIGN_IDENTITY` default | Recreate the app record and workflows under the org team; grant GitHub again | Replace 5 secrets; the workflow reads the identity name from the `.p12`, so no code change | as C, plus A's steps if the fallback is kept | Replace the environment variables; the Swift app still cannot be built |

## 4. Recommendation and next steps

Pick **D**: build, sign and notarize in GitHub Actions (C), keep the owner's Mac (A) as the fallback.
Promote C to the release path only after a full run passes (signed, notarized, stapled, `spctl`
accepted) and the DMG has been opened on a clean Mac.

What this change already adds (upside only, no release):

1. `app/build.sh` accepts CI settings without changing local behaviour:
   - `SIGN_IDENTITY=-` signs ad-hoc (no timestamp) for build-only runs; `notarize` refuses it.
   - `NOTARY_KEY`, `NOTARY_KEY_ID`, `NOTARY_ISSUER` use an App Store Connect API key instead of the
     `figmamcp` keychain profile. With none set, the local default is unchanged.
   - `NOTARY_TIMEOUT` (default 30m) bounds each `notarytool --wait`.
2. `.github/workflows/mac-release-dryrun.yml`: on `macos-15`, builds the server, the binaries and the
   app. Without secrets it signs ad-hoc; with the secrets it imports the `.p12` into a temporary
   keychain, signs, notarizes and staples. It uploads the DMG as a 3-day workflow artifact. It never
   runs on tags and never publishes.

Owner-only steps (an AI cannot do these: each needs the owner's Apple login, 2FA or a key password):

| # | Step | Where | Why only the owner |
|---|---|---|---|
| 1 | Create an App Store Connect **Team** API key for notarization; download the `.p8` (one download only) and note the key ID and issuer ID. Use a Team key: Apple's API page says individual keys cannot use notarytool. Try the Developer role first (least privilege; not yet verified) and raise it only if notarytool refuses the key. | [Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api), see [Creating API keys](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api) | Apple ID login with 2FA; Admin role |
| 2 | Export `Developer ID Application: Peng Xiao (V7P333H7L7)` with its private key as a `.p12`, with a new export password. | Keychain Access → My Certificates → Export | Keychain unlock prompt and choice of the export password |
| 3 | Store the five secrets: `MACOS_DEVELOPER_ID_P12` (base64), `MACOS_DEVELOPER_ID_P12_PASSWORD`, `NOTARY_API_KEY_P8` (base64), `NOTARY_API_KEY_ID`, `NOTARY_API_ISSUER`. Commands below. | Terminal | The values are credentials; they must not pass through an AI transcript |

```bash
base64 -i ~/Downloads/DeveloperID.p12 | gh secret set MACOS_DEVELOPER_ID_P12 -R MrCoder/agentic-local-figma
gh secret set MACOS_DEVELOPER_ID_P12_PASSWORD -R MrCoder/agentic-local-figma
base64 -i ~/Downloads/AuthKey_XXXXXXXXXX.p8 | gh secret set NOTARY_API_KEY_P8 -R MrCoder/agentic-local-figma
gh secret set NOTARY_API_KEY_ID -R MrCoder/agentic-local-figma
gh secret set NOTARY_API_ISSUER -R MrCoder/agentic-local-figma
```

(`gh secret set NAME` without input prompts for the value, so it is never in shell history.)

After the secrets exist (AI steps):

1. Re-run the dry run; check the log shows `Notarized and stapled` and that `spctl` accepted both files.
2. Download the artifact on a Mac without the developer tools and open it.
3. Add the release stage behind a manual trigger: upload the DMG, the `.mcpb` and `server.json` to
   `MrCoder/figmamcp-releases`. This needs a fine-grained token with `contents: write` on that one
   repository (the job token cannot write to another repository), created by the owner.
4. Then update CONTRIBUTING.md so that CI is the release path and the local commands are the fallback.

## 5. Evidence from this change

| Check | Result |
|---|---|
| Local, `SIGN_IDENTITY=- app/build.sh` (owner's Mac, 2026-11-19 22:14 Melbourne) | `.app` and DMG built, `Signature=adhoc`, `codesign --verify` valid |
| Local, `SIGN_IDENTITY=- app/build.sh notarize` | Refused: "Cannot notarize an ad-hoc signed app", exit 1 |
| Local, `app/build.sh` with no overrides (the live release path) | Signed `Developer ID Application: Peng Xiao (V7P333H7L7)` with a secure timestamp, as before; `notarytool history --keychain-profile figmamcp` still succeeds |
| CI, `mac-release-dryrun.yml` without secrets, [run 44513116629](https://github.com/MrCoder/agentic-local-figma/actions/runs/44513116629) (2026-11-19 22:15 Melbourne) | Passed in 1 min 35 s on `macos-15` (macOS 15.8.2, Xcode 16.4, Swift 6.1.2). App and three Bun programs are `x86_64 arm64`; `figmamcp --version` prints `0.1.18`; DMG 158 MB uploaded as a 3-day artifact. Signing and notarization steps skipped (no secrets yet) |

Not proven yet: Developer ID signing from an imported `.p12`, API-key notarization, stapling and
`spctl` on the runner. These need the owner-only steps in section 4. At the measured build time, a
full release run is about 2 minutes of build plus the notarization wait (two submissions).
