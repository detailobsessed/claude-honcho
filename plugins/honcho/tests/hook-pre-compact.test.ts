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
 *
 * `createMockHoncho` (tests/helpers.ts) has no `session.summaries()` method,
 * which this hook calls. Per the task's constraints, helpers.ts is not
 * edited — instead this file defines small inline mocks below that mirror
 * `createMockHoncho`'s / `createFailingHoncho`'s record pattern, extended
 * with `summaries()`.
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { spyOn } from "bun:test";
import { SHARED_HONCHO_DIR, clearSharedHonchoDir } from "./setup";
import { createMockHoncho, writeHonchoConfig } from "./helpers";
import { setHoncho, stubExit, runHook, clearHonchoEnv } from "./hook-harness";
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

/** A Honcho double whose session also exposes `summaries()`, which pre-compact needs. */
function createMockHonchoWithSummaries(summaries: any): any {
  const calls: Record<string, any[]> = {};
  function record(name: string, args: any[]) {
    if (!calls[name]) calls[name] = [];
    calls[name].push(args);
  }
  const mockSession = (name: string) => ({
    id: `session-${name}`,
    name,
    summaries: async () => {
      record("session.summaries", [name]);
      return summaries;
    },
    addMessages: async (messages: any[]) => {
      record("session.addMessages", [name, messages]);
    },
  });
  const mockPeer = (name: string) => ({
    id: `peer-${name}`,
    name,
    message: (content: string, opts?: any) => ({ peerName: name, content, opts }),
    context: async (opts?: any) => {
      record("peer.context", [name, opts]);
      return { representation: "mock-representation", peerCard: ["mock-card"] };
    },
    chat: async (query: string, opts?: any) => {
      record("peer.chat", [name, query, opts]);
      return "mock-chat-response";
    },
  });
  return {
    calls,
    session: async (name: string) => {
      record("session", [name]);
      return mockSession(name);
    },
    peer: async (name: string) => {
      record("peer", [name]);
      return mockPeer(name);
    },
  };
}

/** A Honcho double whose session/peer resolve fine, but every method on them rejects. */
function createFailingHonchoWithSummaries(message = "host unreachable"): any {
  const calls: Record<string, any[]> = {};
  function record(name: string, args: any[]) {
    if (!calls[name]) calls[name] = [];
    calls[name].push(args);
  }
  return {
    calls,
    session: async (name: string) => {
      record("session", [name]);
      return {
        summaries: async () => {
          throw new Error(message);
        },
        addMessages: async () => {
          throw new Error(message);
        },
      };
    },
    peer: async (name: string) => {
      record("peer", [name]);
      return {
        message: (content: string, opts?: any) => ({ peerName: name, content, opts }),
        context: async () => {
          throw new Error(message);
        },
        chat: async () => {
          throw new Error(message);
        },
      };
    },
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
    const richHoncho = createMockHonchoWithSummaries({
      shortSummary: { content: "We were refactoring the auth module." },
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
    const richHoncho = createMockHonchoWithSummaries({ shortSummary: null });
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
    const failingHoncho = createFailingHonchoWithSummaries();
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
