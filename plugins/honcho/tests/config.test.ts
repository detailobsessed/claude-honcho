/**
 * Tests for config.ts — config loading, host detection, session naming.
 *
 * Module-level constants (CONFIG_DIR, CONFIG_FILE) are computed at import
 * time from homedir(). We set HOME once in beforeAll and clear .honcho
 * between tests.
 */
import { describe, expect, it, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { clearSharedHonchoDir, SHARED_HONCHO_DIR, SHARED_HOME } from "./setup";
import { writeHonchoConfig } from "./helpers";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const honchoDir = SHARED_HONCHO_DIR;

/** Read ~/.honcho/config.json back as a raw object (for write-path assertions). */
function readRawConfig(): any {
  return JSON.parse(readFileSync(join(honchoDir, "config.json"), "utf-8"));
}

let originalHonchoApiKey: string | undefined;
let originalHonchoPeerName: string | undefined;
let originalHonchoWorkspace: string | undefined;
let originalHonchoHost: string | undefined;
let originalHonchoEnabled: string | undefined;
let originalCursorProjectDir: string | undefined;

beforeAll(() => {
  originalHonchoApiKey = process.env.HONCHO_API_KEY;
  originalHonchoPeerName = process.env.HONCHO_PEER_NAME;
  originalHonchoWorkspace = process.env.HONCHO_WORKSPACE;
  originalHonchoHost = process.env.HONCHO_HOST;
  originalHonchoEnabled = process.env.HONCHO_ENABLED;
  originalCursorProjectDir = process.env.CURSOR_PROJECT_DIR;
});

beforeEach(() => {
  clearSharedHonchoDir();
  delete process.env.HONCHO_API_KEY;
  delete process.env.HONCHO_PEER_NAME;
  delete process.env.HONCHO_WORKSPACE;
  delete process.env.HONCHO_HOST;
  delete process.env.HONCHO_ENABLED;
  delete process.env.CURSOR_PROJECT_DIR;
});

afterAll(() => {
  // Restore each var to its original value, or delete it if it was unset —
  // a bare "restore only if defined" leaks vars a test set (e.g. HONCHO_ENABLED)
  // into later test files.
  const restore = (key: string, original: string | undefined) => {
    if (original !== undefined) process.env[key] = original;
    else delete process.env[key];
  };
  restore("HONCHO_API_KEY", originalHonchoApiKey);
  restore("HONCHO_PEER_NAME", originalHonchoPeerName);
  restore("HONCHO_WORKSPACE", originalHonchoWorkspace);
  restore("HONCHO_HOST", originalHonchoHost);
  restore("HONCHO_ENABLED", originalHonchoEnabled);
  restore("CURSOR_PROJECT_DIR", originalCursorProjectDir);
});

describe("detectHost", () => {
  it("returns claude_code by default", async () => {
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");
    const host = mod.detectHost();
    expect(host).toBe("claude_code");
  });

  it("returns cursor when HONCHO_HOST=cursor", async () => {
    process.env.HONCHO_HOST = "cursor";
    const mod = await import("../src/config.js");
    const host = mod.detectHost();
    expect(host).toBe("cursor");
  });

  it("returns cursor when stdin has cursor_version", async () => {
    const mod = await import("../src/config.js");
    const host = mod.detectHost({ cursor_version: "1.0.0" });
    expect(host).toBe("cursor");
  });

  it("returns cursor when CURSOR_PROJECT_DIR is set", async () => {
    process.env.CURSOR_PROJECT_DIR = "/some/path";
    const mod = await import("../src/config.js");
    const host = mod.detectHost();
    expect(host).toBe("cursor");
  });
});

describe("loadConfig", () => {
  it("returns null when no config file and no env vars", async () => {
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");
    const config = mod.loadConfig();
    expect(config).toBeNull();
  });

  it("loads from env vars when no config file", async () => {
    process.env.HONCHO_API_KEY = "hch-test-key";
    process.env.HONCHO_PEER_NAME = "testuser";
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");
    const config = mod.loadConfig();
    expect(config).not.toBeNull();
    expect(config!.apiKey).toBe("hch-test-key");
    expect(config!.peerName).toBe("testuser");
    expect(config!.workspace).toBe("claude_code");
    expect(config!.aiPeer).toBe("claude");
  });

  it("loads from config file with hosts block", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-file-key",
      peerName: "fileuser",
      hosts: {
        claude_code: {
          workspace: "my-workspace",
          aiPeer: "my-claude",
        },
      },
    });
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");
    const config = mod.loadConfig();
    expect(config).not.toBeNull();
    expect(config!.apiKey).toBe("hch-file-key");
    expect(config!.peerName).toBe("fileuser");
    expect(config!.workspace).toBe("my-workspace");
    expect(config!.aiPeer).toBe("my-claude");
  });

  it("env var HONCHO_API_KEY overrides config file apiKey", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-file-key",
      peerName: "fileuser",
    });
    process.env.HONCHO_API_KEY = "hch-env-key";
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");
    const config = mod.loadConfig();
    expect(config).not.toBeNull();
    expect(config!.apiKey).toBe("hch-env-key");
  });

  it("host-scoped apiKey takes precedence over root apiKey", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-root-key",
      peerName: "fileuser",
      hosts: {
        claude_code: {
          apiKey: "hch-host-key",
          workspace: "test-ws",
        },
      },
    });
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");
    const config = mod.loadConfig();
    expect(config).not.toBeNull();
    expect(config!.apiKey).toBe("hch-host-key");
  });

  it("globalOverride makes flat workspace apply to all hosts", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      globalOverride: true,
      workspace: "shared-workspace",
      hosts: {
        claude_code: { aiPeer: "claude" },
        cursor: { aiPeer: "cursor" },
      },
    });
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");
    const config = mod.loadConfig();
    expect(config).not.toBeNull();
    expect(config!.workspace).toBe("shared-workspace");
    expect(config!.globalOverride).toBe(true);
  });

  it("returns null when config file has no apiKey and no env var", async () => {
    writeHonchoConfig(honchoDir, {
      peerName: "user",
      hosts: {
        claude_code: { workspace: "test-ws" },
      },
    });
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");
    const config = mod.loadConfig();
    expect(config).toBeNull();
  });

  it("falls back to legacy flat fields when no hosts block", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      workspace: "legacy-ws",
    });
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");
    const config = mod.loadConfig();
    expect(config).not.toBeNull();
    expect(config!.workspace).toBe("legacy-ws");
  });
});

