/**
 * Tests for outbox.ts — the failure-driven local outbox for message uploads.
 *
 * This is the most critical module to test: it was added by saralilyb to fix
 * the data loss bugs (#45, #57) where messages were silently dropped when
 * the Honcho host was unreachable.
 *
 * Module-level constants (OUTBOX_DIR, OUTBOX_FILE) are computed at import
 * time from homedir(). We set HOME once in beforeAll and clear .honcho
 * between tests.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { clearSharedHonchoDir, SHARED_HONCHO_DIR } from "./setup";
import { createMockHoncho } from "./helpers";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

const honchoDir = SHARED_HONCHO_DIR;

beforeEach(() => {
  clearSharedHonchoDir();
});

function makeRecord(overrides: Partial<any> = {}): any {
  return {
    sessionName: "test-session",
    peerName: "test-peer",
    content: "test message content",
    metadata: { source: "test" },
    createdAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
    ...overrides,
  };
}

function getOutboxPath(): string {
  return join(honchoDir, "outbox.jsonl");
}

function readOutbox(): any[] {
  const path = getOutboxPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("enqueueOutbox", () => {
  it("returns 0 for empty records array", async () => {
    const mod = await import("../src/outbox.js");
    expect(mod.enqueueOutbox([])).toBe(0);
  });

  it("appends records to outbox.jsonl", async () => {
    const mod = await import("../src/outbox.js");
    const count = mod.enqueueOutbox([makeRecord(), makeRecord({ content: "second" })]);
    expect(count).toBe(2);
    const records = readOutbox();
    expect(records.length).toBe(2);
    expect(records[0].content).toBe("test message content");
    expect(records[1].content).toBe("second");
  });

  it("creates .honcho directory if it doesn't exist", async () => {
    const mod = await import("../src/outbox.js");
    mod.enqueueOutbox([makeRecord()]);
    expect(existsSync(honchoDir)).toBe(true);
  });

  it("appends to existing outbox without overwriting", async () => {
    const mod = await import("../src/outbox.js");
    mod.enqueueOutbox([makeRecord({ content: "first" })]);
    mod.enqueueOutbox([makeRecord({ content: "second" })]);
    const records = readOutbox();
    expect(records.length).toBe(2);
    expect(records[0].content).toBe("first");
    expect(records[1].content).toBe("second");
  });

  it("stops appending when file exceeds MAX_OUTBOX_BYTES (5MB)", async () => {
    const mod = await import("../src/outbox.js");
    mkdirSync(honchoDir, { recursive: true });
    const bigContent = "x".repeat(5 * 1024 * 1024 + 1);
    writeFileSync(getOutboxPath(), bigContent);
    const count = mod.enqueueOutbox([makeRecord()]);
    expect(count).toBe(0);
  });
});

describe("drainOutbox", () => {
  it("does nothing when outbox is empty", async () => {
    const mod = await import("../src/outbox.js");
    const honcho = createMockHoncho();
    const logs: string[] = [];
    await mod.drainOutbox(honcho, "instance-1", (msg) => logs.push(msg));
    expect(honcho.calls.session).toBeUndefined();
    expect(logs.length).toBe(0);
  });

  it("drains queued messages to Honcho", async () => {
    const mod = await import("../src/outbox.js");
    mod.enqueueOutbox([
      makeRecord({ sessionName: "sess-a", content: "msg-1" }),
      makeRecord({ sessionName: "sess-a", content: "msg-2" }),
    ]);
    const honcho = createMockHoncho();
    const logs: string[] = [];
    await mod.drainOutbox(honcho, "instance-1", (msg) => logs.push(msg));
    expect(honcho.calls.session).toBeDefined();
    expect(honcho.calls.session.length).toBe(1);
    expect(honcho.calls.session[0][0]).toBe("sess-a");
    expect(honcho.calls["session.addMessages"]).toBeDefined();
    expect(honcho.calls["session.addMessages"].length).toBe(1);
    expect(honcho.calls["session.addMessages"][0][1].length).toBe(2);
    expect(logs.some((l) => l.includes("flushed 2"))).toBe(true);
  });

  it("groups messages by session (one addMessages per session)", async () => {
    const mod = await import("../src/outbox.js");
    mod.enqueueOutbox([
      makeRecord({ sessionName: "sess-a", content: "msg-1" }),
      makeRecord({ sessionName: "sess-b", content: "msg-2" }),
      makeRecord({ sessionName: "sess-a", content: "msg-3" }),
    ]);
    const honcho = createMockHoncho();
    await mod.drainOutbox(honcho, "instance-1", () => {});
    expect(honcho.calls.session.length).toBe(2);
    expect(honcho.calls["session.addMessages"].length).toBe(2);
    const aCall = honcho.calls["session.addMessages"].find((c: any[]) => c[0] === "sess-a");
    const bCall = honcho.calls["session.addMessages"].find((c: any[]) => c[0] === "sess-b");
    expect(aCall[1].length).toBe(2);
    expect(bCall[1].length).toBe(1);
  });

  it("requeues unsent messages when host fails mid-drain", async () => {
    const mod = await import("../src/outbox.js");
    mod.enqueueOutbox([
      makeRecord({ sessionName: "sess-a", content: "msg-1" }),
      makeRecord({ sessionName: "sess-b", content: "msg-2" }),
    ]);
    let count = 0;
    const failHoncho = {
      calls: {} as any,
      session: async (name: string) => {
        count++;
        if (count === 2) throw new Error("host went away");
        const inner = createMockHoncho();
        return inner.session(name);
      },
      peer: async (name: string) => createMockHoncho().peer(name),
    };
    const logs: string[] = [];
    await mod.drainOutbox(failHoncho, "instance-1", (msg) => logs.push(msg));
    const remaining = readOutbox();
    expect(remaining.length).toBe(1);
    expect(remaining[0].sessionName).toBe("sess-b");
    expect(logs.some((l) => l.includes("drain interrupted"))).toBe(true);
  });

  it("respects time budget", async () => {
    const mod = await import("../src/outbox.js");
    const records = [];
    for (let i = 0; i < 20; i++) {
      records.push(makeRecord({ sessionName: `sess-${i}`, content: `msg-${i}` }));
    }
    mod.enqueueOutbox(records);
    const slowHoncho = {
      calls: {} as any,
      session: async (name: string) => {
        await new Promise((r) => setTimeout(r, 50));
        const inner = createMockHoncho();
        return inner.session(name);
      },
      peer: async (name: string) => createMockHoncho().peer(name),
    };
    const logs: string[] = [];
    await mod.drainOutbox(slowHoncho, "instance-1", (msg) => logs.push(msg), {
      timeBudgetMs: 100,
    });
    const remaining = readOutbox();
    expect(remaining.length).toBeGreaterThan(0);
  });

  it("drops records older than maxAgeMs", async () => {
    const mod = await import("../src/outbox.js");
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mod.enqueueOutbox([
      makeRecord({ content: "old-msg", queuedAt: oldDate }),
      makeRecord({ content: "fresh-msg" }),
    ]);
    const honcho = createMockHoncho();
    const logs: string[] = [];
    await mod.drainOutbox(honcho, "instance-1", (msg) => logs.push(msg), {
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(honcho.calls["session.addMessages"]).toBeDefined();
    expect(honcho.calls["session.addMessages"][0][1].length).toBe(1);
    expect(logs.some((l) => l.includes("dropped 1"))).toBe(true);
  });

  it("drops records beyond maxRecords count", async () => {
    const mod = await import("../src/outbox.js");
    const records = [];
    for (let i = 0; i < 15; i++) {
      records.push(makeRecord({ content: `msg-${i}`, sessionName: `sess-${i % 3}` }));
    }
    mod.enqueueOutbox(records);
    const honcho = createMockHoncho();
    const logs: string[] = [];
    await mod.drainOutbox(honcho, "instance-1", (msg) => logs.push(msg), {
      maxRecords: 10,
    });
    expect(logs.some((l) => l.includes("dropped 5"))).toBe(true);
  });

  it("removes claim files after successful drain", async () => {
    const mod = await import("../src/outbox.js");
    mod.enqueueOutbox([makeRecord()]);
    const honcho = createMockHoncho();
    await mod.drainOutbox(honcho, "instance-1", () => {});
    const claimFiles = readdirSync(honchoDir).filter((f) =>
      f.startsWith("outbox.draining-")
    );
    expect(claimFiles.length).toBe(0);
  });

  it("removes outbox.jsonl after claiming it", async () => {
    const mod = await import("../src/outbox.js");
    mod.enqueueOutbox([makeRecord()]);
    const honcho = createMockHoncho();
    await mod.drainOutbox(honcho, "instance-1", () => {});
    expect(existsSync(getOutboxPath())).toBe(false);
  });
});

describe("Outbox record validation (parseRecords)", () => {
  it("skips malformed lines during drain", async () => {
    const mod = await import("../src/outbox.js");
    mkdirSync(honchoDir, { recursive: true });
    const valid = makeRecord({ content: "valid-msg" });
    writeFileSync(
      getOutboxPath(),
      JSON.stringify(valid) + "\n" +
      "this is not json\n" +
      JSON.stringify(makeRecord({ content: "also-valid" })) + "\n"
    );
    const honcho = createMockHoncho();
    const logs: string[] = [];
    await mod.drainOutbox(honcho, "instance-1", (msg) => logs.push(msg));
    expect(honcho.calls["session.addMessages"]).toBeDefined();
    expect(honcho.calls["session.addMessages"][0][1].length).toBe(2);
  });

  it("skips records missing required fields", async () => {
    const mod = await import("../src/outbox.js");
    mkdirSync(honchoDir, { recursive: true });
    writeFileSync(
      getOutboxPath(),
      JSON.stringify({ content: "no session or peer" }) + "\n" +
      JSON.stringify({ sessionName: "s", peerName: "p" }) + "\n" +
      JSON.stringify(makeRecord({ content: "valid" })) + "\n"
    );
    const honcho = createMockHoncho();
    await mod.drainOutbox(honcho, "instance-1", () => {});
    expect(honcho.calls["session.addMessages"][0][1].length).toBe(1);
  });
});

describe("Outbox data loss prevention (regression tests for #45, #57)", () => {
  it("messages survive a host outage: enqueue -> drain later", async () => {
    const mod = await import("../src/outbox.js");
    mod.enqueueOutbox([
      makeRecord({ content: "msg-during-outage-1" }),
      makeRecord({ content: "msg-during-outage-2" }),
    ]);
    expect(readOutbox().length).toBe(2);
    const honcho = createMockHoncho();
    const logs: string[] = [];
    await mod.drainOutbox(honcho, "instance-1", (msg) => logs.push(msg));
    expect(honcho.calls["session.addMessages"][0][1].length).toBe(2);
    expect(logs.some((l) => l.includes("flushed 2"))).toBe(true);
    expect(readOutbox().length).toBe(0);
  });

  it("partial drain on flaky host: some sent, rest requeued", async () => {
    const mod = await import("../src/outbox.js");
    mod.enqueueOutbox([
      makeRecord({ sessionName: "sess-1", content: "msg-1" }),
      makeRecord({ sessionName: "sess-2", content: "msg-2" }),
      makeRecord({ sessionName: "sess-3", content: "msg-3" }),
    ]);
    const flakyHoncho = {
      calls: {} as any,
      session: async (name: string) => {
        if (name === "sess-2") throw new Error("flaky");
        const inner = createMockHoncho();
        return inner.session(name);
      },
      peer: async (name: string) => createMockHoncho().peer(name),
    };
    await mod.drainOutbox(flakyHoncho, "instance-1", () => {});
    const remaining = readOutbox();
    expect(remaining.length).toBe(2);
    expect(remaining.map((r) => r.sessionName)).toContain("sess-2");
    expect(remaining.map((r) => r.sessionName)).toContain("sess-3");
  });
});

describe("drainOutbox batching (#57)", () => {
  it("chunks a session's messages into <=100-item addMessages batches", async () => {
    const mod = await import("../src/outbox.js");
    const records: any[] = [];
    for (let n = 0; n < 250; n++) records.push(makeRecord({ sessionName: "sess-big", content: `m${n}` }));
    mod.enqueueOutbox(records);
    const honcho = createMockHoncho();
    const logs: string[] = [];
    await mod.drainOutbox(honcho, "instance-1", (m) => logs.push(m));
    const calls = honcho.calls["session.addMessages"];
    expect(calls.length).toBe(3); // 250 -> 100 + 100 + 50
    for (const c of calls) expect(c[1].length).toBeLessThanOrEqual(100);
    expect(calls.reduce((t: number, c: any[]) => t + c[1].length, 0)).toBe(250);
    expect(logs.some((l) => l.includes("flushed 250"))).toBe(true);
  });

  it("on a mid-group failure, requeues only the unsent tail (no duplicate re-sends)", async () => {
    const mod = await import("../src/outbox.js");
    const records: any[] = [];
    for (let n = 0; n < 250; n++) records.push(makeRecord({ sessionName: "sess-big", content: `m${n}` }));
    mod.enqueueOutbox(records);
    // Accept the first batch, fail the second.
    let addCalls = 0;
    const honcho: any = {
      calls: {},
      session: async () => ({
        addMessages: async () => {
          addCalls += 1;
          if (addCalls >= 2) throw new Error("host down mid-drain");
        },
      }),
      peer: async (name: string) => ({ message: (content: string, opts?: any) => ({ name, content, opts }) }),
    };
    await mod.drainOutbox(honcho, "instance-1", () => {});
    const requeued = readOutbox();
    expect(requeued.length).toBe(150); // first 100 landed; only 150 remain
    expect(requeued[0].content).toBe("m100"); // the sent 100 are NOT requeued
    expect(requeued[requeued.length - 1].content).toBe("m249");
  });
});

describe("drainOutbox time-budget abort (#57 review follow-up)", () => {
  it("stops sending remaining chunks once the budget elapses (no background duplicate sends)", async () => {
    const mod = await import("../src/outbox.js");
    const records: any[] = [];
    for (let n = 0; n < 250; n++) records.push(makeRecord({ sessionName: "sess-slow", content: `m${n}` }));
    mod.enqueueOutbox(records);
    let addCalls = 0;
    const honcho: any = {
      calls: {},
      session: async () => ({
        addMessages: async () => {
          addCalls += 1;
          await new Promise((r) => setTimeout(r, 150)); // each batch is slow
        },
      }),
      peer: async (name: string) => ({ message: (content: string, opts?: any) => ({ name, content, opts }) }),
    };
    // Budget expires during the first batch.
    await mod.drainOutbox(honcho, "instance-1", () => {}, { timeBudgetMs: 5 });
    // Let any still-running background work settle before asserting.
    await new Promise((r) => setTimeout(r, 700));
    // Only the in-flight first batch may land; the deadline guard must stop the
    // loop firing the remaining two batches in the background (which would be
    // requeued as unsent → duplicates). Without the guard this is 3.
    expect(addCalls).toBeLessThanOrEqual(1);
  });
});
