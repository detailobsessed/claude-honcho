# Changelog

All notable changes to this community-maintained fork of claude-honcho are documented here.

This project forks [plastic-labs/claude-honcho](https://github.com/plastic-labs/claude-honcho) at its v0.2.7 release and restarts versioning at `0.0.1`. Entries at `[0.2.4]` and below predate the fork and reflect upstream's history.

## [Unreleased]

## [0.3.0] - 2026-07-15

Capture hygiene: stop the noise classes this fork's own dogfooding surfaced — external git commits, tool actions, and trivial acknowledgements — from being minted as durable user facts.

### Changed

- Git-commit observations are now opt-in and off by default. On `SessionStart` the plugin detected commits made outside a session and uploaded them as `[Git External] …` messages **on the user peer** — so Honcho's fact extractor minted durable, ephemeral, misattributed facts ("the user made commit 9c25069"). This is the same misattribution class as pasted content (#34) and tool actions: anything on a `role: "user"` message is read as the user speaking, regardless of a cosmetic `external: true` tag. A new `captureGitObservations` config flag (env `HONCHO_CAPTURE_GIT_OBSERVATIONS`) gates the upload and defaults to **false**. A companion `captureToolObservations` flag (default **true**, env `HONCHO_CAPTURE_TOOL_OBSERVATIONS`) lets tool-action observations be turned off the same way. Both are plumbed like `saveMessages` (host-block override, env, persistence).

### Fixed

- Trivial acknowledgements ("ok", "thanks", "yes", …) are no longer stored as user speech. The user-prompt hook uploaded every prompt and only skipped *context retrieval* for trivial ones — so pure filler landed in the user's representation as conclusions like "the user acknowledges the offer is nice". The upload is now gated on the same `TRIVIAL_ACK` check, mirroring the `Stop` hook's existing meaningfulness gate for assistant messages; context retrieval and message-count tracking are unaffected.
- `saveConfig` no longer materializes env-derived capture flags to disk. In the no-config-file path `loadConfigFromEnv` bakes `HONCHO_CAPTURE_GIT_OBSERVATIONS` / `HONCHO_CAPTURE_TOOL_OBSERVATIONS` into the resolved config, and `saveConfig` persisted those onto the host block — so an env-only override outlived its variable (removing the git var later left git observations stuck on, defeating the default-off). Both flags are now guarded with the same env-only pattern as `enabled`/`logging`, adapted to each flag's override polarity.

## [0.2.0] - 2026-07-15

Turn-path reliability and memory quality: move uploads off the turn-end critical path, stop storing pasted content as the user's own speech, and inject the conclusions that actually match the prompt.

### Changed

- The `Stop` hook no longer uploads the assistant response synchronously on the turn-end critical path. It now durably queues the response to the local outbox and hands the upload to a detached, upload-only worker (`hooks/outbox-worker.ts`) that outlives the hook, so a slow or unreachable Honcho can no longer stall the end of every turn (previously up to the SDK's ~8s timeout). Anything the worker can't send stays queued and drains on the next `SessionStart` (the existing safety net). Adapts the non-blocking approach of upstream plastic-labs/claude-honcho#50 to this fork's outbox architecture (the fork has no `SessionEnd` hook — it was removed — so the upstream exit-hang symptom does not apply here).

### Fixed

- The `UserPromptSubmit` hook now injects the conclusions that actually match the prompt, instead of the stalest facts in the window. It runs a semantic search over the prompt but then injected the first 5 lines of the representation string — and the representation is ordered oldest-first, so the search results never surfaced and every turn re-showed the same old facts regardless of what was asked. The hook now queries matched conclusions explicitly (`conclusionScope.query`, in parallel with the context call), puts them first, and fills the remaining slots with the *newest* representation lines (timestamp-descending), deduped by normalized text and still honoring the per-session `seen` set so nothing repeats turn-to-turn. `extractTopics` also drops its English-only stopword fallback and lets the caller fall back to the raw prompt (truncated), which embeds better for search and keeps non-English prompts working. Ported from upstream plastic-labs/claude-honcho#63 and adapted to this fork's cross-turn dedup layer.
- Pasted code, diffs, and log dumps are no longer stored as the user's own words. Everything on a `role: "user"` message is read by Honcho's server-side fact extractor as something the user said, so a prompt like "review this diff" followed by a pasted patch minted durable misattributions ("the user changed `buildOperatorPlan`"). `handleUserPrompt` now runs the prompt through a new `stripPastes` before upload — redacting fenced code blocks, runs of 3+ consecutive diff lines, and long path-bearing output lines (short path mentions and a lone `+`/`-` line in prose are preserved) — and tags the stored message `type: "user_paste_not_speech"` when anything was removed. Only the stored copy is stripped; context retrieval still searches the full prompt. Tool actions logged by the `PostToolUse` hook now also carry `type: "tool_action"` / `subject: "ai_action_on_user_behalf"` so directional and MCP scopes don't fold the assistant's tool use into the user's own representation. Ported from upstream plastic-labs/claude-honcho#34.
- Outbox fallback records written by the user-prompt hook now stamp the `workspace` they belong to, matching the Stop-hook and drain fixes above, so a prompt queued while Honcho is unreachable can't leak into another project's workspace when it later drains.
- Outbox records are now workspace-scoped, closing a cross-project memory leak. Each `OutboxRecord` records the `workspace` it belongs to (config's workspace after any directory override), and `drainOutbox` only uploads records matching its own client's workspace, requeuing the rest for a drain scoped to theirs. Previously a drain claimed the entire global `~/.honcho/outbox.jsonl` and uploaded every record with the single client it was built for, so if two projects with different `directoryWorkspaces` overrides both had records pending, one project's responses could be written into the other's Honcho workspace — undermining the directory-workspace isolation added in 0.1.0. This scopes both the new Stop-hook worker drain and the existing `SessionStart` drain. Legacy records with no workspace still drain under whatever workspace the drainer is scoped to (best-effort back-compat).

## [0.1.0] - 2026-07-15

Directory-scoped workspaces: route each project to its own Honcho memory instead of pooling everything in one global workspace.

### Added

- **Directory-scoped workspaces** (hardens upstream plastic-labs/claude-honcho#64): route each project directory to its own Honcho workspace so memory stops bleeding across projects.
  - Prefix routing via a new `workspaceRules` list mapping a directory prefix to a workspace — segment-aware, `~`-expanding, longest match wins — so one rule can cover every repo under a parent tree. A shared `resolveDirectoryOverride` backs both routing and isolation.
  - Per-workspace injected-context cache keyed by resolved workspace, so concurrent sessions on different workspaces can't read each other's memory. Legacy single-slot cache fields are preserved (not stripped) on upgrade.
  - Re-nudge until decided: an uncovered directory is nudged every session until the user isolates it, adds a prefix rule, or explicitly keeps it pooled via the new `keep_pooled` MCP tool. An explicit keep-pooled decision is terminal and is honored before `autoIsolate`.

### Fixed

- `updateRawConfigFile` now wraps its read-modify-write of `~/.honcho/config.json` in a new `withConfigLock` helper (mirroring `withContextCacheLock`: an exclusive `openSync("wx")` lockfile with 5s stale-lock breaking and a 3s timeout that proceeds unlocked rather than hang a short-lived hook). Previously two concurrent auto-isolations — or an MCP `keep_pooled` update racing a session-start hook — could both read the same file and have the second write silently drop the `directoryWorkspaces` entry the first added, sending that project back to the global workspace.
- `saveConfig()` no longer strips unknown fields from the current host's config block on every write. Previously, any field added under `hosts.<host>.*` that isn't declared on the `HostConfig` interface (e.g. a user-added `linkedHosts`) was silently removed the next time the plugin persisted config. The host entry is now seeded with unknown fields from the existing block (and its hyphen/underscore aliases) before the known-field write logic runs, so user-added config survives round-trips. Ported from upstream plastic-labs/claude-honcho#29.
- `saveConfig()` now serializes its read-merge-write of `config.json` under the same `withConfigLock` used by the other config writers. Previously it wrote outside any lock, so a concurrent session-start hook or MCP write could clobber the host block it had just written (and vice versa) — the same cross-process race already fixed for `updateRawConfigFile`.
- Removed the redundant `"hooks": "./hooks/hooks.json"` key from `plugin.json`. Claude Code already auto-discovers `hooks/hooks.json`, so the explicit key registered the hooks twice and errored out on `/plugins-reload`.

## [0.0.4] - 2026-07-12

### Fixed

- **Harness turns no longer pollute memory** (upstream #66): Claude Code fires `UserPromptSubmit` for turns the user never typed — background task-notifications, `!`-bash command echoes, slash-command output, and system reminders. These were uploaded as user messages, so Honcho's deriver minted plumbing "conclusions" (`received a task-notification with task-id …`, `used a tool with tool-use-id toolu_…`) that polluted the memory graph. The hook now recognizes these harness-wrapped turns (matching a known opening tag at the very start of the prompt, so genuine prompts that merely quote a tag are untouched) and skips them — no upload, no context fetch.

## [0.0.3] - 2026-07-12

Reliability pass folding in fixes for several open upstream issues.

### Fixed

- **Configurable SDK timeout** (upstream #25): `getHonchoClientOptions` reads `HONCHO_SDK_TIMEOUT_MS` (default 8000) instead of a hardcoded 8s, so dialectic queries at high/max reasoning levels can be given room instead of always timing out.
- **No repeated conclusions** (upstream #39): `UserPromptSubmit` tracks the conclusions it has already surfaced this session (per instance, in `context-cache.json`) and injects only new ones, cutting context bloat from the same conclusions repeating every turn.
- **Correct hook timeout units + capped install** (upstream #59): `hooks.json` timeouts were milliseconds but Claude Code reads seconds, leaving hooks effectively uncapped; they are now in seconds (60/30/20/10/7). `ensure-deps` additionally bounds `bun install` with an internal timeout (`HONCHO_INSTALL_TIMEOUT_MS`, default 50s) and an uncatchable `SIGKILL`, so a stalled install can't wedge SessionStart.
- **Outbox batch size** (upstream #57): `drainOutbox` sends queued messages in ≤100-item batches (Honcho's `MessageBatchCreate` cap) and, on interruption or budget exhaustion, requeues only the unsent tail — avoiding a 422 retry loop and duplicate re-sends on a large backlog.

### Internal

- The test suite is isolated from the ambient git environment (`GIT_DIR`/`GIT_WORK_TREE`/… are stripped and git calls run with the live env), so the pre-commit test gate no longer fails when the suite runs inside a git hook.

## [0.0.2] - 2026-07-12

### Removed

- `scripts/check-version.sh` — an update nag that curled upstream's (`plastic-labs`) marketplace and compared against it. It was already unwired from the hooks, pointed at upstream rather than this fork, and duplicates Claude Code's own marketplace version check.

### Changed

- The plugin version now lives in a single place — `plugins/honcho/.claude-plugin/plugin.json`. The redundant `version` fields were removed from `package.json` (which Claude Code never reads) and from the marketplace `metadata` (which is the catalog's version, not the plugin's). Claude Code resolves a plugin's version from `plugin.json` first, so it is the sole source of truth; one file to bump per release.

### Documentation

- README now explains how to turn on marketplace auto-update so Claude Code surfaces new fork versions on startup.
- The README version badge reads `plugin.json` dynamically, so it tracks the single source of truth with no manual edit.

## [0.0.1] - 2026-07-12

First release of the fork, forked from upstream v0.2.7.

### Fork infrastructure

- Bun test suite covering the cache, config, git, outbox, and lifecycle-hook logic.
- Local quality gates via [prek](https://prek.j178.dev) in place of CI: whitespace/config builtins, `betterleaks` secret scanning, `typos`, `shellcheck`, and Biome lint, plus `typecheck` and `bun test` on every commit.
- Biome lint enforced as errors, with all 21 pre-existing findings cleared.
- Versioning reset to `0.0.1` with each plugin's `plugin.json` as the single source of truth; per-plugin version fields removed from `marketplace.json`, and marketplace ownership set to the fork maintainer.
- Replaced the vendored `node_modules` with a `SessionStart` bootstrap that installs dependencies on first run (the documented Claude Code pattern), keeping the repository lean.
- The root README explains the fork and carries the essential install; the full configuration manual is left to the linked upstream README rather than vendoring a copy that would drift out of date.

The following entries carried over from upstream's unreleased work at the time of the fork:

### Added

- Per-host `apiKey` field in `hosts.<name>` — takes precedence over root `apiKey`, still overridden by `HONCHO_API_KEY` env var. Lets different integrations authenticate against different Honcho orgs from one config file.
- `scripts/analyze-usage.py` — standalone script to analyze Claude Code's Honcho usage from `~/.claude` logs.
- Failure-driven local outbox: user prompts and assistant responses that fail to upload (host unreachable) are queued to `~/.honcho/outbox.jsonl` and flushed at the next `SessionStart` once the host is back, instead of being dropped. Records preserve their original session, peer, and timestamp; bounded by 5 MB / 1000-record / 7-day caps (drops logged); concurrency-safe via atomic claim-by-rename; decoupled from session teardown. `post-tool-use` observations are intentionally not queued.

### Changed

- User prompts are now written to Honcho in real time on `UserPromptSubmit` instead of being queued for `SessionEnd` flush. Mirrors the existing fire-and-forget pattern used by `PostToolUse` and `Stop`.
- `PostToolUse` no longer records bare `cd` commands as Honcho observations, cutting navigation noise from the session stream.

### Fixed

- Directional observation mode now sets the full per-session directionality on both peers: the user self-observes but does not model the AI (`observeMe:true, observeOthers:false`), and the AI observes the user without self-observing its own assistant/tool output (`observeMe:false, observeOthers:true`). Previously only the AI peer's `observeOthers` was set, leaving its `observeMe` at the Honcho default (`true`) so it self-observed.
- Eliminated a duplication bug where repeated `SessionEnd` failures (12s timeout, double-fire) caused queued prompts to be re-uploaded indefinitely.

### Removed

- The local `~/.honcho/message-queue.jsonl` queue file is no longer used and can be deleted from user machines to reclaim disk. The plugin will not auto-delete it.

## [0.2.4] - 2026-04-01

### Added

- `observationMode: "unified" | "directional"` config flag — per-host with root fallback, default `"unified"`
  - **unified** (default): all agents contribute to the user's self-observation collection (`observer=user, observed=user`); conclusions are portable across agents
  - **directional** (opt-in): each AI maintains its own view of the user (`observer=aiPeer, observed=user`); useful for isolated multi-agent workspaces
  - Resolves the ambiguity from issue #22 — prior code was implicitly directional with no user control; peer-call routing in all hooks and MCP tools now branches on this flag
- `get_context` MCP tool — retrieves the full context object (representation + peer card), scoped by observation mode
- `get_representation` MCP tool — lightweight representation string fetch, scoped by observation mode
- `list_conclusions` MCP tool — paginated list of saved conclusions with `id`, `content`, and `createdAt`
- `delete_conclusion` MCP tool — remove a conclusion by ID
- `schedule_dream` MCP tool — trigger background memory consolidation; Honcho merges redundant conclusions and derives higher-level insights
- `search` tool `scope` parameter — `"session"` (default) or `"workspace"` to search across all sessions
- `observationMode` settable via `set_config` and visible in `get_config` output and status card

### Fixed

- `aiPeer` peer config: `observeMe` corrected to `false` — agent peers don't need self-representation; eliminates wasted background reasoning compute
- `addPeers` session config: `aiPeer.observeOthers` is now `false` in unified mode and `true` in directional mode (was unconditionally `true`)

### Changed

- Bump `@honcho-ai/sdk` floor to `^2.1.0` (adds pagination, `getMessage`, `createdAt`/`isActive` on peers/sessions, strict validation)
- Bump `@modelcontextprotocol/sdk` floor to `^1.26.0`

## [0.2.3] - 2026-03-25

### Fixed

- Adding peers to session with config
- Windows compatibility for TTY, setup, and install
- Per-host config ownership, `saveRootField`, SDK client options
- Resilient hook lifecycle: phased session-end, cache-first user-prompt

## [0.2.2] - 2026-03-03

### Fixed

- Fix `chat-instance` session strategy ignoring `sessionPeerPrefix` setting — sessions now correctly prefix with peer name when enabled

## [0.2.1] - 2026-03-02

### Added

- Global `~/.honcho/config.json` with per-host config blocks (Claude Code, Cursor, Obsidian)
- Host auto-detection via environment signals (`HONCHO_HOST`, `CURSOR_PROJECT_DIR`)
- Linked workspaces for cross-host context sharing at runtime
- `/honcho:config` skill with `get_config` and `set_config` MCP tools
- `/honcho:setup` skill for first-time API key validation and config creation
- Multiple session strategies: `per-directory`, `git-branch`, `chat-instance`
- `globalOverride` flag to apply flat config fields across all hosts
- `sessionPeerPrefix` option to prefix session names with peer name

### Fixed

- Stale cache fallback with timeout for context fetch
- Clear stale session overrides when prefix/strategy/peerName changes
- Message sync bugs: dedup uploads, scope instance IDs per-cwd, add createdAt
- Chat-instance strategy ignores stale session overrides
- Respect `HONCHO_WORKSPACE` env var during legacy config migration
- Various config menu UX improvements (single-select link/unlink, granular host toggles)

### Changed

- Extracted `initHook()` for shared hook entry points
- Unified aiPeer defaults across hosts
- Renamed host identifier from `claude-code` to `claude_code`
- Skills synced to marketplace directory where plugin loader reads them

## [0.2.0] - 2026-02-10

### Added

- Visual logging with pixel art banner
- Configurable file logging to `~/.honcho/` (on by default, toggleable)
- Session name prefixing with `peerName` (configurable, default on)
- Installation instructions for adding to Claude Code

### Changed

- Removed legacy SDK format support — all code uses Honcho SDK v2.0.0 natively
- Pinned `@honcho-ai/sdk` to `~2.0.0`
- Updated terminology: "facts" renamed to "conclusions" throughout

## [0.1.2] - 2026-02-05

### Added

- Message chunking for large payloads
- Interview skill (`/honcho:interview`) for capturing user preferences
- Plugin validation on install
- Bundled `node_modules` for marketplace distribution

### Fixed

- Full dependencies declared in package.json for plugin portability
- Banner display on session start

## [0.1.1] - 2026-01-30

### Added

- `honcho enable` / `honcho disable` commands
- Developer plugin (`honcho-dev`) with SDK integration and migration skills
- Pure plugin structure for Claude Code marketplace

### Changed

- Renamed from `honcho-claudis` to `claude-honcho`
- Updated to `@honcho-ai/sdk` v2.0.0
- Removed old handoff and setup skills
- Removed hard dependency on Bun for broader portability

## [0.1.0] - 2026-01-05

### Added

- Initial release as `honcho-claudis`
- Persistent memory for Claude Code sessions using Honcho
- Session-start hook with wavy loading animation
- User-prompt-submit hook with dialectic reasoning context
- Assistant-response-stop hook for real-time response capture
- Pre-compact hook for session state preservation
- Cost optimization with configurable context refresh thresholds
- Endpoint switching between SaaS and local Honcho instances
- Git state tracking with inferred feature context
- Activity logging with tail command
- Self-improvement from AI feedback analysis
- Pixel art and colorful wave spinner UI
- Session isolation per working directory