describe("saveConfig unknown-field preservation (upstream #29)", () => {
  it("keeps user-added host fields the plugin doesn't parse across a write", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      hosts: {
        claude_code: {
          workspace: "orig-ws",
          aiPeer: "claude",
          linkedHosts: ["cursor"],
        },
      },
    });
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");

    const config = mod.loadConfig();
    expect(config).not.toBeNull();
    config!.workspace = "new-ws";
    mod.saveConfig(config!);

    const raw = readRawConfig();
    expect(raw.hosts.claude_code.workspace).toBe("new-ws");
    // The unparsed field must survive the round-trip, not get stripped.
    expect(raw.hosts.claude_code.linkedHosts).toEqual(["cursor"]);
  });

  it("carries unknown fields forward from a hyphen/underscore host alias", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      hosts: {
        "claude-code": {
          workspace: "orig-ws",
          linkedHosts: ["obsidian"],
        },
      },
    });
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");

    const config = mod.loadConfig();
    expect(config).not.toBeNull();
    config!.workspace = "new-ws";
    mod.saveConfig(config!);

    const raw = readRawConfig();
    expect(raw.hosts.claude_code.linkedHosts).toEqual(["obsidian"]);
  });

  it("releases the config lock after writing", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      hosts: { claude_code: { workspace: "ws" } },
    });
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");

    const config = mod.loadConfig();
    config!.workspace = "ws2";
    mod.saveConfig(config!);

    // The lockfile withConfigLock takes must be gone once saveConfig returns,
    // otherwise the next writer waits out the stale-lock timeout.
    expect(existsSync(join(honchoDir, "config.json.lock"))).toBe(false);
  });
});

describe("getSessionName", () => {
  it("generates per-directory session name from cwd", async () => {
    process.env.HONCHO_API_KEY = "hch-test";
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");
    const name = mod.getSessionName("/Users/test/my-project", undefined);
    expect(name).toContain("my-project");
  });

  it("includes peer prefix by default", async () => {
    process.env.HONCHO_API_KEY = "hch-test";
    process.env.HONCHO_PEER_NAME = "alice";
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");
    const name = mod.getSessionName("/Users/test/my-project", undefined);
    expect(name).toMatch(/^alice-/);
  });

  it("respects sessionPeerPrefix=false", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "alice",
      sessionPeerPrefix: false,
    });
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");
    const name = mod.getSessionName("/Users/test/my-project", undefined);
    expect(name).not.toMatch(/^alice-/);
  });

  it("uses session override from config.sessions map", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "alice",
      sessions: {
        "/Users/test/my-project": "custom-session-name",
      },
    });
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");
    const name = mod.getSessionName("/Users/test/my-project", undefined);
    expect(name).toBe("custom-session-name");
  });
});

describe("isPluginEnabled", () => {
  it("returns true by default", async () => {
    process.env.HONCHO_API_KEY = "hch-test";
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");
    expect(mod.isPluginEnabled()).toBe(true);
  });

  it("returns false when enabled=false in config", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      enabled: false,
    });
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");
    expect(mod.isPluginEnabled()).toBe(false);
  });

  it("returns false when HONCHO_ENABLED=false", async () => {
    process.env.HONCHO_API_KEY = "hch-test";
    process.env.HONCHO_ENABLED = "false";
    const mod = await import("../src/config.js");
    mod.setDetectedHost("claude_code");
    expect(mod.isPluginEnabled()).toBe(false);
  });
});

