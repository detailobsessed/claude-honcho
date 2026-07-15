/**
 * Integration tests for the PostToolUse hook (src/hooks/post-tool-use.ts).
 *
 * Drives the real handler end-to-end with fake stdin (via cacheStdin) and a
 * config on the mocked temp home, asserting on the mocked Honcho calls — i.e.
 * that the hook logs significant tool uses (Write/Edit/Bash/...) as an
 * assistant-side observation, skips trivial/read-only tool calls, and
 * swallows Honcho failures without blocking Claude Code (this hook has no
 * outbox fallback — a failed upload is dropped, not queued).
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { SHARED_HONCHO_DIR, clearSharedHonchoDir } from "./setup";
import { createMockHoncho, writeHonchoConfig } from "./helpers";
import { setHoncho, stubExit, runHook, createFailingHoncho, clearHonchoEnv } from "./hook-harness";
import { cacheStdin, setDetectedHost } from "../src/config";

let handlePostToolUse: () => Promise<void>;
beforeAll(async () => {
  ({ handlePostToolUse } = await import("../src/hooks/post-tool-use.ts"));
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

describe("post-tool-use hook", () => {
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
    cacheStdin(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "x.ts", content: "x" } }));
    expect(await runHook(handlePostToolUse)).toBe(0);
    expect(Object.keys(honcho.calls)).toHaveLength(0);
  });

  test("does nothing when the plugin is disabled", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig({ enabled: false }));
    cacheStdin(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "x.ts", content: "x" } }));
    expect(await runHook(handlePostToolUse)).toBe(0);
    expect(Object.keys(honcho.calls)).toHaveLength(0);
  });

  test("skips tools that carry no memory signal (Read)", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    cacheStdin(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x.ts" } }));
    expect(await runHook(handlePostToolUse)).toBe(0);
    expect(honcho.calls["session.addMessages"]).toBeUndefined();
  });

  test("skips trivial read-only Bash commands (git status)", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    cacheStdin(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } }));
    expect(await runHook(handlePostToolUse)).toBe(0);
    expect(honcho.calls["session.addMessages"]).toBeUndefined();
  });

  test("logs a Write tool use as an assistant-side observation on the happy path", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    cacheStdin(
      JSON.stringify({
        cwd: "/tmp/proj",
        tool_name: "Write",
        tool_input: { file_path: "/tmp/proj/src/foo.ts", content: "export function foo() { return 1; }" },
      }),
    );

    expect(await runHook(handlePostToolUse)).toBe(0);

    expect(honcho.calls["peer"]?.[0]).toEqual(["claude"]);
    const addCall = honcho.calls["session.addMessages"];
    expect(addCall).toHaveLength(1);
    const [, messages] = addCall[0];
    expect(messages[0].content).toContain("[Tool] Wrote foo.ts");
    expect(messages[0].content).toContain("defines function foo");
    expect(messages[0].opts.metadata.session_affinity).toBeDefined();
    // Role discriminator (#34): a tool action is the assistant acting on the
    // user's behalf, not the user speaking — without this, directional/MCP
    // scopes fold tool actions into the user's own representation.
    expect(messages[0].opts.metadata.type).toBe("tool_action");
    expect(messages[0].opts.metadata.subject).toBe("ai_action_on_user_behalf");
  });

  test("categorizes a Bash package-manager command in the logged summary", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    cacheStdin(JSON.stringify({ cwd: "/tmp/proj", tool_name: "Bash", tool_input: { command: "npm install" } }));

    expect(await runHook(handlePostToolUse)).toBe(0);

    const [, messages] = honcho.calls["session.addMessages"][0];
    expect(messages[0].content).toBe("[Tool] Package install: success");
  });

  test("skips the upload entirely when saveMessages is false", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig({ saveMessages: false }));
    cacheStdin(
      JSON.stringify({ cwd: "/tmp/proj", tool_name: "Write", tool_input: { file_path: "x.ts", content: "x" } }),
    );

    expect(await runHook(handlePostToolUse)).toBe(0);
    expect(Object.keys(honcho.calls)).toHaveLength(0);
  });

  test("skips the upload entirely when captureToolObservations is false", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig({ captureToolObservations: false }));
    cacheStdin(
      JSON.stringify({ cwd: "/tmp/proj", tool_name: "Write", tool_input: { file_path: "x.ts", content: "x" } }),
    );

    expect(await runHook(handlePostToolUse)).toBe(0);
    expect(Object.keys(honcho.calls)).toHaveLength(0);
  });

  test("swallows the error (no outbox fallback) when Honcho is unreachable", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    setHoncho(createFailingHoncho());
    cacheStdin(
      JSON.stringify({ cwd: "/tmp/proj", tool_name: "Write", tool_input: { file_path: "x.ts", content: "x" } }),
    );

    expect(await runHook(handlePostToolUse)).toBe(0);
    // Unlike stop/user-prompt, post-tool-use has no outbox fallback: a failed
    // upload is dropped silently rather than queued for the next SessionStart.
    expect(readOutbox()).toHaveLength(0);
  });
});
