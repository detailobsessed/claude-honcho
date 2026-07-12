/**
 * Test helpers — temp directory management and mock factories.
 *
 * IMPORTANT: The plugin's modules (cache.ts, outbox.ts, config.ts) call
 * `homedir()` from the `os` module at MODULE LOAD TIME to compute paths
 * like `join(homedir(), ".honcho")`. On macOS, `os.homedir()` uses
 * `getpwuid()`, NOT the `$HOME` env var, so setting `process.env.HOME`
 * has no effect.
 *
 * Strategy: use Bun's `mock.module()` to replace `os.homedir()` with a
 * function that returns our temp directory. Each test file sets this up
 * once in a `beforeAll` hook, and `beforeEach` clears the .honcho dir.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Create a unique temp directory and return its path. */
export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "honcho-test-"));
}

/** Recursively remove a directory, ignoring errors. */
export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Create a fake git repo in a temp directory with an initial commit.
 * Returns the path. Caller is responsible for cleanup.
 */
export function makeFakeGitRepo(): string {
  const dir = makeTempDir();
  const { execSync } = require("child_process");
  const git = (args: string) =>
    execSync(`git ${args}`, { cwd: dir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  git("init -b main");
  git('config user.email "test@test.com"');
  git('config user.name "Test"');
  git("config commit.gpgsign false"); // disable global GPG signing (1Password agent)
  writeFileSync(join(dir, "README.md"), "# test\n");
  git("add README.md");
  git('commit -m "feat: initial commit"');
  return dir;
}

/** Run a git command in a directory and return trimmed output. */
export function gitIn(dir: string, args: string): string {
  const { execSync } = require("child_process");
  return execSync(`git ${args}`, { cwd: dir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Write a config.json to a .honcho directory. */
export function writeHonchoConfig(honchoDir: string, config: Record<string, unknown>): void {
  mkdirSync(honchoDir, { recursive: true });
  writeFileSync(join(honchoDir, "config.json"), JSON.stringify(config, null, 2));
}

/**
 * Clear all contents of a .honcho directory without removing the dir itself.
 * This resets state between tests while keeping the module-cached path valid.
 */
export function clearHonchoDir(honchoDir: string): void {
  if (!existsSync(honchoDir)) return;
  for (const entry of readdirSync(honchoDir)) {
    try {
      unlinkSync(join(honchoDir, entry));
    } catch {
      // ignore
    }
  }
}

/**
 * A minimal mock of the Honcho SDK client. Tracks all method calls so tests can
 * assert on them. Pass `contextResult` / `summaries` to control what
 * `peer.context()` / `session.summaries()` resolve to.
 */
export function createMockHoncho(
  overrides: { contextResult?: any; summaries?: any } = {},
): any {
  const calls: Record<string, any[]> = {};

  function record(name: string, args: any[]) {
    if (!calls[name]) calls[name] = [];
    calls[name].push(args);
  }

  const mockSession = (name: string) => ({
    id: `session-${name}`,
    name,
    addPeers: async (...args: any[]) => { record("session.addPeers", [name, ...args]); },
    addMessages: async (messages: any[]) => { record("session.addMessages", [name, messages]); },
    summaries: async () => { record("session.summaries", [name]); return overrides.summaries ?? null; },
  });

  const mockPeer = (name: string) => ({
    id: `peer-${name}`,
    name,
    message: (content: string, opts?: any) => ({ peerName: name, content, opts }),
    context: async (opts?: any) => {
      record("peer.context", [name, opts]);
      // peerCard is an array of strings, matching the real SDK (callers .join() it).
      return overrides.contextResult ?? { representation: "mock-representation", peerCard: ["mock-card"] };
    },
    chat: async (query: string, opts?: any) => {
      record("peer.chat", [name, query, opts]);
      return "mock-chat-response";
    },
  });

  return {
    calls,
    session: async (name: string) => { record("session", [name]); return mockSession(name); },
    peer: async (name: string) => { record("peer", [name]); return mockPeer(name); },
  };
}