describe("applyDirectoryOverride", () => {
  it("returns config unchanged when no config file exists", async () => {
    const mod = await import("../src/config.js");
    const config = {
      apiKey: "hch-key",
      peerName: "user",
      workspace: "default-ws",
      aiPeer: "claude",
    } as import("../src/config.js").HonchoCLAUDEConfig;
    const result = mod.applyDirectoryOverride(config, "/Users/alice/some-project");
    expect(result).toBe(config);
  });

  it("returns config unchanged when directoryWorkspaces has no matching entry", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      directoryWorkspaces: {
        "/Users/alice/other-project": { workspace: "Other" },
      },
    });
    const mod = await import("../src/config.js");
    const config = {
      apiKey: "hch-key",
      peerName: "user",
      workspace: "default-ws",
      aiPeer: "claude",
    } as import("../src/config.js").HonchoCLAUDEConfig;
    const result = mod.applyDirectoryOverride(config, "/Users/alice/some-project");
    expect(result).toBe(config);
  });

  it("patches workspace when directoryWorkspaces has a matching entry", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      directoryWorkspaces: {
        "/Users/alice/work-project": { workspace: "Work" },
      },
    });
    const mod = await import("../src/config.js");
    const config = {
      apiKey: "hch-key",
      peerName: "user",
      workspace: "default-ws",
      aiPeer: "claude",
    } as import("../src/config.js").HonchoCLAUDEConfig;
    const result = mod.applyDirectoryOverride(config, "/Users/alice/work-project");
    expect(result).not.toBe(config);
    expect(result.workspace).toBe("Work");
    // Unrelated fields fall through unchanged
    expect(result.peerName).toBe(config.peerName);
    expect(result.apiKey).toBe(config.apiKey);
    expect(result.aiPeer).toBe(config.aiPeer);
  });

  it("patches apiKey and aiPeer when provided in the override entry", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      directoryWorkspaces: {
        "/Users/alice/work-project": {
          workspace: "Work",
          apiKey: "hch-work-key",
          aiPeer: "work-claude",
        },
      },
    });
    const mod = await import("../src/config.js");
    const config = {
      apiKey: "hch-key",
      peerName: "user",
      workspace: "default-ws",
      aiPeer: "claude",
    } as import("../src/config.js").HonchoCLAUDEConfig;
    const result = mod.applyDirectoryOverride(config, "/Users/alice/work-project");
    expect(result.workspace).toBe("Work");
    expect(result.apiKey).toBe("hch-work-key");
    expect(result.aiPeer).toBe("work-claude");
  });

  it("falls back to the base config's apiKey/aiPeer when the override entry omits them", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      directoryWorkspaces: {
        "/Users/alice/work-project": { workspace: "Work" },
      },
    });
    const mod = await import("../src/config.js");
    const config = {
      apiKey: "hch-base-key",
      peerName: "user",
      workspace: "default-ws",
      aiPeer: "base-claude",
    } as import("../src/config.js").HonchoCLAUDEConfig;
    const result = mod.applyDirectoryOverride(config, "/Users/alice/work-project");
    expect(result.workspace).toBe("Work");
    expect(result.apiKey).toBe("hch-base-key");
    expect(result.aiPeer).toBe("base-claude");
  });

  it("returns the original config on a corrupt config file", async () => {
    const { mkdirSync, writeFileSync } = await import("fs");
    const { join } = await import("path");
    mkdirSync(honchoDir, { recursive: true });
    writeFileSync(join(honchoDir, "config.json"), "{ not valid json");
    const mod = await import("../src/config.js");
    const config = {
      apiKey: "hch-key",
      peerName: "user",
      workspace: "default-ws",
      aiPeer: "claude",
    } as import("../src/config.js").HonchoCLAUDEConfig;
    const result = mod.applyDirectoryOverride(config, "/Users/alice/work-project");
    expect(result).toBe(config);
  });

  it("returns config unchanged when cwd is empty", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      directoryWorkspaces: {
        "": { workspace: "Weird" },
      },
    });
    const mod = await import("../src/config.js");
    const config = {
      apiKey: "hch-key",
      peerName: "user",
      workspace: "default-ws",
      aiPeer: "claude",
    } as import("../src/config.js").HonchoCLAUDEConfig;
    const result = mod.applyDirectoryOverride(config, "");
    expect(result).toBe(config);
  });
});

