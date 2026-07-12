# Changelog

All notable changes to this community-maintained fork of claude-honcho are documented here.

This project forks [plastic-labs/claude-honcho](https://github.com/plastic-labs/claude-honcho) at its v0.2.7 release and restarts versioning at `0.0.1`. Entries at `[0.2.4]` and below predate the fork and reflect upstream's history.

## [Unreleased]

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
