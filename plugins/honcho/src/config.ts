import { homedir } from "os";
import { join, basename } from "path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from "fs";
import { createHash } from "crypto";
import { captureGitState } from "./git.js";
import { getInstanceIdForCwd, getClaudeInstanceId } from "./cache.js";

function sanitizeForSessionName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}

export interface MessageUploadConfig {
  /** Truncate user messages to this many tokens (undefined = no limit) */
  maxUserTokens?: number;
  /** Truncate assistant messages to this many tokens (undefined = no limit) */
  maxAssistantTokens?: number;
  /** Summarize assistant messages instead of sending full text (default: false) */
  summarizeAssistant?: boolean;
}

export interface ContextRefreshConfig {
  /** Refresh context every N messages (default: 30) */
  messageThreshold?: number;
  /** Cache TTL in seconds (default: 300) */
  ttlSeconds?: number;
  /** Skip dialectic chat() calls in user-prompt hook (default: false) */
  skipDialectic?: boolean;
}

export interface LocalContextConfig {
  /** Max entries in claude-context.md (default: 50) */
  maxEntries?: number;
}

export type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "max";

export type SessionStrategy = "per-directory" | "git-branch" | "chat-instance";

export type StatuslineMode = "on" | "off";

export type HonchoEnvironment = "production" | "local";

export interface HonchoEndpointConfig {
  /** "production" (SaaS) or "local" (localhost:8000) */
  environment?: HonchoEnvironment;
  /** Custom URL override (takes precedence over environment) */
  baseUrl?: string;
}

const HONCHO_BASE_URLS = {
  production: "https://api.honcho.dev/v3",
  local: "http://localhost:8000/v3",
} as const;

// ============================================
// Host Detection
// ============================================

export type HonchoHost = "cursor" | "claude_code" | "obsidian";

export type ObservationMode = "unified" | "directional" | "hybrid";

export interface HostConfig {
  /** Honcho workspace name for this host */
  workspace?: string;
  /** AI peer name for this host (e.g. "claude", "cursor") */
  aiPeer?: string;
  /**
   * Honcho API key scoped to this host. Takes precedence over the root
   * `apiKey` field, but is still overridden by the HONCHO_API_KEY env var.
   * Useful when different hosts (claude_code, cursor, opencode) authenticate
   * against different Honcho orgs or workspaces.
   */
  apiKey?: string;

  /** Per-host overrides for settings that may differ across tools */
  enabled?: boolean;
  logging?: boolean;
  saveMessages?: boolean;
  sessionStrategy?: SessionStrategy;
  sessionPeerPrefix?: boolean;
  /** Default reasoning level for Honcho dialectic calls (default: "medium") */
  reasoningLevel?: ReasoningLevel;
  /**
   * Observation mode (default: "unified").
   * "unified": all agents write to user's self-observation collection (observer=user, observed=user).
   * "directional": this AI keeps its own view of the user (observer=aiPeer, observed=user).
   * "hybrid": writes go directional (aiPeer keeps its lens) but reads/conclusions use the
   *           self-spine (observer=user, observed=user) — coherent shared reads with preserved
   *           per-agent storage for cross-perspective queries.
   */
  observationMode?: ObservationMode;
  messageUpload?: MessageUploadConfig;
  contextRefresh?: ContextRefreshConfig;
  localContext?: LocalContextConfig;
  endpoint?: HonchoEndpointConfig;
}

/** A host block as it exists on disk: declared fields plus any user-added
 *  keys the plugin doesn't parse (e.g. a documented `linkedHosts`). */
type HostConfigOnDisk = HostConfig & Record<string, unknown>;

const HOST_CONFIG_KEYS = [
  "workspace",
  "aiPeer",
  "apiKey",
  "enabled",
  "logging",
  "saveMessages",
  "sessionStrategy",
  "sessionPeerPrefix",
  "reasoningLevel",
  "observationMode",
  "messageUpload",
  "contextRefresh",
  "localContext",
  "endpoint",
] as const satisfies readonly (keyof HostConfig)[];

const KNOWN_HOST_KEYS: ReadonlySet<string> = new Set(HOST_CONFIG_KEYS);

let _detectedHost: HonchoHost | null = null;

export function setDetectedHost(host: HonchoHost): void {
  _detectedHost = host;
}

export function getDetectedHost(): HonchoHost {
  return _detectedHost ?? "claude_code";
}

export function detectHost(stdinInput?: Record<string, unknown>): HonchoHost {
  // Explicit env var override (used by install scripts and external tooling)
  const envHost = process.env.HONCHO_HOST;
  if (envHost === "cursor" || envHost === "claude_code" || envHost === "obsidian") return envHost;

  if (stdinInput?.cursor_version) return "cursor";
  // Cursor sets CURSOR_PROJECT_DIR for child processes (incl. Claude Code inside Cursor)
  if (process.env.CURSOR_PROJECT_DIR) return "cursor";
  return "claude_code";
}

const DEFAULT_WORKSPACE: Record<HonchoHost, string> = {
  "cursor": "cursor",
  "claude_code": "claude_code",
  "obsidian": "obsidian",
};

const DEFAULT_AI_PEER: Record<HonchoHost, string> = {
  "cursor": "cursor",
  "claude_code": "claude",
  "obsidian": "honcho",
};

export function getDefaultWorkspace(host?: HonchoHost): string {
  return DEFAULT_WORKSPACE[host ?? getDetectedHost()];
}