describe("resolveWorkspaceRule", () => {
  const WORK = `${SHARED_HOME}/code/work`;

  it("returns null when rules are missing or empty", async () => {
    const mod = await import("../src/config.js");
    expect(mod.resolveWorkspaceRule(WORK, undefined)).toBeNull();
    expect(mod.resolveWorkspaceRule(WORK, [])).toBeNull();
  });

  it("matches a directory equal to the prefix and any subdirectory", async () => {
    const mod = await import("../src/config.js");
    const rules = [{ cwdPrefix: "~/code/work", workspace: "Work" }];
    expect(mod.resolveWorkspaceRule(WORK, rules)?.workspace).toBe("Work");
    expect(mod.resolveWorkspaceRule(`${WORK}/repo/src`, rules)?.workspace).toBe("Work");
  });

  it("does not match sibling directories that share a name prefix", async () => {
    const mod = await import("../src/config.js");
    const rules = [{ cwdPrefix: "~/code/work", workspace: "Work" }];
    expect(mod.resolveWorkspaceRule(`${SHARED_HOME}/code/work-old`, rules)).toBeNull();
    expect(mod.resolveWorkspaceRule(`${SHARED_HOME}/code/workshop`, rules)).toBeNull();
  });

  it("expands ~ to the home directory", async () => {
    const mod = await import("../src/config.js");
    const rules = [{ cwdPrefix: "~", workspace: "Home" }];
    expect(mod.resolveWorkspaceRule(`${SHARED_HOME}/anything`, rules)?.workspace).toBe("Home");
  });

  it("normalizes trailing slashes and backslashes on both sides", async () => {
    const mod = await import("../src/config.js");
    const rules = [{ cwdPrefix: "~/code/work/", workspace: "Work" }];
    expect(mod.resolveWorkspaceRule(`${WORK}/`, rules)?.workspace).toBe("Work");
    expect(mod.resolveWorkspaceRule(`${SHARED_HOME}\\code\\work\\repo`, rules)?.workspace).toBe("Work");
  });

  it("chooses the longest matching prefix, not the first in the array", async () => {
    const mod = await import("../src/config.js");
    const rules = [
      { cwdPrefix: "~/code", workspace: "Broad" },
      { cwdPrefix: "~/code/work", workspace: "Work" },
    ];
    expect(mod.resolveWorkspaceRule(`${WORK}/x`, rules)?.workspace).toBe("Work");
    expect(mod.resolveWorkspaceRule(`${SHARED_HOME}/code/other`, rules)?.workspace).toBe("Broad");
  });

  it("ignores an empty prefix instead of matching every directory", async () => {
    const mod = await import("../src/config.js");
    const rules = [{ cwdPrefix: "", workspace: "Everywhere" }];
    expect(mod.resolveWorkspaceRule(`${SHARED_HOME}/anything`, rules)).toBeNull();
  });
});

describe("workspaceRules routing (applyDirectoryOverride + isIsolationCandidate)", () => {
  const WORK = `${SHARED_HOME}/code/work`;
  const base = () => ({
    apiKey: "hch-key",
    peerName: "user",
    workspace: "global-ws",
    aiPeer: "claude",
  } as import("../src/config.js").HonchoCLAUDEConfig);

  it("applyDirectoryOverride patches workspace and aiPeer from a matching prefix rule", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      workspaceRules: [{ cwdPrefix: "~/code/work", workspace: "Work", aiPeer: "work-claude" }],
    });
    const mod = await import("../src/config.js");
    const result = mod.applyDirectoryOverride(base(), `${WORK}/repo`);
    expect(result.workspace).toBe("Work");
    expect(result.aiPeer).toBe("work-claude");
  });

  it("an exact directoryWorkspaces entry wins over a matching prefix rule", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      directoryWorkspaces: { [WORK]: { workspace: "Exact" } },
      workspaceRules: [{ cwdPrefix: "~/code/work", workspace: "Rule" }],
    });
    const mod = await import("../src/config.js");
    expect(mod.applyDirectoryOverride(base(), WORK).workspace).toBe("Exact");
  });

  it("falls through to the same config reference when no rule and no entry match", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      workspaceRules: [{ cwdPrefix: "~/code/work", workspace: "Work" }],
    });
    const mod = await import("../src/config.js");
    const cfg = base();
    expect(mod.applyDirectoryOverride(cfg, `${SHARED_HOME}/code/personal`)).toBe(cfg);
  });

  it("isIsolationCandidate is false for a prefix-covered dir, true for an uncovered one", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      workspaceRules: [{ cwdPrefix: "~/code/work", workspace: "Work" }],
    });
    const mod = await import("../src/config.js");
    expect(mod.isIsolationCandidate(`${WORK}/repo`)).toBe(false);
    expect(mod.isIsolationCandidate(`${SHARED_HOME}/code/personal`)).toBe(true);
  });
});

