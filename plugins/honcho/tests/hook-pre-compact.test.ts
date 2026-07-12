/**
 * Integration tests for the PreCompact hook (src/hooks/pre-compact.ts).
 *
 * Drives the real handler end-to-end with fake stdin (via cacheStdin) and a
 * config on the mocked temp home, asserting on the mocked Honcho calls and
 * the memory-card text written to stdout — i.e. that the hook fetches
 * context/summaries/dialectic in parallel and anchors them into the
 * transcript right before compaction, honors the observation-mode read lens,
 * and degrades gracefully (never blocking compaction) when Honcho is
 * unreachable.
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { spyOn } from "bun:test";
import { SHARED_HONCHO_DIR, clearSharedHonchoDir } from "./setup";
import { createMockHoncho, writeHonchoConfig } from "./helpers";
import { setHoncho, stubExit, runHook, clearHonchoEnv, createFailingHoncho } from "./hook-harness";
import { cacheStdin, setDetectedHost } from "../src/config";

let handlePreCompact: () => Promise<void>;
beforeAll(async () => {
  ({ handlePreCompact } = await import("../src/hooks/pre-compact.ts"));
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

describe("pre-compact hook", () => {
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
    cacheStdin(JSON.stringify({ trigger: "manual" }));
    expect(await runHook(handlePreCompact)).toBe(0);
    expect(Object.keys(honcho.calls)).toHaveLength(0);
  });

  test("does nothing when the plugin is disabled", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig({ enabled: false }));
    cacheStdin(JSON.stringify({ trigger: "manual" }));
    expect(await runHook(handlePreCompact)).toBe(0);
    expect(Object.keys(honcho.calls)).toHaveLength(0);
  });

  test("anchors memory with context, summaries, and dialectic on the happy path (unified mode)", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    const richHoncho = createMockHoncho({
      summaries: { shortSummary: { content: "We were refactoring the auth module." } },
    });
    setHoncho(richHoncho);
    const logSpy = spyOn(console, "log");
    cacheStdin(JSON.stringify({ session_id: "s1", cwd: "/tmp/proj", trigger: "manual" }));

    expect(await runHook(handlePreCompact)).toBe(0);

    const contextCall = richHoncho.calls["peer.context"][0];
    expect(contextCall[0]).toBe("tester");
    expect(contextCall[1]).toEqual({ maxConclusions: 30, includeMostFrequent: true });

    expect(richHoncho.calls["session.summaries"]).toHaveLength(1);

    expect(richHoncho.calls["peer.chat"]).toHaveLength(2);
    for (const [name, , opts] of richHoncho.calls["peer.chat"]) {
      expect(name).toBe("tester");
      expect(opts.reasoningLevel).toBe("low");
      expect(opts.session).toBeDefined();
    }

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain("We were refactoring the auth module.");
    expect(output).toContain("mock-chat-response");
    expect(output).toContain("HONCHO MEMORY ANCHOR");
    logSpy.mockRestore();
  });

  test("directional mode queries the AI peer's lens with target", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig({ observationMode: "directional" }));
    const richHoncho = createMockHoncho({ summaries: { shortSummary: null } });
    setHoncho(richHoncho);
    cacheStdin(JSON.stringify({ session_id: "s2", cwd: "/tmp/proj", trigger: "manual" }));

    expect(await runHook(handlePreCompact)).toBe(0);

    const contextCall = richHoncho.calls["peer.context"][0];
    expect(contextCall[0]).toBe("claude");
    expect(contextCall[1]).toEqual({ target: "tester", maxConclusions: 30, includeMostFrequent: true });

    expect(richHoncho.calls["peer.chat"]).toHaveLength(2);
    for (const [name, , opts] of richHoncho.calls["peer.chat"]) {
      expect(name).toBe("claude");
      expect(opts.target).toBe("tester");
    }
  });

  test("degrades to a header-only anchor when context/summaries/dialectic all fail", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    const failingHoncho = createFailingHoncho();
    setHoncho(failingHoncho);
    const logSpy = spyOn(console, "log");
    cacheStdin(JSON.stringify({ session_id: "s3", cwd: "/tmp/proj", trigger: "manual" }));

    // Promise.allSettled swallows each rejection individually, so the hook
    // still completes successfully — just without any conclusions to anchor.
    expect(await runHook(handlePreCompact)).toBe(0);

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain("HONCHO MEMORY ANCHOR");
    expect(output).not.toContain("mock-representation");
    expect(output).not.toContain("mock-card");
    expect(output).not.toContain("Session Context (PRESERVE)");
    logSpy.mockRestore();
  });

  test("logs a warning and still exits 0 when session setup itself fails", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    const calls: Record<string, any[]> = {};
    const brokenHoncho = {
      calls,
      session: async (name: string) => {
        if (!calls["session"]) calls["session"] = [];
        calls["session"].push([name]);
        throw new Error("host down");
      },
      peer: async (name: string) => {
        if (!calls["peer"]) calls["peer"] = [];
        calls["peer"].push([name]);
        return { message: (c: string) => c, context: async () => null, chat: async () => null };
      },
    };
    setHoncho(brokenHoncho);
    const errorSpy = spyOn(console, "error");
    cacheStdin(JSON.stringify({ session_id: "s4", cwd: "/tmp/proj", trigger: "auto" }));

    expect(await runHook(handlePreCompact)).toBe(0);

    expect(brokenHoncho.calls["session"]).toBeDefined();
    // Never blocks compaction: the hook logs a warning and exits cleanly.
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("Pre-compact warning"))).toBe(true);
    errorSpy.mockRestore();
  });
});
