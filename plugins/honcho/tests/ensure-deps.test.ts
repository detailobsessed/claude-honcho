/**
 * Unit tests for the SessionStart dependency bootstrap (hooks/ensure-deps.ts).
 * The runner is injected so nothing actually shells out to `bun install`.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDeps, type Runner } from "../hooks/ensure-deps";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "honcho-deps-"));
}

describe("ensureDeps", () => {
  test("skips install when node_modules already exists", () => {
    const root = tempRoot();
    mkdirSync(join(root, "node_modules"));
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
