# claude-honcho — community fork

[![Honcho Banner](./assets/honcho_clawd.png)](https://honcho.dev)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-0.0.1-blue)](https://github.com/detailobsessed/claude-honcho)

A community-maintained fork of [`plastic-labs/claude-honcho`](https://github.com/plastic-labs/claude-honcho) — persistent memory for Claude Code, powered by [Honcho](https://honcho.dev) from Plastic Labs.

## Why this fork exists

Upstream has sat untouched for 6+ weeks while bug reports went unanswered. Rather than wait, this fork:

- **folds in community bug fixes** — including work by [@saralilyb](https://github.com/saralilyb)
- **adds a real test suite** — 87 tests covering the cache, config, git, and outbox logic
- **adds local quality gates** via [prek](https://prek.j178.dev): lint, typecheck, tests, secret scanning, spell-check, and shellcheck, run on every commit — no CI required
- **restarts versioning at `0.0.1`** to make clear this is a distinct, separately-maintained artifact

It's maintained for as long as I rely on it. If upstream revives the project, the intent is to contribute the fixes back.

## Install

```
/plugin marketplace add detailobsessed/claude-honcho
/plugin install honcho@honcho
/plugin install honcho-dev@honcho   # optional — skills for building on the Honcho SDK
```

Requires [Bun](https://bun.sh) and a Honcho API key from [app.honcho.dev](https://app.honcho.dev). Restart Claude Code after installing.

## What it does

Gives Claude Code long-term memory that survives context wipes, restarts, and `ctrl+c` — your preferences, your projects, and what Claude was doing, across everything you work on.

**Full setup, configuration, and troubleshooting live in [docs/README.md](docs/README.md).**

## Credit & license

Built on [Honcho](https://honcho.dev) by [Plastic Labs](https://plasticlabs.ai). The original work is © Plastic Labs and MIT-licensed — see [LICENSE](LICENSE). This fork is maintained by [Ismar](https://github.com/ichoosetoaccept) and remains MIT.
