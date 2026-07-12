/**
 * Unit tests for the SessionStart dependency bootstrap (hooks/ensure-deps.ts).
 * The runner is injected so nothing actually shells out to `bun install`.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDeps, defaultRun, type Runner } from "../hooks/ensure-deps";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "honcho-deps-"));
}

describe("ensureDeps", () => {
  test("skips install when the success marker is present", () => {
    const root = tempRoot();
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", ".honcho-install-ok"), "");
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const run: Runner = (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      return { status: 0 };
    };
    try {
      expect(ensureDeps(root, run)).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reinstalls when node_modules exists but the success marker is missing (partial install)", () => {
    const root = tempRoot();
    mkdirSync(join(root, "node_modules")); // present but no marker → interrupted install
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const run: Runner = (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      return { status: 0 };
    };
    try {
      expect(ensureDeps(root, run)).toBe(true);
      expect(calls).toHaveLength(1);
      // A successful reinstall writes the marker so the next session skips.
      expect(existsSync(join(root, "node_modules", ".honcho-install-ok"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runs `bun install --frozen-lockfile` in the plugin root when deps are missing", () => {
    const root = tempRoot();
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const run: Runner = (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      return { status: 0 };
    };
    try {
      expect(ensureDeps(root, run)).toBe(true);
      expect(calls).toEqual([{ cmd: "bun", args: ["install", "--frozen-lockfile"], cwd: root }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not throw when the install fails", () => {
    const root = tempRoot();
    const run: Runner = () => ({ status: 1, error: new Error("bun not found") });
    try {
      expect(() => ensureDeps(root, run)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("defaultRun install timeout (#59)", () => {
  test("kills a command that exceeds HONCHO_INSTALL_TIMEOUT_MS", () => {
    const prev = process.env.HONCHO_INSTALL_TIMEOUT_MS;
    process.env.HONCHO_INSTALL_TIMEOUT_MS = "250";
    const root = tempRoot();
    try {
      // `sleep 3` runs far past the 250ms cap. Without a spawnSync timeout it
      // completes with status 0; with the cap it is killed → non-zero + error.
      const result = defaultRun("sleep", ["3"], root);
      expect(result.status).not.toBe(0);
      expect(result.error).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (prev === undefined) delete process.env.HONCHO_INSTALL_TIMEOUT_MS;
      else process.env.HONCHO_INSTALL_TIMEOUT_MS = prev;
    }
  });
});

describe("hooks.json timeouts are in seconds (#59)", () => {
  test("every hook timeout is a sane seconds value (1..600), not milliseconds", () => {
    const raw = readFileSync(join(import.meta.dir, "../hooks/hooks.json"), "utf-8");
    const cfg = JSON.parse(raw) as { hooks: Record<string, Array<{ hooks: Array<{ timeout?: number }> }>> };
    const timeouts: number[] = [];
    for (const groups of Object.values(cfg.hooks)) {
      for (const group of groups) {
        for (const h of group.hooks) {
          if (typeof h.timeout === "number") timeouts.push(h.timeout);
        }
      }
    }
    expect(timeouts.length).toBeGreaterThan(0);
    for (const t of timeouts) {
      expect(t).toBeGreaterThan(0);
      // Claude Code reads hook timeouts as SECONDS (max default 600). A 4–5
      // digit value here means someone wrote milliseconds → effectively uncapped.
      expect(t).toBeLessThanOrEqual(600);
    }
  });
});

describe("defaultRun timeout uses an uncatchable kill (#59 follow-up)", () => {
  test("kills a child that ignores SIGTERM (must be SIGKILL, not SIGTERM)", () => {
    const prev = process.env.HONCHO_INSTALL_TIMEOUT_MS;
    process.env.HONCHO_INSTALL_TIMEOUT_MS = "300";
    const root = tempRoot();
    try {
      // Child traps/ignores SIGTERM then sleeps 5s. If the cap uses SIGTERM the
      // signal is swallowed and spawnSync blocks the full ~5s; only SIGKILL
      // (uncatchable) enforces the deadline. Assert it returns well under 5s.
      const start = Date.now();
      const result = defaultRun("bash", ["-c", "trap '' TERM; sleep 5"], root);
      const elapsed = Date.now() - start;
      expect(result.status).not.toBe(0);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (prev === undefined) delete process.env.HONCHO_INSTALL_TIMEOUT_MS;
      else process.env.HONCHO_INSTALL_TIMEOUT_MS = prev;
    }
  });
});