export function getDefaultAiPeer(host?: HonchoHost): string {
  return DEFAULT_AI_PEER[host ?? getDetectedHost()];
}

/**
 * Return the canonical host key plus legacy hyphen/underscore aliases in
 * resolve precedence order.
 */
function getHostConfigKeys(host: HonchoHost): string[] {
  return Array.from(new Set([
    host,
    host.replace(/_/g, "-"),
    host.replace(/-/g, "_"),
  ]));
}

/**
 * Resolve a host block using the same alias fallback rules for read and write
 * paths.
 */
function getHostBlock(
  hosts: Record<string, HostConfigOnDisk> | undefined,
  host: HonchoHost
): HostConfigOnDisk | undefined {
  if (!hosts) return undefined;
  for (const hostKey of getHostConfigKeys(host)) {
    const hostBlock = hosts[hostKey];
    if (hostBlock != null) return hostBlock;
  }
  return undefined;
}

/**
 * Preserve user-defined on-disk host fields that the plugin does not parse.
 */
function copyUnknownHostFields(
  target: HostConfigOnDisk,
  source: HostConfigOnDisk | undefined
): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (!KNOWN_HOST_KEYS.has(key)) {
      target[key] = value;
    }
  }
}

/**
 * Assign a declared host field without hiding the surrounding on-disk shape.
 */
function setKnownHostField<K extends keyof HostConfig>(
  target: HostConfig,
  key: K,
  value: HostConfig[K]
): void {
  target[key] = value;
}

// Stdin cache: entry points read stdin once via initHook(),
// handlers consume from cache via getCachedStdin().
let _stdinText: string | null = null;

export function cacheStdin(text: string): void {
  _stdinText = text;
}

export function getCachedStdin(): string | null {
  return _stdinText;
}

/**
 * Shared hook entry point initialization.
 * Reads stdin once, caches it, detects host, and exits early for unsupported hosts.
 * Must be called at the top of every hook entry point before the handler.
 */
export async function initHook(): Promise<void> {
  const stdinText = await Bun.stdin.text();
  cacheStdin(stdinText);
  let input: Record<string, unknown> = {};
  try { input = JSON.parse(stdinText || "{}"); } catch { process.exit(0); }
  if (input.cursor_version) process.exit(0);
  setDetectedHost(detectHost(input));
}

// ============================================
// Config Types
// ============================================

/** Per-directory workspace override entry */
export interface DirectoryWorkspaceConfig {
  /** Honcho workspace name for this directory */
  workspace: string;
  /** API key for this workspace (if different from global) */
  apiKey?: string;
  /** AI peer name for this directory (if different from host default) */
  aiPeer?: string;
  /** Endpoint override for this directory */
  endpoint?: HonchoEndpointConfig;
}

/**
 * A cwd-prefix workspace routing rule. Where `directoryWorkspaces` pins one
 * exact directory, a rule routes a whole subtree: any directory at or under
 * `cwdPrefix` uses `workspace`. Lets you set up "~/code/work → work" once and
 * have every repo under it isolate automatically — no per-directory entry.
 */
export interface WorkspaceRule {
  /** Directory prefix that triggers this rule. Leading `~` expands to $HOME.
   *  Matched path-segment-aware (a prefix of the path, not a substring), so
   *  "~/code/work" matches "~/code/work" and "~/code/work/x" but NOT
   *  "~/code/work-old". */
  cwdPrefix: string;
  /** Workspace to use when this rule matches. */
  workspace: string;
  /** AI peer override for this subtree (parity with DirectoryWorkspaceConfig). */
  aiPeer?: string;
}

/** Raw shape of ~/.honcho/config.json on disk */
interface HonchoFileConfig {
  apiKey?: string;
  peerName?: string;
  workspace?: string;
  aiPeer?: string;
  sessions?: Record<string, string>;
  /**
   * Per-directory workspace overrides.
   * Key: absolute directory path (matching workspace_roots[0] or cwd from hook input).
   * Value: workspace + optional apiKey/aiPeer/endpoint overrides.
   * Takes precedence over hosts.<host>.workspace for the matching directory.
   *
   * Example:
   *   "directoryWorkspaces": {
   *     "/Users/you/project-alpha": { "workspace": "project_alpha", "apiKey": "<alpha-jwt>" },
   *     "/Users/you/project-beta":  { "workspace": "project_beta",  "apiKey": "<beta-jwt>" }
   *   }
   */
  directoryWorkspaces?: Record<string, DirectoryWorkspaceConfig>;
  /**
   * cwd-prefix workspace routing rules. Each rule maps a directory prefix to a
   * workspace, so one rule covers a whole subtree. Checked when no exact
   * `directoryWorkspaces` entry matches; the longest matching prefix wins.
   *
   * Example:
   *   "workspaceRules": [
   *     { "cwdPrefix": "~/code/work",     "workspace": "work" },
   *     { "cwdPrefix": "~/code/personal", "workspace": "personal" }
   *   ]
   */
  workspaceRules?: WorkspaceRule[];
  /**
   * When true, SessionStart auto-creates a `directoryWorkspaces` entry for any
   * uncovered directory (deriving the workspace name from the dir). When
   * false/absent, an uncovered directory is nudged every session until the
   * user decides.
   */
  autoIsolate?: boolean;
  /**
   * Directories the user explicitly chose to keep pooled in the global
   * workspace. A terminal decision — set only by a user gesture (the
   * keep-pooled MCP action), never by SessionStart — that silences the nudge
   * for that directory. Distinct from "we showed the nudge": ignoring the
   * nudge does NOT land a directory here, so the nudge keeps reappearing until
   * the user actually decides.
   */
  keepPooled?: string[];
  saveMessages?: boolean;
  messageUpload?: MessageUploadConfig;
  contextRefresh?: ContextRefreshConfig;
  endpoint?: HonchoEndpointConfig;
  localContext?: LocalContextConfig;
  enabled?: boolean;
  logging?: boolean;
  sessionStrategy?: SessionStrategy;
  /** Prefix session names with peerName (default: true, disable for solo use) */
  sessionPeerPrefix?: boolean;
  /** Default reasoning level for Honcho dialectic calls (default: "medium") */
  reasoningLevel?: ReasoningLevel;
  /** Observation mode (default: "unified") */
  observationMode?: ObservationMode;
  /** Memory statusLine visibility: "on" (default) · "off" */
  statusline?: StatuslineMode;
  hosts?: Record<string, HostConfigOnDisk>;
  /** When true, flat workspace/aiPeer fields apply to ALL hosts,
   *  ignoring host-specific blocks. When false (default), each host
   *  uses its own block and flat fields are fallbacks only. */
  globalOverride?: boolean;
  // Legacy flat fields (read-only fallbacks when no hosts block)
  cursorPeer?: string;
  claudePeer?: string;
}

