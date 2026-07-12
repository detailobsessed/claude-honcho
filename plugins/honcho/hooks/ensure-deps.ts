#!/usr/bin/env bun
/**
 * SessionStart bootstrap: make the plugin's runtime dependencies available.
 *
 * The plugin does NOT vendor node_modules. Claude Code's `/plugin install`
 * copies files as-is and never runs an install step, and committing node_modules
 * is not the endorsed pattern. Instead we install once, next to the plugin's own
 * scripts, so every hook and the MCP server resolve imports through ordinary
 * node_modules resolution — no NODE_PATH, no symlinks, no shell-specific env
 * (hook entries can't set env, and bun's NODE_PATH support is undocumented).
 *
 * Runs on first launch and again after each plugin update, since the install
 * directory is re-copied without node_modules. Self-contained: uses only
 * Bun/Node built-ins, because it runs BEFORE the dependencies exist.
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export interface RunResult {
  status: number | null;
  error?: Error;
}
export type Runner = (cmd: string, args: string[], cwd: string) => RunResult;

const defaultRun: Runner = (cmd, args, cwd) => {
  // Discard install chatter (SessionStart stdout can be read as context);
  // surface only failures on stderr.
  const r = spawnSync(cmd, args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
  return { status: r.status, error: r.error };
};

/**
 * Install the plugin's dependencies into `pluginRoot` if they're missing.
 * Returns true if an install was attempted, false if node_modules already
 * existed. Never throws — a bootstrap failure must not block the session.
 */
export function ensureDeps(pluginRoot: string, run: Runner = defaultRun): boolean {
  // Gate on a marker written only after a *successful* install — not on the
  // mere presence of node_modules. An interrupted or failed `bun install` can
  // leave the directory partially populated; keying off existence alone would
  // skip the retry forever and leave the plugin broken.
  const marker = join(pluginRoot, "node_modules", ".honcho-install-ok");
  if (existsSync(marker)) {
    return false;
  }
  const result = run("bun", ["install", "--frozen-lockfile"], pluginRoot);
  if (result.status === 0) {
    try {
      writeFileSync(marker, "");
    } catch {
      // Best-effort: if we can't write the marker we simply reinstall next
      // session, which is safe.
    }
  } else {
    console.error(
      `[honcho] dependency install failed (${result.error?.message ?? `exit ${result.status}`}). ` +
        `Honcho memory is unavailable until 'bun install' succeeds in ${pluginRoot}.`,
    );
  }
  return true;
}

// This file lives at <pluginRoot>/hooks/ensure-deps.ts.
if (import.meta.main) {
  ensureDeps(dirname(import.meta.dir));
}
