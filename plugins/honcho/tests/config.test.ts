/**
 * Tests for config.ts — config loading, host detection, session naming.
 *
 * Module-level constants (CONFIG_DIR, CONFIG_FILE) are computed at import
 * time from homedir(). We set HOME once in beforeAll and clear .honcho
 * between tests.
 */
import { describe, expect, it, beforeAll, beforeEach, afterAll } from "bun:test";
import { clearSharedHonchoDir, SHARED_HONCHO_DIR } from "./setup";
import { writeHonchoConfig } from "./helpers";

const honchoDir = SHARED_HONCHO_DIR;

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
  if (originalHonchoApiKey !== undefined) process.env.HONCHO_API_KEY = originalHonchoApiKey;
  if (originalHonchoPeerName !== undefined) process.env.HONCHO_PEER_NAME = originalHonchoPeerName;
  if (originalHonchoWorkspace !== undefined) process.env.HONCHO_WORKSPACE = originalHonchoWorkspace;
  if (originalHonchoHost !== undefined) process.env.HONCHO_HOST = originalHonchoHost;
  if (originalHonchoEnabled !== undefined) process.env.HONCHO_ENABLED = originalHonchoEnabled;
  if (originalCursorProjectDir !== undefined) process.env.CURSOR_PROJECT_DIR = originalCursorProjectDir;
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