/** Resolved runtime config consumed by all other code.
 *  Host-specific fields (workspace, aiPeer) are resolved from the hosts block
 *  or legacy flat fields in HonchoFileConfig. */
export interface HonchoCLAUDEConfig {
  /** The user's peer name */
  peerName: string;
  /** Honcho API key */
  apiKey: string;
  /** Honcho workspace name (resolved per-host) */
  workspace: string;
  /** AI peer name (resolved per-host, e.g. "claude" for claude-code) */
  aiPeer: string;

  /** How sessions are named: per-directory, git-branch, or chat-instance */
  sessionStrategy?: SessionStrategy;
  /** Prefix session names with peerName (default: true, disable for solo use) */
  sessionPeerPrefix?: boolean;
  /** Map of directory path -> session name overrides */
  sessions?: Record<string, string>;
  /** Save messages to Honcho (default: true) */
  saveMessages?: boolean;
  /** Default reasoning level for Honcho dialectic calls (default: "medium") */
  reasoningLevel?: ReasoningLevel;
  /**
   * Observation mode (default: "unified").
   * "unified": all agents write to user's self-observation collection.
   * "directional": this AI keeps its own per-AI view of the user.
   */
  observationMode?: ObservationMode;
  /** Memory statusLine visibility: "on" (default) · "off" */
  statusline?: StatuslineMode;
  /** Token-based upload limits */
  messageUpload?: MessageUploadConfig;
  /** Context retrieval settings */
  contextRefresh?: ContextRefreshConfig;
  /** SaaS vs local instance config */
  endpoint?: HonchoEndpointConfig;
  /** Local claude-context.md settings */
  localContext?: LocalContextConfig;
  /** Temporarily disable plugin (default: true) */
  enabled?: boolean;
  /** Enable file logging to ~/.honcho/ (default: true) */
  logging?: boolean;
  /** When true, flat workspace/aiPeer fields apply to ALL hosts */
  globalOverride?: boolean;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
  for (const key of keys) {
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

const CONFIG_DIR = join(homedir(), ".honcho");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const CONFIG_LOCK = join(CONFIG_DIR, "config.json.lock");

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

/**
 * Load config from file, with environment variable fallbacks.
 * Host-specific fields are resolved from the hosts block in the config file.
 */
export function loadConfig(host?: HonchoHost): HonchoCLAUDEConfig | null {
  const resolvedHost = host ?? getDetectedHost();

  if (configExists()) {
    try {
      const content = readFileSync(CONFIG_FILE, "utf-8");
      const raw = JSON.parse(content) as HonchoFileConfig;
      return resolveConfig(raw, resolvedHost);
    } catch {
      // Fall through to env-only config
    }
  }
  return loadConfigFromEnv(resolvedHost);
}

function resolveConfig(raw: HonchoFileConfig, host: HonchoHost): HonchoCLAUDEConfig | null {
  const hostBlock = getHostBlock(raw.hosts, host);

  // Resolution order: env var > host-scoped apiKey > root apiKey.
  const apiKey = process.env.HONCHO_API_KEY || hostBlock?.apiKey || raw.apiKey;
  if (!apiKey) return null;

  const peerName = raw.peerName || process.env.HONCHO_PEER_NAME || process.env.USER || process.env.USERNAME || "user";

  // Resolve host-specific fields
  let workspace: string;
  let aiPeer: string;

  if (raw.globalOverride === true) {
    // Global override: flat fields apply to ALL hosts
    workspace = raw.workspace ?? DEFAULT_WORKSPACE[host];
    aiPeer = raw.aiPeer ?? hostBlock?.aiPeer ?? DEFAULT_AI_PEER[host];
  } else if (hostBlock) {
    // Host-specific block takes precedence
    workspace = hostBlock.workspace ?? DEFAULT_WORKSPACE[host];
    aiPeer = hostBlock.aiPeer ?? DEFAULT_AI_PEER[host];
  } else {
    // Legacy flat-field fallback for configs written before hosts block.
    // Env var is respected here (matching main-branch behavior) so it gets
    // captured into the hosts block on first saveConfig(), after which the
    // env var becomes redundant and is safely ignored.
    workspace = process.env.HONCHO_WORKSPACE ?? raw.workspace ?? DEFAULT_WORKSPACE[host];
    if (host === "cursor") {
      aiPeer = raw.cursorPeer ?? DEFAULT_AI_PEER["cursor"];
    } else {
      aiPeer = raw.claudePeer ?? DEFAULT_AI_PEER["claude_code"];
    }
  }

  // Per-host settings: check hosts.<name>.X first, fall back to root X.
  // This lets the user set global defaults at root (via CLI) while
  // individual integrations can override per-host without touching root.
  const config: HonchoCLAUDEConfig = {
    apiKey,
    peerName,
    workspace,
    aiPeer,
    sessionStrategy: hostBlock?.sessionStrategy ?? raw.sessionStrategy,
    sessionPeerPrefix: hostBlock?.sessionPeerPrefix ?? raw.sessionPeerPrefix,
    sessions: raw.sessions,
    saveMessages: hostBlock?.saveMessages ?? raw.saveMessages,
    reasoningLevel: hostBlock?.reasoningLevel ?? raw.reasoningLevel,
    observationMode: hostBlock?.observationMode ?? raw.observationMode,
    messageUpload: hostBlock?.messageUpload ?? raw.messageUpload,
    contextRefresh: hostBlock?.contextRefresh ?? raw.contextRefresh,
    endpoint: hostBlock?.endpoint ?? raw.endpoint,
    localContext: hostBlock?.localContext ?? raw.localContext,
    enabled: hostBlock?.enabled ?? raw.enabled,
    logging: hostBlock?.logging ?? raw.logging,
    globalOverride: raw.globalOverride,
  };

  return mergeWithEnvVars(config);
}

/**
 * Load config purely from environment variables.
 * Returns null if HONCHO_API_KEY is not set.
 * HONCHO_WORKSPACE is respected here (no file config to conflict with).
 */
export function loadConfigFromEnv(host?: HonchoHost): HonchoCLAUDEConfig | null {
  const apiKey = process.env.HONCHO_API_KEY;
  if (!apiKey) {
    return null;
  }

  const resolvedHost = host ?? getDetectedHost();
  const peerName = process.env.HONCHO_PEER_NAME || process.env.USER || process.env.USERNAME || "user";
  const workspace = process.env.HONCHO_WORKSPACE || DEFAULT_WORKSPACE[resolvedHost];
  const hostPeerEnv = resolvedHost === "cursor"
    ? process.env.HONCHO_CURSOR_PEER
    : process.env.HONCHO_CLAUDE_PEER;
  const aiPeer = process.env.HONCHO_AI_PEER || hostPeerEnv || DEFAULT_AI_PEER[resolvedHost];
  const endpoint = process.env.HONCHO_ENDPOINT;

  const config: HonchoCLAUDEConfig = {
    apiKey,
    peerName,
    workspace,
    aiPeer,
    saveMessages: process.env.HONCHO_SAVE_MESSAGES !== "false",
    enabled: process.env.HONCHO_ENABLED !== "false",
    logging: process.env.HONCHO_LOGGING !== "false",
  };

  if (endpoint) {
    if (endpoint === "local") {
      config.endpoint = { environment: "local" };
    } else if (endpoint.startsWith("http")) {
      config.endpoint = { baseUrl: endpoint };
    }
  }

  return config;
}

/**
 * Merge file-based config with environment variable overrides.
 * Only merges global (non-host-specific) env vars. workspace and aiPeer
 * are host-specific fields already resolved by resolveConfig() from the
 * hosts block -- generic env vars like HONCHO_WORKSPACE must not override
 * them here, otherwise a value set for one host clobbers the other.
 * (HONCHO_WORKSPACE IS respected in loadConfigFromEnv when no file exists.)
 */
function mergeWithEnvVars(config: HonchoCLAUDEConfig): HonchoCLAUDEConfig {
  if (process.env.HONCHO_API_KEY) {
    config.apiKey = process.env.HONCHO_API_KEY;
  }
  if (process.env.HONCHO_PEER_NAME) {
    config.peerName = process.env.HONCHO_PEER_NAME;
  }
  if (process.env.HONCHO_ENABLED === "false") {
    config.enabled = false;
  }
  if (process.env.HONCHO_LOGGING === "false") {
    config.logging = false;
  }
  return config;
}

/**
 * Write-back: read-merge-write to avoid clobbering other hosts' config.
 *
 * Convention:
 *   - Root-level keys (apiKey, peerName, enabled, etc.) are owned by
 *     the user or the honcho CLI.  This integration NEVER writes them.
 *   - hosts.<this-host> is owned by this integration and carries all
 *     per-host settings (workspace, aiPeer, enabled, logging, ...).
 *   - sessions is shared across hosts -- written at root.
 *
 * resolveConfig() reads host block first, falls back to root, so the
 * user's root-level defaults still apply until overridden per-host.
 *
 * The read-merge-write runs under withConfigLock so a concurrent hook or
 * MCP write to config.json can't clobber this host block (and vice versa),
 * the same guarantee updateRawConfigFile relies on.
 */
export function saveConfig(config: HonchoCLAUDEConfig): void {
  withConfigLock(() => {
    // Re-read from disk to avoid clobbering other tools' changes
    let existing: HonchoFileConfig = {};
    if (existsSync(CONFIG_FILE)) {
      try {
        existing = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      } catch {
        // Start fresh if corrupt
      }
    }

    // Sessions are shared across hosts -- write at root
    if (config.sessions !== undefined) {
      existing.sessions = config.sessions;
    }

    // Everything else goes in the host block.
    // Keep workspace/aiPeer host-local, but avoid materializing root defaults
    // into new host overrides. This preserves root fallback behavior.
    const host = getDetectedHost();
    if (!existing.hosts) existing.hosts = {};
    const hosts = existing.hosts;
    const existingHost: HostConfigOnDisk = getHostBlock(hosts, host) ?? {};

    // Seed with unknown fields from host aliases so the write below doesn't
    // strip user-added config the plugin doesn't parse (e.g. `linkedHosts`).
    // Alias entries are copied first so canonical host fields win conflicts.
    const hostEntry: HostConfigOnDisk = {};
    for (const hostKey of [...getHostConfigKeys(host)].reverse()) {
      copyUnknownHostFields(hostEntry, hosts[hostKey]);
    }

    const setHostIfExplicit = <K extends keyof HostConfig>(
      key: K,
      value: HostConfig[K],
      rootValue: unknown
    ) => {
      if (value === undefined) return;
      const hasHostOverride = Object.hasOwn(existingHost, key);
      if (hasHostOverride || !deepEqual(value, rootValue)) {
        setKnownHostField(hostEntry, key, value);
      }
    };

    // Only persist workspace/aiPeer to host block if the block already had them
    // or if they differ from the default for this host.  This prevents root
    // fallback values from being materialized into host overrides.
    setHostIfExplicit("workspace", config.workspace, existing.workspace ?? DEFAULT_WORKSPACE[host]);
    setHostIfExplicit("aiPeer", config.aiPeer, existing.aiPeer ?? DEFAULT_AI_PEER[host]);

    // Don't persist env-only overrides to the host block.
    // mergeWithEnvVars() may have set enabled=false or logging=false from
    // HONCHO_ENABLED / HONCHO_LOGGING env vars — those are runtime overrides
    // that should not be materialized to disk.
    const enabledForSave = process.env.HONCHO_ENABLED === "false" && config.enabled === false
      ? existingHost.enabled  // preserve what was on disk
      : config.enabled;
    const loggingForSave = process.env.HONCHO_LOGGING === "false" && config.logging === false
      ? existingHost.logging
      : config.logging;

    setHostIfExplicit("enabled", enabledForSave, existing.enabled);
    setHostIfExplicit("logging", loggingForSave, existing.logging);
    setHostIfExplicit("saveMessages", config.saveMessages, existing.saveMessages);
    setHostIfExplicit("sessionStrategy", config.sessionStrategy, existing.sessionStrategy);
    setHostIfExplicit("sessionPeerPrefix", config.sessionPeerPrefix, existing.sessionPeerPrefix);
    setHostIfExplicit("reasoningLevel", config.reasoningLevel, existing.reasoningLevel);
    setHostIfExplicit("observationMode", config.observationMode, existing.observationMode);
    setHostIfExplicit("messageUpload", config.messageUpload, existing.messageUpload);
    setHostIfExplicit("contextRefresh", config.contextRefresh, existing.contextRefresh);
    setHostIfExplicit("localContext", config.localContext, existing.localContext);
    setHostIfExplicit("endpoint", config.endpoint, existing.endpoint);

    // Preserve a host-scoped apiKey already on disk. This integration never writes
    // apiKey (config.apiKey is the *resolved* key — env/root — and must not be
    // materialized here), but must not drop hosts.<host>.apiKey on rewrite.
    if (existingHost.apiKey !== undefined) {
      hostEntry.apiKey = existingHost.apiKey;
    }

    hosts[host] = hostEntry;

    writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2));
  });
}

