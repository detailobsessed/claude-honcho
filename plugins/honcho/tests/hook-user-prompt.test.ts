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
import { setHoncho, stubExit, runHook, createFailingHoncho, createHangingHoncho, clearHonchoEnv } from "./hook-harness";
import { cacheStdin, setDetectedHost, resolveCacheScope } from "../src/config";
import { setCachedUserContext } from "../src/cache";

let handleUserPrompt: () => Promise<void>;
let formatCachedContext: (context: any, peerName: string, seen?: string[]) => {
  parts: string[];
  conclusionCount: number;
  newConclusions: string[];
};
let isHarnessTurn: (prompt: string) => boolean;
beforeAll(async () => {
  ({ handleUserPrompt, formatCachedContext, isHarnessTurn } = await import("../src/hooks/user-prompt.ts") as any);
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

  test("strips a pasted code block and tags it as non-speech", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    cacheStdin(
      JSON.stringify({
        session_id: "s1",
        cwd: "/tmp/proj",
        prompt:
          "Please review this function:\n```ts\nfunction secretFunction() {\n  return 42;\n}\n```\nThanks!",
      }),
    );

    expect(await runHook(handleUserPrompt)).toBe(0);

    const addCall = honcho.calls["session.addMessages"];
    expect(addCall).toHaveLength(1);
    const [, messages] = addCall[0];
    expect(messages[0].content).toContain("[code block removed]");
    expect(messages[0].content).not.toContain("secretFunction");
    expect(messages[0].opts.metadata.type).toBe("user_paste_not_speech");
  });

  test("leaves pure prose unmodified and untagged", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    const prompt = "Please help me refactor the auth module for clarity.";
    cacheStdin(JSON.stringify({ session_id: "s1", cwd: "/tmp/proj", prompt }));

    expect(await runHook(handleUserPrompt)).toBe(0);

    const addCall = honcho.calls["session.addMessages"];
    expect(addCall).toHaveLength(1);
    const [, messages] = addCall[0];
    expect(messages[0].content).toBe(prompt);
    expect(messages[0].opts.metadata.type).toBeUndefined();
  });

  test("skips the upload when saveMessages is false but still serves fresh cached context", async () => {
    const config = baseConfig({ saveMessages: false });
    writeHonchoConfig(SHARED_HONCHO_DIR, config);
    setCachedUserContext(
      "test-ws",
      {
        representation: "- likes TypeScript\n- works on the honcho plugin",
        peerCard: ["Senior engineer"],
      },
      resolveCacheScope(config as any),
    );
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

  test("does NOT queue when the upload times out (avoids a duplicate on drain)", async () => {
    // A timeout is not a confirmed failure: the send may still land server-side,
    // so queuing it would replay a duplicate at the next SessionStart. Only a
    // hard rejection (see the test above) should reach the outbox.
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    setHoncho(createHangingHoncho());
    process.env.HONCHO_UPLOAD_TIMEOUT_MS = "20"; // race the hang deterministically
    cacheStdin(
      JSON.stringify({ session_id: "s5", cwd: "/tmp/proj", prompt: "remember I prefer dark mode" }),
    );

    expect(await runHook(handleUserPrompt)).toBe(0);

    expect(readOutbox()).toHaveLength(0);
  });
});

describe("formatCachedContext dedup (#39: don't re-inject the same conclusions every turn)", () => {
  const context = {
    representation: "[x] likes TypeScript\n[y] uses Bun\n[z] debugs auth",
  };

  test("first turn (empty seen set) surfaces all conclusions", () => {
    const result = formatCachedContext(context, "user", []);
    expect(result.parts.some((p) => p.startsWith("Relevant conclusions:"))).toBe(true);
    const conclusionsPart = result.parts.find((p) => p.startsWith("Relevant conclusions:"))!;
    expect(conclusionsPart).toContain("likes TypeScript");
    expect(conclusionsPart).toContain("uses Bun");
    expect(conclusionsPart).toContain("debugs auth");
    expect(result.newConclusions).toEqual(["likes TypeScript", "uses Bun", "debugs auth"]);
  });

  test("second turn with the same conclusions already seen yields no re-injection", () => {
    const seen = ["likes TypeScript", "uses Bun", "debugs auth"];
    const result = formatCachedContext(context, "user", seen);
    expect(result.parts.some((p) => p.startsWith("Relevant conclusions:"))).toBe(false);
    expect(result.newConclusions).toEqual([]);
  });
});

describe("isHarnessTurn (#66: don't upload harness-injected turns as user messages)", () => {
  test("flags a background task-notification (the turn that polluted the graph)", () => {
    expect(
      isHarnessTurn(
        "<task-notification>The task with ID a6ca4d completed. Output saved to /private/tmp/x.output</task-notification>",
      ),
    ).toBe(true);
  });

  test("flags bash-command echoes and slash-command invocations/output", () => {
    expect(isHarnessTurn("<bash-input>git status</bash-input>")).toBe(true);
    expect(isHarnessTurn("<command-name>/honcho:setup</command-name>")).toBe(true);
    expect(isHarnessTurn("<local-command-stdout>done</local-command-stdout>")).toBe(true);
    expect(isHarnessTurn("  \n<system-reminder>be brief</system-reminder>")).toBe(true);
  });

  test("does NOT flag a genuine user prompt, even one that quotes a wrapper tag mid-text", () => {
    expect(isHarnessTurn("how do I fix this bug")).toBe(false);
    expect(isHarnessTurn("the hook receives a <task-notification> tag — how do I skip it?")).toBe(false);
    // A real prompt with a system-reminder appended after the user's text must survive.
    expect(
      isHarnessTurn("please refactor outbox.ts\n<system-reminder>context follows</system-reminder>"),
    ).toBe(false);
  });
});

describe("user-prompt hook: harness turns (#66)", () => {
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

  test("a task-notification is neither uploaded nor spends a context fetch", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    setCachedUserContext("test-ws", { representation: "- likes TypeScript", peerCard: ["Engineer"] });
    cacheStdin(
      JSON.stringify({
        session_id: "s1",
        cwd: "/tmp/proj",
        prompt:
          "<task-notification>The task with ID a6ca4d completed. Output saved to /private/tmp/x.output</task-notification>",
      }),
    );

    expect(await runHook(handleUserPrompt)).toBe(0);

    // The whole point of #66: this turn must not become a user message.
    expect(honcho.calls["session.addMessages"]).toBeUndefined();
    // ...and it shouldn't burn a dialectic fetch either.
    expect(honcho.calls["peer.context"]).toBeUndefined();
  });

  test("a genuine prompt is still uploaded", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    cacheStdin(JSON.stringify({ session_id: "s1", cwd: "/tmp/proj", prompt: "how do I fix this bug" }));

    expect(await runHook(handleUserPrompt)).toBe(0);

    expect(honcho.calls["session.addMessages"]).toHaveLength(1);
  });
});