describe("MCP per-directory resolution (getLastActiveCwd + applyDirectoryOverride)", () => {
  // The MCP server is one long-lived process that can serve tool calls for
  // several project directories over its lifetime. Unlike the hooks, it has no
  // per-call cwd from a hook input, so it resolves the active directory via
  // getLastActiveCwd() and re-applies the override on EVERY request (see
  // src/mcp/server.ts). These tests pin that composition — the piece that
  // closes the "MCP writes attribute to the global workspace/aiPeer while the
  // hooks use the per-directory one" gap: the resolved workspace/aiPeer must
  // follow whichever directory is currently most-recently-active, and must
  // re-resolve per call rather than cache a value from server startup.
  const WORK = "/Users/alice/work-project";
  const SIDE = "/Users/alice/side-project";

  const baseConfig = () => ({
    apiKey: "hch-global-key",
    peerName: "user",
    workspace: "global-ws",
    aiPeer: "claude",
  } as import("../src/config.js").HonchoCLAUDEConfig);

  function writeBothOverrides() {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-global-key",
      peerName: "user",
      workspace: "global-ws",
      aiPeer: "claude",
      directoryWorkspaces: {
        [WORK]: { workspace: "Work", aiPeer: "work-claude" },
        [SIDE]: { workspace: "Side", aiPeer: "side-claude" },
      },
    });
  }

  // Drive the REAL resolution the MCP request handler uses, so a regression in
  // server.ts (e.g. resolving the override once at startup) trips these tests.
  async function resolveActive() {
    const { resolveActiveDirConfig } = await import("../src/mcp/server.js");
    return resolveActiveDirConfig(baseConfig()).config;
  }

  it("routes an MCP call to the workspace/aiPeer of the currently-active directory", async () => {
    writeBothOverrides();
    const cache = await import("../src/cache.js");
    cache.setCachedSessionId(WORK, "sess-work", "id-work");
    await new Promise((r) => setTimeout(r, 10));
    cache.setCachedSessionId(SIDE, "sess-side", "id-side");

    // SIDE is the most-recently-active directory → its override wins.
    const resolved = await resolveActive();
    expect(resolved.workspace).toBe("Side");
    expect(resolved.aiPeer).toBe("side-claude");
  });

  it("re-resolves per call: attribution follows the active dir when it changes", async () => {
    writeBothOverrides();
    const cache = await import("../src/cache.js");
    cache.setCachedSessionId(WORK, "sess-work", "id-work");
    await new Promise((r) => setTimeout(r, 10));
    cache.setCachedSessionId(SIDE, "sess-side", "id-side");
    expect((await resolveActive()).workspace).toBe("Side");

    // A new tool call lands in the WORK session, refreshing its cache entry, so
    // WORK becomes most-recently-active. A server that resolved the override
    // once at startup would still say "Side" here; re-resolving per call flips
    // it to "Work". This assertion is the regression guard for that gap.
    await new Promise((r) => setTimeout(r, 10));
    cache.setCachedSessionId(WORK, "sess-work", "id-work");
    const reresolved = await resolveActive();
    expect(reresolved.workspace).toBe("Work");
    expect(reresolved.aiPeer).toBe("work-claude");
  });

  it("falls back to the global workspace/aiPeer when the active dir has no override entry", async () => {
    // Only WORK is mapped; the active directory is SIDE.
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-global-key",
      peerName: "user",
      workspace: "global-ws",
      aiPeer: "claude",
      directoryWorkspaces: {
        [WORK]: { workspace: "Work", aiPeer: "work-claude" },
      },
    });
    const cache = await import("../src/cache.js");
    cache.setCachedSessionId(SIDE, "sess-side", "id-side");
    const resolved = await resolveActive();
    expect(resolved.workspace).toBe("global-ws");
    expect(resolved.aiPeer).toBe("claude");
  });
});

describe("getHonchoClientOptions SDK timeout (issue #25)", () => {
  // getHonchoClientOptions only reads apiKey + workspace (+ endpoint).
  const baseConfig = {
    apiKey: "hch-test",
    workspace: "test-ws",
  } as unknown as import("../src/config.js").HonchoCLAUDEConfig;

  afterEach(() => {
    delete process.env.HONCHO_SDK_TIMEOUT_MS;
  });

  it("defaults to 8000ms when the env var is unset", async () => {
    delete process.env.HONCHO_SDK_TIMEOUT_MS;
    const { getHonchoClientOptions } = await import("../src/config.js");
    expect(getHonchoClientOptions(baseConfig).timeout).toBe(8000);
  });

  it("is overridable via HONCHO_SDK_TIMEOUT_MS (breaks high/max reasoning at 8s)", async () => {
    process.env.HONCHO_SDK_TIMEOUT_MS = "30000";
    const { getHonchoClientOptions } = await import("../src/config.js");
    expect(getHonchoClientOptions(baseConfig).timeout).toBe(30000);
  });

  it("ignores a non-numeric override and keeps the 8000ms default", async () => {
    process.env.HONCHO_SDK_TIMEOUT_MS = "not-a-number";
    const { getHonchoClientOptions } = await import("../src/config.js");
    expect(getHonchoClientOptions(baseConfig).timeout).toBe(8000);
  });
});

describe("resolveCacheScope", () => {
  const baseConfig = {
    apiKey: "hch-key-a",
    workspace: "test-ws",
  } as unknown as import("../src/config.js").HonchoCLAUDEConfig;

  it("differs for two configs with different apiKey but the same endpoint", async () => {
    const mod = await import("../src/config.js");
    const scopeA = mod.resolveCacheScope(baseConfig);
    const scopeB = mod.resolveCacheScope({ ...baseConfig, apiKey: "hch-key-b" });
    expect(scopeA).not.toBe(scopeB);
  });

  it("differs for different endpoint URLs", async () => {
    const mod = await import("../src/config.js");
    const scopeProd = mod.resolveCacheScope(baseConfig);
    const scopeLocal = mod.resolveCacheScope({
      ...baseConfig,
      endpoint: { environment: "local" },
    } as import("../src/config.js").HonchoCLAUDEConfig);
    expect(scopeProd).not.toBe(scopeLocal);
  });

  it("is stable for the same input", async () => {
    const mod = await import("../src/config.js");
    expect(mod.resolveCacheScope(baseConfig)).toBe(mod.resolveCacheScope(baseConfig));
  });
});