/**
 * Write a single root-level field to config.json.
 * ONLY for explicit user-directed actions (MCP set_config) on fields
 * that are genuinely global (apiKey, peerName, globalOverride).
 * Hooks and routine operations must NEVER call this.
 */
export function saveRootField(field: string, value: unknown): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  let existing: Record<string, unknown> = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      existing = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    } catch {}
  }

  existing[field] = value;
  writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2));
}

export function getClaudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

export function getClaudeSettingsDir(): string {
  return join(homedir(), ".claude");
}

export function getSessionForPath(cwd: string): string | null {
  const config = loadConfig();
  if (!config?.sessions) return null;
  return config.sessions[cwd] || null;
}

/** Session name derived from strategy. Manual overrides only apply to per-directory.
 *  @param instanceId - Explicit instance ID for chat-instance strategy. Falls back to
 *                      per-cwd cache, then global cache. Callers should pass hookInput.session_id
 *                      when available to avoid cross-session collision from the global cache.
 */
export function getSessionName(cwd: string, instanceId?: string): string {
  const config = loadConfig();
  const strategy = config?.sessionStrategy ?? "per-directory";

  // Manual overrides only apply to per-directory strategy.
  // For chat-instance and git-branch, the session name is always derived dynamically.
  if (strategy === "per-directory") {
    const configuredSession = getSessionForPath(cwd);
    if (configuredSession) {
      return configuredSession;
    }
  }

  const usePrefix = config?.sessionPeerPrefix !== false; // default true
  const peerPart = config?.peerName ? sanitizeForSessionName(config.peerName) : "user";
  const repoPart = sanitizeForSessionName(basename(cwd));
  const base = usePrefix ? `${peerPart}-${repoPart}` : repoPart;

  switch (strategy) {
    case "git-branch": {
      const gitState = captureGitState(cwd);
      if (gitState) {
        const branchPart = sanitizeForSessionName(gitState.branch);
        return `${base}-${branchPart}`;
      }
      return base;
    }
    case "chat-instance": {
      // Prefer explicit instanceId > per-cwd cache > global cache (legacy)
      const resolved = instanceId || getInstanceIdForCwd(cwd) || getClaudeInstanceId();
      if (resolved) {
        return usePrefix ? `${peerPart}-chat-${resolved}` : `chat-${resolved}`;
      }
      return base;
    }
    default:
      return base;
  }
}

