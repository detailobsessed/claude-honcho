/**
 * Unit tests for the SessionStart dependency bootstrap (hooks/ensure-deps.ts).
 * The runner is injected so nothing actually shells out to `bun install`.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDeps, type Runner } from "../hooks/ensure-deps";

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