describe("deriveWorkspaceName", () => {
  it("returns the basename of a directory path", async () => {
    const mod = await import("../src/config.js");
    expect(mod.deriveWorkspaceName("/Users/alice/work-project")).toBe("work-project");
  });

  it("ignores a trailing slash", async () => {
    const mod = await import("../src/config.js");
    expect(mod.deriveWorkspaceName("/Users/alice/work-project/")).toBe("work-project");
  });

  it("returns a single segment path unchanged", async () => {
    const mod = await import("../src/config.js");
    expect(mod.deriveWorkspaceName("/single")).toBe("single");
  });

  it("returns empty string for the filesystem root", async () => {
    const mod = await import("../src/config.js");
    expect(mod.deriveWorkspaceName("/")).toBe("");
  });

  it("returns empty string for an empty path", async () => {
    const mod = await import("../src/config.js");
    expect(mod.deriveWorkspaceName("")).toBe("");
  });

  it("with no taken set, behaves unchanged (bare basename)", async () => {
    const mod = await import("../src/config.js");
    expect(mod.deriveWorkspaceName("/work/app")).toBe("app");
  });

  it("disambiguates by prepending the parent segment when the basename is taken", async () => {
    const mod = await import("../src/config.js");
    expect(mod.deriveWorkspaceName("/work/app", new Set(["app"]))).toBe("work-app");
  });

  it("keeps walking up when the first disambiguated name is also taken", async () => {
    // Needs 3+ segments: with only "/work/app" (2 segments), "work-app" is the
    // last name the algorithm can produce (i reaches 0), so it can't avoid a
    // taken "work-app" -- that requires a deeper path to walk further.
    const mod = await import("../src/config.js");
    const result = mod.deriveWorkspaceName("/parent/work/app", new Set(["app", "work-app"]));
    expect(result).not.toBe("app");
    expect(result).not.toBe("work-app");
  });

  it("normalizes a Windows path (backslashes) to its basename", async () => {
    const mod = await import("../src/config.js");
    expect(mod.deriveWorkspaceName("C:\\Users\\me\\app")).toBe("app");
  });

  it("disambiguates a colliding basename on a Windows path", async () => {
    const mod = await import("../src/config.js");
    expect(mod.deriveWorkspaceName("C:\\Users\\me\\app", new Set(["app"]))).toBe("me-app");
  });
});

describe("isAutoIsolateEnabled", () => {
  it("is true when autoIsolate is set to true", async () => {
    writeHonchoConfig(honchoDir, { apiKey: "hch-key", peerName: "user", autoIsolate: true });
    const mod = await import("../src/config.js");
    expect(mod.isAutoIsolateEnabled()).toBe(true);
  });

  it("is false when autoIsolate is false", async () => {
    writeHonchoConfig(honchoDir, { apiKey: "hch-key", peerName: "user", autoIsolate: false });
    const mod = await import("../src/config.js");
    expect(mod.isAutoIsolateEnabled()).toBe(false);
  });

  it("is false when autoIsolate is absent", async () => {
    writeHonchoConfig(honchoDir, { apiKey: "hch-key", peerName: "user" });
    const mod = await import("../src/config.js");
    expect(mod.isAutoIsolateEnabled()).toBe(false);
  });

  it("is false when no config file exists", async () => {
    const mod = await import("../src/config.js");
    expect(mod.isAutoIsolateEnabled()).toBe(false);
  });
});

describe("isIsolationCandidate", () => {
  it("is true for a directory with no directoryWorkspaces entry", async () => {
    writeHonchoConfig(honchoDir, { apiKey: "hch-key", peerName: "user" });
    const mod = await import("../src/config.js");
    expect(mod.isIsolationCandidate("/Users/alice/new-project")).toBe(true);
  });

  it("is false when the directory already has an entry", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      directoryWorkspaces: { "/Users/alice/new-project": { workspace: "New" } },
    });
    const mod = await import("../src/config.js");
    expect(mod.isIsolationCandidate("/Users/alice/new-project")).toBe(false);
  });

  it("is true when only an unrelated directory has an entry", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      directoryWorkspaces: { "/Users/alice/other": { workspace: "Other" } },
    });
    const mod = await import("../src/config.js");
    expect(mod.isIsolationCandidate("/Users/alice/new-project")).toBe(true);
  });

  it("is false when a workspaceRules prefix covers the directory", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      workspaceRules: [{ cwdPrefix: "/Users/alice", workspace: "Alice" }],
    });
    const mod = await import("../src/config.js");
    expect(mod.isIsolationCandidate("/Users/alice/new-project")).toBe(false);
  });

  it("is false for an empty cwd", async () => {
    writeHonchoConfig(honchoDir, { apiKey: "hch-key", peerName: "user" });
    const mod = await import("../src/config.js");
    expect(mod.isIsolationCandidate("")).toBe(false);
  });

  it("is false when no config file exists", async () => {
    const mod = await import("../src/config.js");
    expect(mod.isIsolationCandidate("/Users/alice/new-project")).toBe(false);
  });
});