export function setSessionForPath(cwd: string, sessionName: string): void {
  const config = loadConfig();
  if (!config) return;
  if (!config.sessions) {
    config.sessions = {};
  }
  config.sessions[cwd] = sessionName;
  saveConfig(config);
}

export function getAllSessions(): Record<string, string> {
  const config = loadConfig();
  return config?.sessions || {};
}

export function removeSessionForPath(cwd: string): void {
  const config = loadConfig();
  if (!config?.sessions) return;
  delete config.sessions[cwd];
  saveConfig(config);
}

export function getMessageUploadConfig(): MessageUploadConfig {
  const config = loadConfig();
  return {
    maxUserTokens: config?.messageUpload?.maxUserTokens ?? undefined,
    maxAssistantTokens: config?.messageUpload?.maxAssistantTokens ?? undefined,
    summarizeAssistant: config?.messageUpload?.summarizeAssistant ?? false,
  };
}

export function getContextRefreshConfig(): ContextRefreshConfig {
  const config = loadConfig();
  return {
    messageThreshold: config?.contextRefresh?.messageThreshold ?? 30,
    ttlSeconds: config?.contextRefresh?.ttlSeconds ?? 300,
    skipDialectic: config?.contextRefresh?.skipDialectic ?? false,
  };
}

export function getLocalContextConfig(): LocalContextConfig {
  const config = loadConfig();
  return {
    maxEntries: config?.localContext?.maxEntries ?? 50,
  };
}

