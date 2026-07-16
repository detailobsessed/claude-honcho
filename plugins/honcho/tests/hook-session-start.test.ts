/**
 * Integration tests for the SessionStart hook (src/hooks/session-start.ts).
 *
 * Drives the real handler end-to-end with fake stdin (via cacheStdin), a
 * config on the mocked temp home, and a real (throwaway) git repo, asserting
 * on the mocked Honcho calls — i.e. that the hook sets up the session and
 * peers with the right observation-mode wiring, warms the context cache,
 * fires the dialectic chats, drains any queued outbox messages once the host
 * is reachable, and degrades gracefully (exit 0) when Honcho is down.
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { SHARED_HONCHO_DIR, clearSharedHonchoDir } from "./setup";
import { createMockHoncho, writeHonchoConfig, makeFakeGitRepo, gitIn } from "./helpers";
import { setHoncho, stubExit, runHook, createFailingHoncho, clearHonchoEnv } from "./hook-harness";
import { cacheStdin, setDetectedHost } from "../src/config";
import { enqueueOutbox } from "../src/outbox";

let handleSessionStart: () => Promise<void>;
beforeAll(async () => {
  ({ handleSessionStart } = await import("../src/hooks/session-start.ts"));
});

function baseConfig(extra: Record<string, unknown> = {}) {
  return {
    apiKey: "hch-test-key",
    workspace: "test-ws",
    peerName: "tester",
    aiPeer: "claude",
    saveMessages: true,
    enabled: true,
    ...extra,
  };
}

function readOutbox(): any[] {
  const p = join(SHARED_HONCHO_DIR, "outbox.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("session-start hook", () => {
  let exitSpy: ReturnType<typeof stubExit>;
  let honcho: ReturnType<typeof createMockHoncho>;

  beforeEach(() => {
    clearSharedHonchoDir();
    clearHonchoEnv();
    setDetectedHost("claude_code");
    exitSpy = stubExit();
    honcho = createMockHoncho();
    setHoncho(honcho);
    cacheStdin("{}");
  });
  afterEach(() => exitSpy.mockRestore());

  test("exits 1 and touches no Honcho when no config exists", async () => {
    expect(await runHook(handleSessionStart)).toBe(1);
    expect(Object.keys(honcho.calls)).toHaveLength(0);
  });

  test("does nothing when the plugin is disabled", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig({ enabled: false }));
    expect(await runHook(handleSessionStart)).toBe(0);
    expect(Object.keys(honcho.calls)).toHaveLength(0);
  });

  test("sets up session + peers, warms context, and fires dialectic chats (unified mode)", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    const repo = makeFakeGitRepo();
    cacheStdin(JSON.stringify({ session_id: "inst-1", cwd: repo }));

    expect(await runHook(handleSessionStart)).toBe(0);

    const peerNames = honcho.calls["peer"].map((c: any[]) => c[0]);
    expect(peerNames).toEqual(expect.arrayContaining(["tester", "claude"]));

    // Unified mode: addPeers gets plain peer objects, not directional tuples.
    const [, peersArg] = honcho.calls["session.addPeers"][0];
    expect(peersArg).toHaveLength(2);
    expect(peersArg[0].name).toBe("tester");
    expect(peersArg[1].name).toBe("claude");

    // Reads pull from the user's self-spine in unified mode.
    const contextCall = honcho.calls["peer.context"][0];
    expect(contextCall[0]).toBe("tester");
    expect(contextCall[1]).toEqual({ maxConclusions: 25, includeMostFrequent: true });

    // Two fire-and-forget dialectic chats, both from the user peer's perspective.
    expect(honcho.calls["peer.chat"]).toHaveLength(2);
    for (const [name, query, opts] of honcho.calls["peer.chat"]) {
      expect(name).toBe("tester");
      expect(query).toContain("tester");
      expect(opts.reasoningLevel).toBe("low");
    }
  });

  test("directional mode: per-peer directionality and AI-peer lens targeting the user", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig({ observationMode: "directional" }));
    const repo = makeFakeGitRepo();
    cacheStdin(JSON.stringify({ session_id: "inst-2", cwd: repo }));

    expect(await runHook(handleSessionStart)).toBe(0);

    const [, peersArg] = honcho.calls["session.addPeers"][0];
    expect(peersArg[0][0].name).toBe("tester");
    expect(peersArg[0][1]).toEqual({ observeMe: true, observeOthers: false });
    expect(peersArg[1][0].name).toBe("claude");
    expect(peersArg[1][1]).toEqual({ observeMe: false, observeOthers: true });

    // Reads use the AI peer's lens targeting the user in directional mode.
    const contextCall = honcho.calls["peer.context"][0];
    expect(contextCall[0]).toBe("claude");
    expect(contextCall[1]).toEqual({ target: "tester", maxConclusions: 25, includeMostFrequent: true });

    expect(honcho.calls["peer.chat"]).toHaveLength(2);
    for (const [name, , opts] of honcho.calls["peer.chat"]) {
      expect(name).toBe("claude");
      expect(opts.target).toBe("tester");
    }
  });

  test("drains a queued outbox message once the host is reachable again", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    const queuedAt = new Date().toISOString();
    enqueueOutbox([
      {
        sessionName: "stale-session",
        peerName: "tester",
        content: "queued while host was down",
        metadata: {},
        createdAt: queuedAt,
        queuedAt,
      },
    ]);
    const repo = makeFakeGitRepo();
    cacheStdin(JSON.stringify({ session_id: "inst-3", cwd: repo }));

    expect(await runHook(handleSessionStart)).toBe(0);

    expect(readOutbox()).toHaveLength(0);
    const drained = honcho.calls["session.addMessages"].find(
      ([, messages]: [string, any[]]) => messages[0]?.content === "queued while host was down",
    );
    expect(drained).toBeDefined();
  });

  test("captureGitObservations defaults to off: no [Git External] message even on a real git change", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    const repo = makeFakeGitRepo();
    // First run just seeds the git-state cache (a fresh cache is an "initial"
    // change, which is filtered out regardless of the flag).
    cacheStdin(JSON.stringify({ session_id: "git-1", cwd: repo }));
    expect(await runHook(handleSessionStart)).toBe(0);

    // A real, non-initial change: a new commit on the same branch.
    gitIn(repo, 'commit --allow-empty -m "feat: second commit"');
    cacheStdin(JSON.stringify({ session_id: "git-2", cwd: repo }));
    expect(await runHook(handleSessionStart)).toBe(0);

    const allMessages = (honcho.calls["session.addMessages"] ?? []).flatMap(
      ([, messages]: [string, any[]]) => messages,
    );
    expect(allMessages.some((m) => typeof m.content === "string" && m.content.startsWith("[Git External]"))).toBe(
      false,
    );
  });

  test("captureGitObservations: true uploads a [Git External] message for a new commit", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig({ captureGitObservations: true }));
    const repo = makeFakeGitRepo();
    cacheStdin(JSON.stringify({ session_id: "git-1", cwd: repo }));
    expect(await runHook(handleSessionStart)).toBe(0);

    gitIn(repo, 'commit --allow-empty -m "feat: second commit"');
    cacheStdin(JSON.stringify({ session_id: "git-2", cwd: repo }));
    expect(await runHook(handleSessionStart)).toBe(0);

    const allMessages = (honcho.calls["session.addMessages"] ?? []).flatMap(
      ([, messages]: [string, any[]]) => messages,
    );
    const gitObs = allMessages.filter(
      (m) => typeof m.content === "string" && m.content.startsWith("[Git External]"),
    );
    expect(gitObs.length).toBeGreaterThan(0);
    // Authored by the AI peer, never the user — a commit subject is episodic
    // project activity, not a durable fact about the user. Writing it to the
    // user peer let the deriver mint "<user> did <code work>" misattributions.
    for (const m of gitObs) {
      expect(m.peerName).toBe("claude");
      expect(m.peerName).not.toBe("tester");
    }
  });

  test("degrades gracefully (exit 0) when Honcho is unreachable during peer setup", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    const failingHoncho = createFailingHoncho();
    setHoncho(failingHoncho);
    const repo = makeFakeGitRepo();
    cacheStdin(JSON.stringify({ session_id: "inst-4", cwd: repo }));

    expect(await runHook(handleSessionStart)).toBe(0);

    // session()/peer() resolved (recorded); it's addPeers() that rejects and
    // is caught by the top-level try/catch, so the hook never blocks the CLI.
    expect(failingHoncho.calls["session"]).toBeDefined();
    expect(failingHoncho.calls["peer"]).toBeDefined();
  });
});
