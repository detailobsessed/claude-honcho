/**
 * Integration tests for the UserPromptSubmit hook (src/hooks/user-prompt.ts).
 *
 * Drives the real handler end-to-end with fake stdin (via cacheStdin) and a
 * config on the mocked temp home, asserting on the mocked Honcho calls, the
 * stdout JSON Claude Code reads (hookSpecificOutput), and the outbox — i.e.
 * that the hook uploads the prompt, serves cached context instantly, falls
 * back to a fresh search-scoped fetch when the cache is empty, and queues
 * the prompt instead of dropping it when the host is unreachable.
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { spyOn } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { SHARED_HONCHO_DIR, clearSharedHonchoDir } from "./setup";
import { createMockHoncho, writeHonchoConfig } from "./helpers";
import { setHoncho, stubExit, runHook, createFailingHoncho, clearHonchoEnv } from "./hook-harness";
import { cacheStdin, setDetectedHost } from "../src/config";
import { setCachedUserContext } from "../src/cache";

let handleUserPrompt: () => Promise<void>;
beforeAll(async () => {
  ({ handleUserPrompt } = await import("../src/hooks/user-prompt.ts"));
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

describe("user-prompt hook", () => {
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

  test("exits without touching Honcho when no config exists", async () => {
    cacheStdin(JSON.stringify({ prompt: "how do I fix this bug" }));
    expect(await runHook(handleUserPrompt)).toBe(0);
    expect(Object.keys(honcho.calls)).toHaveLength(0);
  });

  test("does nothing when the plugin is disabled", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig({ enabled: false }));
    cacheStdin(JSON.stringify({ prompt: "how do I fix this bug" }));
    expect(await runHook(handleUserPrompt)).toBe(0);
    expect(Object.keys(honcho.calls)).toHaveLength(0);
  });

  test("exits without touching Honcho when the prompt is empty", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    cacheStdin(JSON.stringify({ prompt: "   " }));
    expect(await runHook(handleUserPrompt)).toBe(0);
    expect(Object.keys(honcho.calls)).toHaveLength(0);
  });

  test("uploads the prompt but skips context retrieval for a trivial prompt", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    cacheStdin(JSON.stringify({ session_id: "s1", cwd: "/tmp/proj", prompt: "ok" }));

    expect(await runHook(handleUserPrompt)).toBe(0);

    const addCall = honcho.calls["session.addMessages"];
    expect(addCall).toHaveLength(1);
    const [, messages] = addCall[0];
    expect(messages[0].content).toBe("ok");
    expect(messages[0].opts.metadata.instance_id).toBe("s1");
    expect(honcho.calls["peer.context"]).toBeUndefined();
  });

  test("skips the upload when saveMessages is false but still serves fresh cached context", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig({ saveMessages: false }));
    setCachedUserContext({
      representation: "- likes TypeScript\n- works on the honcho plugin",
      peerCard: ["Senior engineer"],
    });
    const logSpy = spyOn(console, "log");
    cacheStdin(
      JSON.stringify({ session_id: "s2", cwd: "/tmp/proj", prompt: "what do you know about my setup" }),
    );

    expect(await runHook(handleUserPrompt)).toBe(0);

    expect(honcho.calls["session.addMessages"]).toBeUndefined();
    // Fresh cache is served without hitting Honcho at all.
    expect(honcho.calls["peer.context"]).toBeUndefined();

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.hookSpecificOutput.additionalContext).toContain("Senior engineer");
    logSpy.mockRestore();
  });

  test("fetches fresh context via search when no cache exists, using topics from the prompt", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    const contextHoncho = createMockHoncho({
      contextResult: {
        representation: "- debugs auth issues carefully",
        peerCard: ["Backend engineer"],
      },
    });
    setHoncho(contextHoncho);
    const logSpy = spyOn(console, "log");
    cacheStdin(
      JSON.stringify({
        session_id: "s3",
        cwd: "/tmp/proj",
        prompt: "how do I fix the auth bug in session.ts",
      }),
    );

    expect(await runHook(handleUserPrompt)).toBe(0);

    expect(contextHoncho.calls["session.addMessages"]).toHaveLength(1);

    const contextCall = contextHoncho.calls["peer.context"][0];
    expect(contextCall[0]).toBe("tester");
    expect(contextCall[1].searchQuery).toBe("session.ts auth");
    expect(contextCall[1].searchTopK).toBe(5);

    // First message of the session surfaces the session link (production endpoint).
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.systemMessage).toContain("app.honcho.dev");
    logSpy.mockRestore();
  });

  test("queues the prompt to the outbox when the upload fails", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    setHoncho(createFailingHoncho());
    cacheStdin(
      JSON.stringify({ session_id: "s4", cwd: "/tmp/proj", prompt: "remember I prefer dark mode" }),
    );

    expect(await runHook(handleUserPrompt)).toBe(0);

    const queued = readOutbox();
    expect(queued).toHaveLength(1);
    expect(queued[0].content).toBe("remember I prefer dark mode");
    expect(queued[0].peerName).toBe("tester");
    expect(queued[0].metadata.session_affinity).toBeDefined();
  });
});