export function isLoggingEnabled(): boolean {
  const config = loadConfig();
  return config?.logging !== false;
}

export function isPluginEnabled(): boolean {
  const config = loadConfig();
  return config?.enabled !== false;
}

export function setPluginEnabled(enabled: boolean): void {
  const config = loadConfig();
  if (!config) return;
  config.enabled = enabled;
  saveConfig(config);
}



/**
 * Get all known host keys from the config file's hosts block.
 */
export function getKnownHosts(): string[] {
  const cfgPath = getConfigPath();
  if (!existsSync(cfgPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
    return raw.hosts ? Object.keys(raw.hosts) : [];
  } catch {
    return [];
  }
}

/** Simple token estimation (chars / 4) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Strictly coerce an MCP set_config `value` (untyped: string, number, boolean,
 * ...) to a boolean. Unlike `Boolean(value)`, the string "false" (and "0",
 * "no", "off", "") coerce to false instead of true -- `Boolean("false")` is
 * `true` because it's a non-empty string, which silently enables a flag the
 * caller meant to disable.
 */
export function parseConfigBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "false" || v === "0" || v === "no" || v === "off" || v === "") return false;
    if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  }
  return Boolean(value);
}

export function truncateToTokens(text: string, maxTokens: number): string {
  const estimatedChars = maxTokens * 4;
  if (text.length <= estimatedChars) {
    return text;
  }
  return text.slice(0, estimatedChars - 3) + "...";
}

export interface HonchoClientOptions {
  apiKey: string;
  baseURL: string;
  workspaceId: string;
  timeout?: number;
  maxRetries?: number;
}

/** Get the base URL for Honcho API. Priority: baseUrl > environment > production */
export function getHonchoBaseUrlForEndpoint(endpoint?: HonchoEndpointConfig): string {
  if (endpoint?.baseUrl) {
    const url = endpoint.baseUrl;
    return url.endsWith("/v3") ? url : `${url}/v3`;
  }
  if (endpoint?.environment === "local") {
    return HONCHO_BASE_URLS.local;
  }
  return HONCHO_BASE_URLS.production;
}

/** Get the base URL for a resolved runtime config. */
export function getHonchoBaseUrl(config: HonchoCLAUDEConfig): string {
  return getHonchoBaseUrlForEndpoint(config.endpoint);
}

/**
 * Stable, non-secret cache-scope id for a resolved config: distinguishes the
 * Honcho backend + account so two directories that share a workspace NAME but
 * point at different endpoints/accounts don't share a context-cache slot.
 */
export function resolveCacheScope(config: HonchoCLAUDEConfig): string {
  const url = getHonchoBaseUrl(config);
  const account = config.apiKey
    ? createHash("sha256").update(config.apiKey).digest("hex").slice(0, 12)
    : "noauth";
  return `${url}|${account}`;
}

// Default SDK request timeout. Overridable via HONCHO_SDK_TIMEOUT_MS: the
// deriver's dialectic queries at high/max reasoning levels can exceed 8s, so
// users on those levels need to raise it (issue #25).
const DEFAULT_SDK_TIMEOUT_MS = 8000;

export function getHonchoClientOptions(config: HonchoCLAUDEConfig): HonchoClientOptions {
  return {
    apiKey: config.apiKey,
    baseURL: getHonchoBaseUrl(config),
    workspaceId: config.workspace,
    timeout: Number(process.env.HONCHO_SDK_TIMEOUT_MS) || DEFAULT_SDK_TIMEOUT_MS,
    maxRetries: 1,
  };
}

