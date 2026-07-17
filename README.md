> ## 🗄️ This fork is archived (2026-07-17)
>
> **Not maintained.** This repository is kept online simply because I think the stuff that shipped here has value — see [what this fork added](#why-this-fork-exists) and the full [changelog](./CHANGELOG.md).
>
> I'm trying other memory layers that actually maintain their Claude Code plugin:
>
> - **[Hindsight](https://hindsight.vectorize.io/)** (Vectorize)
> - **[Cognee](https://cognee.ai/)**
>
> The code here still works as of the last release, and the per-project workspace scoping
> may be useful to anyone building on top of it.

# claude-honcho — community fork

[![Honcho Banner](./assets/honcho_clawd.png)](https://honcho.dev)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fdetailobsessed%2Fclaude-honcho%2Fmain%2Fplugins%2Fhoncho%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue&prefix=v)](https://github.com/detailobsessed/claude-honcho)

A community-maintained fork of [`plastic-labs/claude-honcho`](https://github.com/plastic-labs/claude-honcho) — persistent memory for Claude Code, powered by [Honcho](https://honcho.dev) from Plastic Labs.

## Why this fork exists

When this fork began, upstream had sat untouched for weeks — bug reports unanswered and no releases shipping. Rather than wait, this fork:

- **scopes memory per project** — each directory can map to its own Honcho workspace, so what Claude learns in one repo no longer bleeds into an unrelated one (see [Directory workspaces](#directory-workspaces)). This is the largest departure from upstream so far.
- **folds in community bug fixes** — including work by [@saralilyb](https://github.com/saralilyb)
- **adds a real test suite** covering the cache, config, git, outbox, and hook logic
- **adds local quality gates** via [prek](https://prek.j178.dev): lint, typecheck, tests, secret scanning, spell-check, and shellcheck, run on every commit — no CI required
- **restarts versioning at `0.0.1`** to make clear this is a distinct, separately-maintained artifact

It's maintained for as long as I rely on it. If upstream revives the project, the intent is to contribute the fixes back.

## Install

You'll need [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`) and a Honcho API key from [app.honcho.dev](https://app.honcho.dev).

1. **Export your API key** so the plugin can read it — add it to your shell config (`~/.zshrc` / `~/.bashrc`; on Windows, set a User environment variable):

   ```bash
   export HONCHO_API_KEY="hch-..."
   ```

2. **Install the plugin in Claude Code:**

   ```
   /plugin marketplace add detailobsessed/claude-honcho
   /plugin install honcho@honcho
   ```

   That one install brings everything memory needs — the MCP server, the session hooks, and the `/honcho:*` skills. Nothing is gated behind a later step.

   > `honcho-dev` is a **separate, optional** plugin — skills for building your *own* apps on the Honcho SDK. It has nothing to do with memory. Install it with `/plugin install honcho-dev@honcho` only if you want those.

3. **Restart Claude Code.** Memory loads silently in the background on each session start — there is no startup banner or pixel art. Confirm it's live with `/honcho:status`, or by tailing `~/.honcho/activity.log`.

4. **Run `/honcho:setup` (recommended).** Memory already works off the `HONCHO_API_KEY` environment variable alone, but `setup` makes it solid: it validates the key against the API, writes `~/.honcho/config.json` so configuration no longer depends on the env var reaching every subprocess, and installs the memory statusLine. (If you already run a custom statusLine, setup leaves it untouched and just prints how to switch.)

> [!TIP]
> **Get notified of fork updates.** Claude Code leaves auto-update **off** by default for community marketplaces, so it won't tell you a new version shipped until you look. To have it pull updates on startup, open `/plugin` → **Marketplaces**, select **honcho**, and turn on auto-update. Prefer to stay manual? Run `/plugin marketplace update honcho` now and then, then check `/plugin` for the new version.

This covers the essentials. For the complete walkthrough — Windows setup, optional environment variables (`HONCHO_PEER_NAME`, `HONCHO_WORKSPACE`), the intro interview (`/honcho:interview`), the `~/.claude/CLAUDE.md` directives, the full configuration reference, and troubleshooting — see the **[upstream README](https://github.com/plastic-labs/claude-honcho#readme)**. It predates this fork, so **install via `detailobsessed/claude-honcho` as shown above**, not the `plastic-labs` marketplace it references.

## What it does

Gives Claude Code long-term memory that survives context wipes, restarts, and `ctrl+c` — your preferences, your projects, and what Claude was doing, across everything you work on.

## Directory workspaces

By default every project pools its memory into one global workspace, so what Claude learns in one repo can surface in an unrelated one. This fork lets each directory map to its own Honcho workspace, keeping memory scoped to the project it came from.

A directory's workspace is resolved at each session start, **most specific first**:

1. **Exact match — `directoryWorkspaces`.** Pin one directory to one workspace. Highest precedence.
2. **Prefix rule — `workspaceRules`.** Route a whole subtree with a single rule: any directory at or under `cwdPrefix` uses that workspace. A leading `~` expands to your home directory, matching is path-segment-aware (`~/code/work` covers `~/code/work` and `~/code/work/api` but **not** `~/code/work-old`), and when several rules match the longest prefix wins.
3. **`autoIsolate: true`.** No entry or rule matched? Silently give the directory its own workspace, named after its last path segment.
4. **Otherwise — pooled.** The directory keeps using the global workspace, and you get a one-line nudge each session until you decide (below).

It all lives in `~/.honcho/config.json`:

```json
{
  "directoryWorkspaces": {
    "/Users/you/project-alpha": { "workspace": "project_alpha" }
  },
  "workspaceRules": [
    { "cwdPrefix": "~/code/work",     "workspace": "work" },
    { "cwdPrefix": "~/code/personal", "workspace": "personal" }
  ],
  "autoIsolate": false,
  "keepPooled": []
}
```

The point of a prefix rule is to set `~/code/work → work` once and have every repo under it isolate automatically — no per-directory bookkeeping. (`directoryWorkspaces` entries also accept optional `apiKey`, `aiPeer`, and `endpoint` overrides; `workspaceRules` accept an optional `aiPeer`.)

### Answering the nudge

An uncovered directory nudges you **every** session — not once — until you pick one of three exits:

- **Isolate just this directory** — add a `directoryWorkspaces` entry.
- **Route its whole parent tree** — add a `workspaceRules` prefix.
- **Keep it pooled** — a deliberate "leave this one in the global workspace." Ask Claude to keep the project pooled (it calls the `keep_pooled` tool), or add the path to `keepPooled` yourself. This decision is terminal: it's honored even with `autoIsolate` on, so a directory you chose to pool stays pooled.

Ignoring the nudge does **not** count as a decision — by design, so a directory never silently drifts into the wrong workspace.

### No cross-workspace bleed

The injected-context read cache is keyed by the resolved workspace, so two sessions open on different workspaces at the same time can't read each other's memory.

## Developing this fork

The installed plugin runs from a **copy** in `~/.claude/plugins/cache/honcho/honcho/<version>/`, pinned to a released commit on `main`. Editing your local checkout does nothing to it — so to try a change before merging and releasing, you need to run the plugin *from your working tree*.

There's no build step to worry about: the hooks and MCP server are TypeScript run directly (`bun run ${CLAUDE_PLUGIN_ROOT}/…ts`), so a live edit takes effect the moment the plugin reloads.

**Dogfood a branch with `--plugin-dir`:**

```bash
cd /path/to/claude-honcho          # your checkout, on the feature branch
claude --plugin-dir ./plugins/honcho
```

`--plugin-dir` loads the plugin straight from that directory — no install, no marketplace — and takes precedence over the installed version. Point it at `./plugins/honcho` (the dir with `.claude-plugin/plugin.json`), not the repo root. Iterate without restarting: edit a file under `src/`, run `/reload-plugins`, test.

> [!IMPORTANT]
> **Disable the installed `honcho` plugin while dogfooding.** `--plugin-dir` wins for *tool resolution*, but hooks are additive — leave the released copy enabled and both fire, so every session writes to Honcho **twice** and registers the MCP server twice. Open `/plugin` → **honcho** → disable for the session (re-enable when done). As a bonus this gives you a clean A/B against the released behavior.

Only once a change is confirmed live should it be committed, merged to `main`, and released into the marketplace copy — never released blind.

> `honcho-dev` is **not** a development mode for this plugin — it's a separate plugin of SDK-authoring skills for building *other* apps on Honcho (see the install note above). The one time it's relevant here is if a future `@honcho-ai/sdk` major bump needs migrating; otherwise it plays no part in developing the fork.

## Credit & license

Built on [Honcho](https://honcho.dev) by [Plastic Labs](https://plasticlabs.ai). The original work is © Plastic Labs and MIT-licensed — see [LICENSE](LICENSE). This fork is maintained by [Ismar](https://github.com/ichoosetoaccept) and remains MIT.
