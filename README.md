# claude-honcho — community fork

[![Honcho Banner](./assets/honcho_clawd.png)](https://honcho.dev)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-0.0.1-blue)](https://github.com/detailobsessed/claude-honcho)

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

2. **Install in Claude Code:**

   ```
   /plugin marketplace add detailobsessed/claude-honcho
   /plugin install honcho@honcho
   /plugin install honcho-dev@honcho   # optional — skills for building on the Honcho SDK
   ```

3. **Restart Claude Code.** You should see the Honcho pixel art and memory loading on startup.

This covers the essentials. For the complete walkthrough — Windows setup, optional environment variables (`HONCHO_PEER_NAME`, `HONCHO_WORKSPACE`), the intro interview (`/honcho:interview`), the `~/.claude/CLAUDE.md` directives, the full configuration reference, and troubleshooting — see the **[upstream README](https://github.com/plastic-labs/claude-honcho#readme)**. It predates this fork, so **install via `detailobsessed/claude-honcho` as shown above**, not the `plastic-labs` marketplace it references.

## What it does

Gives Claude Code long-term memory that survives context wipes, restarts, and `ctrl+c` — your preferences, your projects, and what Claude was doing, across everything you work on.

## Credit & license

Built on [Honcho](https://honcho.dev) by [Plastic Labs](https://plasticlabs.ai). The original work is © Plastic Labs and MIT-licensed — see [LICENSE](LICENSE). This fork is maintained by [Ismar](https://github.com/ichoosetoaccept) and remains MIT.