export function getEndpointInfo(config: HonchoCLAUDEConfig): { type: string; url: string } {
  if (config.endpoint?.baseUrl) {
    return { type: "custom", url: config.endpoint.baseUrl };
  }
  if (config.endpoint?.environment === "local") {
    return { type: "local", url: HONCHO_BASE_URLS.local };
  }
  return { type: "production", url: HONCHO_BASE_URLS.production };
}

const VALID_ENVIRONMENTS = new Set<HonchoEnvironment>(["production", "local"]);

/** Returns the resolved observation mode, defaulting to "unified". */
export function getObservationMode(config: HonchoCLAUDEConfig): ObservationMode {
  return config.observationMode ?? "unified";
}

/** True when reads should pull from the user's self-spine (unified semantics). */
export function readsAsUnified(mode: ObservationMode): boolean {
  return mode === "unified" || mode === "hybrid";
}

/** True when writes/observations should accumulate per-agent (directional semantics). */
export function writesAsDirectional(mode: ObservationMode): boolean {
  return mode === "directional" || mode === "hybrid";
}

export function setEndpoint(environment?: HonchoEnvironment, baseUrl?: string): void {
  const config = loadConfig();
  if (!config) return;
  if (environment && !VALID_ENVIRONMENTS.has(environment)) return;
  config.endpoint = { environment, baseUrl };
  saveConfig(config);
}

/** Expand a leading `~` / `~/…` to the home directory. */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Normalize a directory path for prefix comparison: backslashes → slashes,
 *  strip trailing slashes. */
function normalizeDirPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Resolve a cwd against prefix routing rules. Returns the matching rule, or
 * null when none match. Path-segment-aware (a rule for "~/code/work" matches
 * that dir and its subtree but not the sibling "~/code/work-old"). Among
 * several matches the longest prefix wins; ties resolve to array order.
 */
export function resolveWorkspaceRule(cwd: string, rules?: WorkspaceRule[]): WorkspaceRule | null {
  if (!cwd || !rules || rules.length === 0) return null;
  const dir = normalizeDirPath(cwd);
  let best: WorkspaceRule | null = null;
  let bestLen = -1;
  for (const rule of rules) {
    const prefix = normalizeDirPath(expandHome(rule.cwdPrefix));
    if (!prefix) continue; // an empty prefix would match every absolute path
    if (dir === prefix || dir.startsWith(prefix + "/")) {
      if (prefix.length > bestLen) {
        best = rule;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

/**
 * The effective per-directory override for `cwd`, resolved most-specific first:
 * an exact `directoryWorkspaces[cwd]` entry wins, else the longest matching
 * `workspaceRules` prefix, else null (the directory is still pooling into the
 * global workspace). Shared by applyDirectoryOverride and isIsolationCandidate
 * so "covered" means the same thing to both.
 */
function resolveDirectoryOverride(
  raw: HonchoFileConfig,
  cwd: string,
): { workspace: string; apiKey?: string; aiPeer?: string; endpoint?: HonchoEndpointConfig } | null {
  if (!cwd) return null;
  const exact = raw.directoryWorkspaces?.[normalizeDirPath(cwd)];
  if (exact) return exact;
  const rule = resolveWorkspaceRule(cwd, raw.workspaceRules);
  if (rule) return { workspace: rule.workspace, aiPeer: rule.aiPeer };
  return null;
}

/**
 * Apply a per-directory workspace override to a resolved config.
 * Resolves the directory via resolveDirectoryOverride (exact
 * `directoryWorkspaces[cwd]` first, else a matching `workspaceRules` prefix)
 * and patches workspace, apiKey, aiPeer, and endpoint when one applies.
 * Returns a new object when an override applies; returns the exact same
 * `config` reference (no clone) when none does, so callers can cheaply detect
 * the no-op case with `===`. Safe on a missing/corrupt config file.
 */
export function applyDirectoryOverride(config: HonchoCLAUDEConfig, cwd: string): HonchoCLAUDEConfig {
  if (!cwd || !configExists()) return config;
  const raw = readRawConfigFile();
  if (!raw) return config;
  const override = resolveDirectoryOverride(raw, cwd);
  if (!override) return config;
  return {
    ...config,
    workspace: override.workspace,
    apiKey: override.apiKey ?? config.apiKey,
    aiPeer: override.aiPeer ?? config.aiPeer,
    endpoint: override.endpoint ?? config.endpoint,
  };
}

// ============================================
// Directory isolation (nudge + autoIsolate)
// ============================================

/** Read the raw config file, or null if missing/corrupt. */
function readRawConfigFile(): HonchoFileConfig | null {
  if (!configExists()) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as HonchoFileConfig;
  } catch {
    return null;
  }
}

/**
 * Serialize read-modify-write of config.json across processes. Session-start
 * hooks run in separate processes, so two concurrent auto-isolations (or an MCP
 * keep_pooled update racing a hook) would otherwise read the same file and the
 * second write would silently drop the first's directoryWorkspaces entry.
 * Best-effort: a crashed holder's stale lock is broken after STALE_MS, and if
 * the lock can't be taken within TIMEOUT_MS we proceed unlocked rather than
 * hang a short-lived hook. Mirrors withContextCacheLock in cache.ts.
 */
function withConfigLock<T>(fn: () => T): T {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const STALE_MS = 5000;
  const TIMEOUT_MS = 3000;
  const start = Date.now();
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(CONFIG_LOCK, "wx");
      break;
    } catch {
      // Couldn't take the lock. If a stale holder left it behind, break it;
      // any other failure (lock vanished, or EACCES/EROFS/EMFILE) falls through
      // to the timeout guard below so we can never spin forever.
      try {
        if (Date.now() - statSync(CONFIG_LOCK).mtimeMs > STALE_MS) {
          unlinkSync(CONFIG_LOCK);
        }
      } catch {
        // fall through to the timeout guard
      }
      if (Date.now() - start > TIMEOUT_MS) return fn(); // give up; best-effort unlocked
      Bun.sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(CONFIG_LOCK);
    } catch {
      /* already gone */
    }
  }
}

/** Read-merge-write a mutation into config.json, preserving all other keys. */
function updateRawConfigFile(mutate: (raw: HonchoFileConfig) => void): void {
  withConfigLock(() => {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    let existing: HonchoFileConfig = {};
    if (existsSync(CONFIG_FILE)) {
      try {
        existing = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      } catch {
        // Start fresh if corrupt
      }
    }
    mutate(existing);
    writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2));
  });
}

