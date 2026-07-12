/**
 * Integration tests for the Stop hook (src/hooks/stop.ts).
 *
 * Drives the real handler end-to-end with fake stdin (via cacheStdin), a
 * config on the mocked temp home, and a fake transcript file, asserting on the
 * mocked Honcho calls and the outbox — i.e. that the hook actually uploads the
 * last assistant message, and queues it instead of dropping it when the host
 * is unreachable.
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { SHARED_HONCHO_DIR, clearSharedHonchoDir } from "./setup";
import { createMockHoncho, writeHonchoConfig, makeTempDir } from "./helpers";
import { setHoncho, stubExit, runHook, createFailingHoncho, clearHonchoEnv } from "./hook-harness";
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
  });
  afterEach(() => exitSpy.mockRestore());

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

  test("uploads the last assistant message on the happy path", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    cacheStdin(
      JSON.stringify({
        session_id: "sess-1",
        cwd: "/tmp/proj",
        transcript_path: assistantTranscript(MEANINGFUL),
      }),
    );
    expect(await runHook(handleStop)).toBe(0);

    expect(honcho.calls["peer"]?.[0]).toEqual(["claude"]);
    const addCall = honcho.calls["session.addMessages"];
    expect(addCall).toHaveLength(1);
    const [, messages] = addCall[0];
    expect(messages[0].content).toBe(MEANINGFUL);
    expect(messages[0].opts.metadata.type).toBe("assistant_response");
  });

  test("queues to the outbox when the upload fails", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    setHoncho(createFailingHoncho());
    cacheStdin(
      JSON.stringify({
        session_id: "sess-2",
        cwd: "/tmp/proj",
        transcript_path: assistantTranscript(MEANINGFUL),
      }),
    );
    expect(await runHook(handleStop)).toBe(0);

    const queued = readOutbox();
    expect(queued).toHaveLength(1);
    expect(queued[0].content).toBe(MEANINGFUL);
    expect(queued[0].peerName).toBe("claude");
    expect(queued[0].metadata.type).toBe("assistant_response");
  });
});
