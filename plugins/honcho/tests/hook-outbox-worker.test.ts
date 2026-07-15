/**
 * Integration tests for the detached outbox worker (src/hooks/outbox-worker.ts).
 *
 * Drives the real handler end-to-end against a seeded outbox and the mocked
 * Honcho client, asserting that it drains queued records when the config and
 * host are reachable, and leaves them queued when the host is not.
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { SHARED_HONCHO_DIR, clearSharedHonchoDir } from "./setup";
import { createMockHoncho, writeHonchoConfig } from "./helpers";
import { setHoncho, stubExit, runHook, createFailingHoncho, clearHonchoEnv } from "./hook-harness";
import { setDetectedHost } from "../src/config";
import { enqueueOutbox } from "../src/outbox";

let handleOutboxWorker: () => Promise<void>;
beforeAll(async () => {
  ({ handleOutboxWorker } = await import("../src/hooks/outbox-worker.ts"));
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

function seedOutbox(content: string): void {
  const now = new Date().toISOString();
  enqueueOutbox([
    {
      sessionName: "sess-x",
      peerName: "claude",
      content,
      metadata: { type: "assistant_response" },
      createdAt: now,
      queuedAt: now,
    },
  ]);
}

describe("outbox worker hook", () => {
  let exitSpy: ReturnType<typeof stubExit>;
  let honcho: ReturnType<typeof createMockHoncho>;
  let originalArgv: string[];

  beforeEach(() => {
    clearSharedHonchoDir();
    clearHonchoEnv();
    setDetectedHost("claude_code");
    exitSpy = stubExit();
    honcho = createMockHoncho();
    setHoncho(honcho);
    originalArgv = process.argv;
    process.argv = [process.argv[0], "worker", "/tmp/proj", "sess-x"];
  });
  afterEach(() => {
    exitSpy.mockRestore();
    process.argv = originalArgv;
  });

  test("exits without touching Honcho when no config exists", async () => {
    seedOutbox("queued while unconfigured");
    expect(await runHook(handleOutboxWorker)).toBe(0);
    expect(Object.keys(honcho.calls)).toHaveLength(0);
  });

  test("drains the queued response to Honcho", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    seedOutbox("the queued assistant response");
    expect(await runHook(handleOutboxWorker)).toBe(0);

    expect(honcho.calls["session.addMessages"]).toBeDefined();
    expect(readOutbox()).toHaveLength(0);
  });

  test("leaves the record queued when the host is unreachable", async () => {
    writeHonchoConfig(SHARED_HONCHO_DIR, baseConfig());
    setHoncho(createFailingHoncho());
    seedOutbox("still queued");
    expect(await runHook(handleOutboxWorker)).toBe(0);

    expect(readOutbox().some((r) => r.content === "still queued")).toBe(true);
  });
});