/**
 * Derive a workspace name from a directory path (its final segment).
 * Returns "" when no meaningful segment exists (root or empty), so callers
 * can skip directories they can't name.
 *
 * When `taken` is provided, disambiguates a colliding basename (e.g. two
 * uncovered dirs named "app") by prepending parent segments one at a time
 * until the name isn't in `taken`. Without `taken`, behavior is unchanged:
 * the bare basename.
 */
export function deriveWorkspaceName(cwd: string, taken?: Set<string>): string {
  if (!cwd) return "";
  const segments = cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
  if (segments.length === 0) return "";
  let i = segments.length - 1;
  let name = segments[i];
  while (taken?.has(name) && i > 0) {
    i--;
    name = segments[i] + "-" + name;
  }
  return name;
}

/** True when `autoIsolate` is explicitly enabled in config.json. */
export function isAutoIsolateEnabled(): boolean {
  return readRawConfigFile()?.autoIsolate === true;
}

/**
 * True when `cwd` is not covered by any override — neither an exact
 * `directoryWorkspaces` entry nor a matching `workspaceRules` prefix — i.e. it
 * is still pooling into the global workspace. A directory a prefix rule already
 * routes is NOT a candidate, so the nudge never fires for it.
 */
export function isIsolationCandidate(cwd: string): boolean {
  if (!cwd) return false;
  const raw = readRawConfigFile();
  if (!raw) return false;
  return resolveDirectoryOverride(raw, cwd) === null;
}

/** True when the user explicitly chose to keep `cwd` pooled (terminal decline). */
export function wasKeptPooled(cwd: string): boolean {
  if (!cwd) return false;
  return readRawConfigFile()?.keepPooled?.includes(normalizeDirPath(cwd)) ?? false;
}

export type IsolationAction = { action: "none" | "auto" | "nudge"; workspace: string };

/**
 * Decide what SessionStart should do for `cwd`:
 *  - "none"  → already covered (exact entry or prefix rule), unnamable, or the
 *             user explicitly kept it pooled
 *  - "auto"  → autoIsolate is on: write the entry silently (workspace = derived)
 *  - "nudge" → uncovered, autoIsolate off, not kept-pooled: nudge (every
 *             session until the user decides — there is no shown-once gate)
 *
 * An explicit keep-pooled decision is terminal: it is honored before
 * autoIsolate, so keep_pooled stays effective even with autoIsolate on.
 */
export function resolveIsolationAction(cwd: string): IsolationAction {
  if (!isIsolationCandidate(cwd)) return { action: "none", workspace: "" };
  const raw = readRawConfigFile();
  const taken = new Set(Object.values(raw?.directoryWorkspaces ?? {}).map((e) => e.workspace));
  const workspace = deriveWorkspaceName(cwd, taken);
  if (!workspace) return { action: "none", workspace: "" };
  if (wasKeptPooled(cwd)) return { action: "none", workspace: "" };
  if (isAutoIsolateEnabled()) return { action: "auto", workspace };
  return { action: "nudge", workspace };
}

/**
 * Write a `directoryWorkspaces[cwd] = { workspace }` entry, preserving all
 * existing entries and other config keys. No-op if cwd or workspace is empty.
 */
export function isolateDirectory(cwd: string, workspace: string): void {
  if (!cwd || !workspace) return;
  updateRawConfigFile((raw) => {
    if (!raw.directoryWorkspaces) raw.directoryWorkspaces = {};
    raw.directoryWorkspaces[normalizeDirPath(cwd)] = { workspace };
  });
}

/**
 * Record the user's explicit decision to keep `cwd` pooled in the global
 * workspace, which silences the isolation nudge for it. No-op if cwd empty.
 */
export function keepDirectoryPooled(cwd: string): void {
  if (!cwd) return;
  const normalized = normalizeDirPath(cwd);
  updateRawConfigFile((raw) => {
    if (!raw.keepPooled) raw.keepPooled = [];
    if (!raw.keepPooled.includes(normalized)) raw.keepPooled.push(normalized);
    // A prior isolateDirectory(cwd, ...) entry would otherwise keep routing
    // this exact dir to its isolated workspace (resolveDirectoryOverride
    // checks directoryWorkspaces first), making "now pooled" a lie.
    if (raw.directoryWorkspaces) delete raw.directoryWorkspaces[normalized];
  });
}
