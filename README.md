# claude-honcho — community fork

[![Honcho Banner](./assets/honcho_clawd.png)](https://honcho.dev)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fdetailobsessed%2Fclaude-honcho%2Fmain%2Fplugins%2Fhoncho%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue&prefix=v)](https://github.com/detailobsessed/claude-honcho)

A community-maintained fork of [`plastic-labs/claude-honcho`](https://github.com/plastic-labs/claude-honcho) — persistent memory for Claude Code, powered by [Honcho](https://honcho.dev) from Plastic Labs.

## Why this fork exists

When this fork began, upstream had sat untouched for weeks — bug reports unanswered and no releases shipping. Rather than wait, this fork:

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