describe("resolveIsolationAction", () => {
  it("returns none when the directory is already isolated (exact entry)", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      directoryWorkspaces: { "/Users/alice/work-project": { workspace: "Work" } },
    });
    const mod = await import("../src/config.js");
    expect(mod.resolveIsolationAction("/Users/alice/work-project").action).toBe("none");
  });

  it("returns none when a workspaceRules prefix already covers the directory", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      workspaceRules: [{ cwdPrefix: "/Users/alice/work-project", workspace: "Work" }],
    });
    const mod = await import("../src/config.js");
    expect(mod.resolveIsolationAction("/Users/alice/work-project").action).toBe("none");
  });

  it("returns auto with a derived workspace when autoIsolate is on", async () => {
    writeHonchoConfig(honchoDir, { apiKey: "hch-key", peerName: "user", autoIsolate: true });
    const mod = await import("../src/config.js");
    const result = mod.resolveIsolationAction("/Users/alice/work-project");
    expect(result.action).toBe("auto");
    expect(result.workspace).toBe("work-project");
  });

  it("nudges a fresh candidate and KEEPS nudging on the next session (no shown-once gate)", async () => {
    writeHonchoConfig(honchoDir, { apiKey: "hch-key", peerName: "user" });
    const mod = await import("../src/config.js");
    const first = mod.resolveIsolationAction("/Users/alice/work-project");
    expect(first.action).toBe("nudge");
    expect(first.workspace).toBe("work-project");
    // A later session must STILL nudge — the retired shown-once gate returned "none" here.
    expect(mod.resolveIsolationAction("/Users/alice/work-project").action).toBe("nudge");
  });

  it("returns none for a directory the user explicitly kept pooled", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      keepPooled: ["/Users/alice/work-project"],
    });
    const mod = await import("../src/config.js");
    expect(mod.resolveIsolationAction("/Users/alice/work-project").action).toBe("none");
  });

  it("honors keep-pooled over autoIsolate (explicit decline is terminal)", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      autoIsolate: true,
      keepPooled: ["/Users/alice/work-project"],
    });
    const mod = await import("../src/config.js");
    expect(mod.resolveIsolationAction("/Users/alice/work-project").action).toBe("none");
  });

  it("returns none when the workspace name cannot be derived", async () => {
    writeHonchoConfig(honchoDir, { apiKey: "hch-key", peerName: "user", autoIsolate: true });
    const mod = await import("../src/config.js");
    expect(mod.resolveIsolationAction("/").action).toBe("none");
  });

  it("disambiguates a colliding basename against existing directoryWorkspaces entries", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      autoIsolate: true,
      directoryWorkspaces: { "/some/other/app": { workspace: "app" } },
    });
    const mod = await import("../src/config.js");
    const result = mod.resolveIsolationAction("/personal/app");
    expect(result.action).toBe("auto");
    expect(result.workspace).not.toBe("app");
  });
});

describe("isolateDirectory", () => {
  it("writes a directoryWorkspaces entry for the directory", async () => {
    writeHonchoConfig(honchoDir, { apiKey: "hch-key", peerName: "user" });
    const mod = await import("../src/config.js");
    mod.isolateDirectory("/Users/alice/work-project", "work-project");
    expect(readRawConfig().directoryWorkspaces["/Users/alice/work-project"]).toEqual({ workspace: "work-project" });
  });

  it("preserves existing directoryWorkspaces entries and other top-level keys", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      sessions: { "/x": "sess-x" },
      hosts: { claude_code: { workspace: "claude_code" } },
      directoryWorkspaces: { "/Users/alice/other": { workspace: "Other" } },
    });
    const mod = await import("../src/config.js");
    mod.isolateDirectory("/Users/alice/work-project", "work-project");
    const raw = readRawConfig();
    expect(raw.directoryWorkspaces["/Users/alice/other"]).toEqual({ workspace: "Other" });
    expect(raw.directoryWorkspaces["/Users/alice/work-project"]).toEqual({ workspace: "work-project" });
    expect(raw.sessions).toEqual({ "/x": "sess-x" });
    expect(raw.hosts.claude_code.workspace).toBe("claude_code");
    expect(raw.apiKey).toBe("hch-key");
  });

  it("is a no-op when cwd or workspace is empty", async () => {
    writeHonchoConfig(honchoDir, { apiKey: "hch-key", peerName: "user" });
    const mod = await import("../src/config.js");
    mod.isolateDirectory("", "work-project");
    mod.isolateDirectory("/Users/alice/work-project", "");
    expect(readRawConfig().directoryWorkspaces).toBeUndefined();
  });
});

