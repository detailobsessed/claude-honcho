/**
 * Tests for cache.ts — ID cache, context cache, message queue, git state,
 * chunking.
 *
 * Module-level constants (CACHE_DIR etc.) are computed at import time from
 * homedir(). We set HOME once in beforeAll and clear .honcho between tests.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { clearSharedHonchoDir, SHARED_HONCHO_DIR } from "./setup";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const honchoDir = SHARED_HONCHO_DIR;

beforeEach(() => {
  clearSharedHonchoDir();
});

describe("ID Cache", () => {
  it("loadIdCache returns empty object when no cache file", async () => {
    const mod = await import("../src/cache.js");
    const cache = mod.loadIdCache();
    expect(cache).toEqual({});
  });

  it("setCachedWorkspaceId and getCachedWorkspaceId round-trip", async () => {
    const mod = await import("../src/cache.js");
    mod.setCachedWorkspaceId("test-ws", "ws-id-123");
    expect(mod.getCachedWorkspaceId("test-ws")).toBe("ws-id-123");
  });

  it("getCachedWorkspaceId returns null for different workspace name", async () => {
    const mod = await import("../src/cache.js");
    mod.setCachedWorkspaceId("test-ws", "ws-id-123");
    expect(mod.getCachedWorkspaceId("other-ws")).toBeNull();
  });

  it("setCachedPeerId and getCachedPeerId round-trip", async () => {
    const mod = await import("../src/cache.js");
    mod.setCachedPeerId("alice", "peer-id-456");
    expect(mod.getCachedPeerId("alice")).toBe("peer-id-456");
  });

  it("setCachedSessionId stores per-cwd session info", async () => {
    const mod = await import("../src/cache.js");
    mod.setCachedSessionId("/project/dir", "session-name", "session-id-789");
    expect(mod.getCachedSessionId("/project/dir")).toBe("session-id-789");
  });

  it("setCachedSessionId stores instanceId for parallel session support", async () => {
    const mod = await import("../src/cache.js");
    mod.setCachedSessionId("/project/dir", "session-name", "session-id-789", "instance-abc");
    expect(mod.getInstanceIdForCwd("/project/dir")).toBe("instance-abc");
  });

  it("getInstanceIdForCwd returns null when no instanceId stored", async () => {
    const mod = await import("../src/cache.js");
    mod.setCachedSessionId("/project/dir", "session-name", "session-id-789");
    expect(mod.getInstanceIdForCwd("/project/dir")).toBeNull();
  });

  it("getLastActiveCwd returns the most recently updated cwd", async () => {
    const mod = await import("../src/cache.js");
    mod.setCachedSessionId("/project/a", "sess-a", "id-a");
    await new Promise((r) => setTimeout(r, 10));
    mod.setCachedSessionId("/project/b", "sess-b", "id-b");
    expect(mod.getLastActiveCwd()).toBe("/project/b");
  });

  it("getLastActiveCwd returns null when no sessions cached", async () => {
    const mod = await import("../src/cache.js");
    expect(mod.getLastActiveCwd()).toBeNull();
  });
});

describe("Context Cache", () => {
  it("getCachedUserContext returns null when no cache", async () => {
    const mod = await import("../src/cache.js");
    expect(mod.getCachedUserContext()).toBeNull();
  });

  it("setCachedUserContext and getCachedUserContext round-trip within TTL", async () => {
    const mod = await import("../src/cache.js");
    mod.setCachedUserContext({ representation: "test-rep" });
    const result = mod.getCachedUserContext();
    expect(result).not.toBeNull();
    expect(result.representation).toBe("test-rep");
  });

  it("getStaleCachedUserContext returns data even after TTL expires", async () => {
    const mod = await import("../src/cache.js");
    mod.setCachedUserContext({ representation: "stale-rep" });
    // Manually backdate the fetchedAt timestamp
    const cache = mod.loadContextCache();
    cache.userContext!.fetchedAt = Date.now() - 999999999;
    mod.saveContextCache(cache);
    expect(mod.getCachedUserContext()).toBeNull();
    expect(mod.getStaleCachedUserContext()).not.toBeNull();
    expect(mod.getStaleCachedUserContext().representation).toBe("stale-rep");
  });

  it("isContextCacheStale returns true when no cache", async () => {
    const mod = await import("../src/cache.js");
    expect(mod.isContextCacheStale()).toBe(true);
  });

  it("isContextCacheStale returns false within TTL", async () => {
    const mod = await import("../src/cache.js");
    mod.setCachedUserContext({ data: "test" });
    expect(mod.isContextCacheStale()).toBe(false);
  });

  it("message count tracking", async () => {
    const mod = await import("../src/cache.js");
    expect(mod.getMessageCount()).toBe(0);
    mod.incrementMessageCount();
    mod.incrementMessageCount();
    mod.incrementMessageCount();
    expect(mod.getMessageCount()).toBe(3);
  });

  it("shouldRefreshKnowledgeGraph triggers after threshold", async () => {
    const mod = await import("../src/cache.js");
    for (let i = 0; i < 50; i++) {
      mod.incrementMessageCount();
    }
    expect(mod.shouldRefreshKnowledgeGraph()).toBe(true);
    mod.markKnowledgeGraphRefreshed();
    expect(mod.shouldRefreshKnowledgeGraph()).toBe(false);
  });

  it("resetMessageCount zeroes count and lastRefresh", async () => {
    const mod = await import("../src/cache.js");
    for (let i = 0; i < 10; i++) {
      mod.incrementMessageCount();
    }
    mod.markKnowledgeGraphRefreshed();
    mod.resetMessageCount();
    expect(mod.getMessageCount()).toBe(0);
    expect(mod.shouldRefreshKnowledgeGraph()).toBe(false);
  });
});

describe("Message Queue", () => {
  it("queueMessage and getQueuedMessages round-trip", async () => {
    const mod = await import("../src/cache.js");
    mod.queueMessage("hello world", "peer-id", "/cwd");
    const messages = mod.getQueuedMessages();
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("hello world");
    expect(messages[0].peerId).toBe("peer-id");
    expect(messages[0].cwd).toBe("/cwd");
    expect(messages[0].uploaded).toBe(false);
  });

  it("getQueuedMessages filters by cwd", async () => {
    const mod = await import("../src/cache.js");
    mod.queueMessage("msg1", "peer1", "/cwd-a");
    mod.queueMessage("msg2", "peer2", "/cwd-b");
    const forA = mod.getQueuedMessages("/cwd-a");
    expect(forA.length).toBe(1);
    expect(forA[0].content).toBe("msg1");
  });

  it("markMessagesUploaded removes messages for specific cwd", async () => {
    const mod = await import("../src/cache.js");
    mod.queueMessage("msg1", "peer1", "/cwd-a");
    mod.queueMessage("msg2", "peer2", "/cwd-b");
    mod.markMessagesUploaded("/cwd-a");
    const remaining = mod.getQueuedMessages();
    expect(remaining.length).toBe(1);
    expect(remaining[0].cwd).toBe("/cwd-b");
  });

  it("clearMessageQueue removes all messages", async () => {
    const mod = await import("../src/cache.js");
    mod.queueMessage("msg1", "peer1", "/cwd-a");
    mod.queueMessage("msg2", "peer2", "/cwd-b");
    mod.clearMessageQueue();
    expect(mod.getQueuedMessages().length).toBe(0);
  });
});

describe("Git State Cache", () => {
  it("getCachedGitState returns null when no cache", async () => {
    const mod = await import("../src/cache.js");
    expect(mod.getCachedGitState("/project")).toBeNull();
  });

  it("setCachedGitState and getCachedGitState round-trip", async () => {
    const mod = await import("../src/cache.js");
    const state = {
      branch: "main",
      commit: "abc1234",
      commitMessage: "test commit",
      isDirty: false,
      dirtyFiles: [],
      timestamp: new Date().toISOString(),
    };
    mod.setCachedGitState("/project", state);
    const result = mod.getCachedGitState("/project");
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("main");
    expect(result!.commit).toBe("abc1234");
  });
});

describe("detectGitChanges", () => {
  it("returns initial change when no previous state", async () => {
    const mod = await import("../src/cache.js");
    const current = {
      branch: "main",
      commit: "abc1234",
      commitMessage: "initial",
      isDirty: false,
      dirtyFiles: [],
      timestamp: new Date().toISOString(),
    };
    const changes = mod.detectGitChanges(null, current);
    expect(changes.length).toBe(1);
    expect(changes[0].type).toBe("initial");
  });

  it("detects branch switch", async () => {
    const mod = await import("../src/cache.js");
    const previous = {
      branch: "main",
      commit: "abc1234",
      commitMessage: "old",
      isDirty: false,
      dirtyFiles: [],
      timestamp: new Date().toISOString(),
    };
    const current = {
      branch: "feature/test",
      commit: "def5678",
      commitMessage: "new",
      isDirty: false,
      dirtyFiles: [],
      timestamp: new Date().toISOString(),
    };
    const changes = mod.detectGitChanges(previous, current);
    const branchChange = changes.find((c: any) => c.type === "branch_switch");
    expect(branchChange).toBeDefined();
    expect(branchChange!.from).toBe("main");
    expect(branchChange!.to).toBe("feature/test");
  });

  it("detects new commits on same branch", async () => {
    const mod = await import("../src/cache.js");
    const previous = {
      branch: "main",
      commit: "abc1234",
      commitMessage: "old",
      isDirty: false,
      dirtyFiles: [],
      timestamp: new Date().toISOString(),
    };
    const current = {
      branch: "main",
      commit: "def5678",
      commitMessage: "new commit",
      isDirty: false,
      dirtyFiles: [],
      timestamp: new Date().toISOString(),
    };
    const changes = mod.detectGitChanges(previous, current);
    const commitChange = changes.find((c: any) => c.type === "new_commits");
    expect(commitChange).toBeDefined();
    expect(commitChange!.from).toBe("abc1234");
    expect(commitChange!.to).toBe("def5678");
  });

  it("detects dirty state change", async () => {
    const mod = await import("../src/cache.js");
    const previous = {
      branch: "main",
      commit: "abc1234",
      commitMessage: "test",
      isDirty: false,
      dirtyFiles: [],
      timestamp: new Date().toISOString(),
    };
    const current = {
      branch: "main",
      commit: "abc1234",
      commitMessage: "test",
      isDirty: true,
      dirtyFiles: ["src/index.ts", "README.md"],
      timestamp: new Date().toISOString(),
    };
    const changes = mod.detectGitChanges(previous, current);
    const fileChange = changes.find((c: any) => c.type === "files_changed");
    expect(fileChange).toBeDefined();
    expect(fileChange!.description).toContain("src/index.ts");
  });
});

describe("chunkContent", () => {
  it("returns single chunk when content fits", async () => {
    const mod = await import("../src/cache.js");
    const result = mod.chunkContent("short content", 1000);
    expect(result.length).toBe(1);
    expect(result[0]).toBe("short content");
  });

  it("splits at newline boundary when possible", async () => {
    const mod = await import("../src/cache.js");
    const line = "x".repeat(50);
    const content = `${line}\n${line}\n${line}`;
    const result = mod.chunkContent(content, 60);
    expect(result.length).toBeGreaterThan(1);
    expect(result[0]).toMatch(/^\[Part 1\/\d+\]/);
  });

  it("splits at space boundary when no newline", async () => {
    const mod = await import("../src/cache.js");
    const content = "word ".repeat(50);
    const result = mod.chunkContent(content, 100);
    expect(result.length).toBeGreaterThan(1);
  });

  it("hard splits when no good boundary", async () => {
    const mod = await import("../src/cache.js");
    const content = "x".repeat(300);
    const result = mod.chunkContent(content, 100);
    expect(result.length).toBeGreaterThan(1);
  });
});

describe("Context cache ghost key cleanup", () => {
  it("strips unknown keys from context cache on load", async () => {
    const mod = await import("../src/cache.js");
    // Write a context cache with a ghost key from an older plugin version
    mkdirSync(honchoDir, { recursive: true });
    const cacheFile = join(honchoDir, "context-cache.json");
    writeFileSync(cacheFile, JSON.stringify({
      userContext: { data: { rep: "test" }, fetchedAt: Date.now() },
      aiContext: { data: "ghost", fetchedAt: Date.now() }, // ghost key
    }));
    // Load should strip aiContext
    const cache = mod.loadContextCache();
    expect(cache.aiContext).toBeUndefined();
    expect(cache.userContext).toBeDefined();
    // File should have been rewritten without the ghost key
    const raw = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(raw.aiContext).toBeUndefined();
  });
});
