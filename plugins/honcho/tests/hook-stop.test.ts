/**
 * Integration tests for the Stop hook (src/hooks/stop.ts).
 *
 * Drives the real handler end-to-end with fake stdin (via cacheStdin), a
 * config on the mocked temp home, and a fake transcript file, asserting on the
 * outbox and the spawned worker — i.e. that the hook never uploads on the turn
 * path, but durably queues the last assistant message and fires the detached
 * worker to flush it out-of-band.
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, spyOn } from "bun:test";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { SHARED_HONCHO_DIR, clearSharedHonchoDir } from "./setup";
import { createMockHoncho, writeHonchoConfig, makeTempDir } from "./helpers";
import { setHoncho, stubExit, runHook, clearHonchoEnv } from "./hook-harness";
import { cacheStdin, setDetectedHost } from "../src/config";

let handleStop: () => Promise<void>;
beforeAll(async () => {
  ({ handleStop } = await import("../src/hooks/stop.ts"));
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

/** Write a single-line JSONL transcript with one assistant message. */
function assistantTranscript(text: string): string {
  const p = join(makeTempDir(), "transcript.jsonl");
  writeFileSync(p, JSON.stringify({ type: "assistant", message: { content: text } }) + "\n");
  return p;
}

function readOutbox(): any[] {
  const p = join(SHARED_HONCHO_DIR, "outbox.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const MEANINGFUL = "Here is a thorough explanation of what I changed and why it matters to you.";

describe("stop hook", () => {
  let exitSpy: ReturnType<typeof stubExit>;
  let honcho: ReturnType<typeof createMockHoncho>;
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clearSharedHonchoDir();
    clearHonchoEnv();
    // Hooks normally set the host in initHook(); we bypass that, so prime it
    // here — otherwise a host left behind by another test file leaks in.
    setDetectedHost("claude_code");
    exitSpy = stubExit();
    honcho = createMockHoncho();
    setHoncho(honcho);
    cacheStdin("{}");
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => ({ unref() {} })) as never);
  });
  afterEach(() => {
    exitSpy.mockRestore();
    spawnSpy.mockRestore();
  });

  test("exits without touching Honcho when no config exists", async () => {
    cacheStdin(JSON.stringify({ transcript_path: assistantTranscript(MEANINGFUL) }));
    expect(await runHook(handleStop)).toBe(0);
    expect(Object.keys(honcho.calls)).toHaveLength(0);
  });

  test("does nothing when the plugin is disabled", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig({ enabled: false }));
    cacheStdin(JSON.stringify({ transcript_path: assistantTranscript(MEANINGFUL) }));
    expect(await runHook(handleStop)).toBe(0);
    expect(honcho.calls["session.addMessages"]).toBeUndefined();
  });

  test("does nothing when saveMessages is false", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig({ saveMessages: false }));
    cacheStdin(JSON.stringify({ transcript_path: assistantTranscript(MEANINGFUL) }));
    expect(await runHook(handleStop)).toBe(0);
    expect(honcho.calls["session.addMessages"]).toBeUndefined();
  });

  test("skips when stop_hook_active is set (avoids re-entrancy)", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    cacheStdin(
      JSON.stringify({ stop_hook_active: true, transcript_path: assistantTranscript(MEANINGFUL) }),
    );
    expect(await runHook(handleStop)).toBe(0);
    expect(honcho.calls["session.addMessages"]).toBeUndefined();
  });

  test("skips when the last assistant message is not meaningful", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    cacheStdin(JSON.stringify({ transcript_path: assistantTranscript("ok") }));
    expect(await runHook(handleStop)).toBe(0);
    expect(honcho.calls["session.addMessages"]).toBeUndefined();
  });

  test("queues the response and spawns the detached upload worker", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    cacheStdin(
      JSON.stringify({
        session_id: "sess-1",
        cwd: "/tmp/proj",
        transcript_path: assistantTranscript(MEANINGFUL),
      }),
    );
    expect(await runHook(handleStop)).toBe(0);

    // Never uploads in-process — the turn must not block on the network.
    expect(honcho.calls["session.addMessages"]).toBeUndefined();

    // Response durably queued (for the worker, and the next-start drain fallback).
    const queued = readOutbox();
    expect(queued).toHaveLength(1);
    expect(queued[0].content).toBe(MEANINGFUL);
    expect(queued[0].peerName).toBe("claude");
    expect(queued[0].metadata.type).toBe("assistant_response");

    // Detached worker spawned to flush the outbox out-of-band.
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [argv, opts] = spawnSpy.mock.calls[0] as [string[], any];
    expect(argv[0]).toBe("bun");
    expect(String(argv[2])).toContain("outbox-worker");
    expect(argv[3]).toBe("/tmp/proj");
    expect(opts.detached).toBe(true);
  });
});