describe("keepDirectoryPooled / wasKeptPooled", () => {
  it("records an explicit keep-pooled decision and reads it back", async () => {
    writeHonchoConfig(honchoDir, { apiKey: "hch-key", peerName: "user" });
    const mod = await import("../src/config.js");
    expect(mod.wasKeptPooled("/Users/alice/work-project")).toBe(false);
    mod.keepDirectoryPooled("/Users/alice/work-project");
    expect(mod.wasKeptPooled("/Users/alice/work-project")).toBe(true);
    expect(readRawConfig().keepPooled).toEqual(["/Users/alice/work-project"]);
  });

  it("does not add a duplicate entry and preserves other top-level keys", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      sessions: { "/x": "sess-x" },
      keepPooled: ["/Users/alice/work-project"],
    });
    const mod = await import("../src/config.js");
    mod.keepDirectoryPooled("/Users/alice/work-project");
    const raw = readRawConfig();
    expect(raw.keepPooled).toEqual(["/Users/alice/work-project"]);
    expect(raw.sessions).toEqual({ "/x": "sess-x" });
    expect(raw.apiKey).toBe("hch-key");
  });

  it("is a no-op for an empty cwd", async () => {
    writeHonchoConfig(honchoDir, { apiKey: "hch-key", peerName: "user" });
    const mod = await import("../src/config.js");
    mod.keepDirectoryPooled("");
    expect(readRawConfig().keepPooled).toBeUndefined();
  });

  it("un-isolates a directory that was previously isolated, so routing actually pools it", async () => {
    writeHonchoConfig(honchoDir, { apiKey: "hch-key", peerName: "user" });
    const mod = await import("../src/config.js");
    const cwd = "/Users/alice/work-project";

    mod.isolateDirectory(cwd, "someworkspace");
    expect(readRawConfig().directoryWorkspaces[cwd]).toEqual({ workspace: "someworkspace" });

    mod.keepDirectoryPooled(cwd);

    const raw = readRawConfig();
    expect(raw.directoryWorkspaces[cwd]).toBeUndefined();
    expect(raw.keepPooled).toContain(cwd);

    const baseConfig = {
      apiKey: "hch-key",
      peerName: "user",
      workspace: "global-ws",
      aiPeer: "claude",
    } as import("../src/config.js").HonchoCLAUDEConfig;
    const resolved = mod.applyDirectoryOverride(baseConfig, cwd);
    expect(resolved.workspace).toBe(baseConfig.workspace);
  });
});

describe("directoryWorkspaces cwd normalization (fix H)", () => {
  const base = () => ({
    apiKey: "hch-key",
    peerName: "user",
    workspace: "default-ws",
    aiPeer: "claude",
  } as import("../src/config.js").HonchoCLAUDEConfig);

  it("an entry keyed '/project' is matched by a cwd with a trailing slash", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      directoryWorkspaces: { "/project": { workspace: "Project" } },
    });
    const mod = await import("../src/config.js");
    const result = mod.applyDirectoryOverride(base(), "/project/");
    expect(result.workspace).toBe("Project");
  });

  it("isolateDirectory stores a normalized key for a Windows-separator cwd, and it round-trips through applyDirectoryOverride", async () => {
    writeHonchoConfig(honchoDir, { apiKey: "hch-key", peerName: "user" });
    const mod = await import("../src/config.js");
    mod.isolateDirectory("C:\\Users\\me\\proj", "proj");
    expect(readRawConfig().directoryWorkspaces["C:/Users/me/proj"]).toEqual({ workspace: "proj" });
    const result = mod.applyDirectoryOverride(base(), "C:\\Users\\me\\proj");
    expect(result.workspace).toBe("proj");
  });

  it("keepDirectoryPooled('/x/') is read back by wasKeptPooled('/x') and removes a prior directoryWorkspaces['/x'] entry", async () => {
    writeHonchoConfig(honchoDir, {
      apiKey: "hch-key",
      peerName: "user",
      directoryWorkspaces: { "/x": { workspace: "X" } },
    });
    const mod = await import("../src/config.js");
    mod.keepDirectoryPooled("/x/");
    expect(mod.wasKeptPooled("/x")).toBe(true);
    expect(readRawConfig().directoryWorkspaces["/x"]).toBeUndefined();
  });
});

describe("parseConfigBool", () => {
  it("passes through actual booleans", async () => {
    const mod = await import("../src/config.js");
    expect(mod.parseConfigBool(true)).toBe(true);
    expect(mod.parseConfigBool(false)).toBe(false);
  });

  it('coerces the string "false" to false (the bug this guards against)', async () => {
    const mod = await import("../src/config.js");
    expect(mod.parseConfigBool("false")).toBe(false);
  });

  it('coerces the string "true" to true', async () => {
    const mod = await import("../src/config.js");
    expect(mod.parseConfigBool("true")).toBe(true);
  });

  it('coerces "0" to false and "1" to true', async () => {
    const mod = await import("../src/config.js");
    expect(mod.parseConfigBool("0")).toBe(false);
    expect(mod.parseConfigBool("1")).toBe(true);
  });

  it("coerces an empty string to false", async () => {
    const mod = await import("../src/config.js");
    expect(mod.parseConfigBool("")).toBe(false);
  });

  it("coerces numeric 0 to false and 1 to true", async () => {
    const mod = await import("../src/config.js");
    expect(mod.parseConfigBool(0)).toBe(false);
    expect(mod.parseConfigBool(1)).toBe(true);
  });

  it('is case-insensitive ("FALSE" -> false)', async () => {
    const mod = await import("../src/config.js");
    expect(mod.parseConfigBool("FALSE")).toBe(false);
  });

  it('coerces "off" to false', async () => {
    const mod = await import("../src/config.js");
    expect(mod.parseConfigBool("off")).toBe(false);
  });
});
