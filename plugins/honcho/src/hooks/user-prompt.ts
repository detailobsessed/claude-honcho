import { Honcho } from "@honcho-ai/sdk";
import { loadConfig, getSessionName, getHonchoClientOptions, isPluginEnabled, getCachedStdin, getObservationMode, readsAsUnified, getEndpointInfo, applyDirectoryOverride, resolveCacheScope } from "../config.js";
import {
  getCachedUserContext,
  getStaleCachedUserContext,
  isContextCacheStale,
  setCachedUserContext,
  getMessageCount,
  incrementMessageCount,
  shouldRefreshKnowledgeGraph,
  markKnowledgeGraphRefreshed,
  getInstanceIdForCwd,
  chunkContent,
  getInjectedConclusions,
  addInjectedConclusions,
} from "../cache.js";
import { logHook, logApiCall, logCache, setLogContext } from "../log.js";
import { visContextLine, visSkipMessage, addSystemMessage, verboseApiResult, verboseList } from "../visual.js";
import { honchoSessionUrl } from "../styles.js";
import { enqueueOutbox } from "../outbox.js";

interface HookInput {
  prompt?: string;
  cwd?: string;
  session_id?: string;
  workspace_roots?: string[];
}

// A trivial acknowledgement ("yes", "ok", "thanks", ...) with nothing else of
// substance. Exported so callers can gate both context retrieval and message
// capture on the same definition.
export const TRIVIAL_ACK = /^(yes|no|ok|sure|thanks|y|n|yep|nope|yeah|nah|continue|go ahead|do it|proceed)$/i;

// Patterns to skip context injection
const SKIP_CONTEXT_PATTERNS = [
  TRIVIAL_ACK,
  /^\//, // slash commands
];

const FETCH_TIMEOUT_MS = 4000;
// Cap the prompt upload so a slow/unreachable host can't consume the hook's
// budget and starve the context fetch (FETCH_TIMEOUT_MS) the user waits on.
// Overridable via HONCHO_UPLOAD_TIMEOUT_MS for slow networks (and tests).
const UPLOAD_TIMEOUT_MS = 3000;

function uploadTimeoutMs(): number {
  return Number(process.env.HONCHO_UPLOAD_TIMEOUT_MS) || UPLOAD_TIMEOUT_MS;
}

/**
 * Extract meaningful topics from a prompt for semantic search.
 * Returns terms that are high-signal for conclusion matching.
 */
export function extractTopics(prompt: string): string[] {
  const topics: string[] = [];

  // File paths (high signal)
  const filePaths = prompt.match(/[\w\-/.]+\.(ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml|sql)/gi) || [];
  topics.push(...filePaths.slice(0, 5));

  // Quoted strings (explicit references)
  const quoted = prompt.match(/"([^"]+)"/g)?.map(q => q.slice(1, -1)) || [];
  topics.push(...quoted.slice(0, 3));

  // Technical terms
  const techTerms = prompt.match(/\b(react|vue|svelte|angular|elysia|express|fastapi|django|flask|postgres|redis|docker|kubernetes|bun|node|deno|typescript|python|rust|go|graphql|rest|api|auth|oauth|jwt|stripe|webhook|honcho|mcp|claude|cursor|sentry)\b/gi) || [];
  topics.push(...[...new Set(techTerms.map(t => t.toLowerCase()))].slice(0, 5));

  // Error patterns
  const errors = prompt.match(/error[:\s]+[\w\s]+|failed[:\s]+[\w\s]+|exception[:\s]+[\w\s]+/gi) || [];
  topics.push(...errors.slice(0, 2));

  // No keyword fallback: extracted word lists are English-only and produce
  // low-signal queries for other languages. Callers fall back to the raw
  // prompt, which embeds better for semantic search anyway.
  return [...new Set(topics)];
}

function shouldSkipContextRetrieval(prompt: string): boolean {
  return SKIP_CONTEXT_PATTERNS.some((p) => p.test(prompt.trim()));
}

// Claude Code injects non-user turns into the UserPromptSubmit hook wrapped in
// these markers: background-task completions, `!`-bash command echoes and their
// output, slash-command invocations and their stdout, and system reminders.
// None are the user speaking, yet they were being uploaded as ordinary user
// messages — so Honcho's deriver minted plumbing "conclusions" ("received a
// task-notification with task-id ...", "used a tool with tool-use-id ...") that
// pollute the memory graph (upstream #66).
const HARNESS_TURN_TAGS = [
  "task-notification",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "system-reminder",
];
// Anchor on the OPENING tag at the very start of the (trimmed) prompt. A real
// user essentially never begins a message with one of these literal tags, and
// matching "starts-with" (not "contains") preserves genuine prompts that quote
// a tag mid-text or have a system-reminder appended after the user's words. The
// trailing [\s>] is a word boundary so `<command-name>` matches but a
// hypothetical `<command-names-of-things>` would not.
const HARNESS_TURN_PATTERN = new RegExp(`^<(${HARNESS_TURN_TAGS.join("|")})[\\s>]`);

export function isHarnessTurn(prompt: string): boolean {
  return HARNESS_TURN_PATTERN.test(prompt.trim());
}

function formatSessionLink(sessionUrl: string): string {
  return `view your session in honcho GUI: ${sessionUrl}`;
}

/**
 * Line-leading labels that mark output the user pasted rather than their own
 * speech. Anchored at line start (`^`, up to 3 leading spaces) so an inline
 * mention in genuine prose ("...I hit an error: it crashed") never matches —
 * only a line that BEGINS with the label, the way pasted output does. Kept
 * high-precision on purpose: review-bot names and unambiguous crash/trace
 * markers, not common words like a bare "error"/"warning" a user might open a
 * sentence with. The match runs through the end of the block (to the next blank
 * line or end-of-input) so a multi-line review comment or stack trace goes with
 * its opening line. Extend the alternation as new tools show up in the workflow.
 */
const PASTED_ATTRIBUTION_RE =
  /^[ \t]{0,3}(?:macroscope|copilot|coderabbit(?:ai)?|sourcery|greptile|traceback|stack ?trace|assertion ?error|exception in thread|unhandled exception|segmentation fault|panic|fatal error)\b.*(?:\r?\n(?![ \t]*(?:\r?\n|$)).*)*/gim;

/**
 * Redact pasted non-prose from a user prompt before it's uploaded as user
 * speech. Everything on a `role: "user"` message is read by the server-side
 * fact extractor as the user's own words, so pasted diffs/code/log-dumps become
 * durable misattributions ("<user> changed buildOperatorPlan" from a diff the
 * user asked to review). Redacts fenced code blocks (``` or ~~~, including
 * unterminated fences from truncated pastes), runs of 3+ consecutive diff
 * lines, long path-bearing output lines, markdown blockquote runs, and blocks
 * that open with a known machine-speaker label (review bots, stack traces,
 * crash markers) — the prose form of the same misattribution: a pasted
 * "macroscope: In file … around line 681" review comment was being minted as
 * "<user> identified an issue in config.ts around line 681". Short path
 * mentions, a lone "+"/"-" line in prose, and inline mentions like "I hit an
 * error: …" are preserved. Returns the possibly-redacted text and whether
 * anything was removed. Extends upstream plastic-labs/claude-honcho#34.
 */
export function stripPastes(text: string): { text: string; redacted: boolean } {
  let out = text;
  // 1. Markdown fenced code blocks. Handle both ``` and ~~~ fences, and close
  //    on a matching fence line OR end-of-input — a truncated paste often has
  //    no closing fence, and we still don't want its body stored as speech.
  //    The opening fence must start its own line (CommonMark allows up to 3
  //    leading spaces) so a stray inline ``` in prose can't swallow the rest of
  //    a genuine message.
  out = out.replace(
    /^[ \t]{0,3}(`{3,}|~{3,})[\s\S]*?(?:^[ \t]{0,3}\1.*$|$(?![\s\S]))/gm,
    "[code block removed]",
  );
  // 2. Runs of 3+ consecutive unified-diff lines. A single prefixed line in
  //    prose ("Note: + means added") stays; only a real diff block is redacted.
  out = out.replace(/(?:^[+-].*(?:\r?\n|$)){3,}/gm, "[diff removed]\n");
  // 3. Markdown blockquote runs. A `>`-prefixed line is by convention quoted
  //    material — someone/something else's words the user pasted, not their own.
  out = out.replace(/(?:^[ \t]{0,3}>.*(?:\r?\n|$))+/gm, "[quoted text removed]\n");
  // 4. Blocks that open with a known machine-speaker label at line start:
  //    review-bot comments (macroscope, copilot, …) and stack-trace/crash
  //    markers. Anchored to line start so inline prose ("...I hit an error: it
  //    crashed") is untouched — only a line that BEGINS with the label, the way
  //    pasted output does, is redacted, through to the next blank line or EOF.
  out = out.replace(PASTED_ATTRIBUTION_RE, "[tool output removed]");
  // 5. Lines >200 chars that carry a filesystem path — stack traces, log dumps,
  //    JSON blobs. Real prose lines are rarely that long; tool output often is.
  out = out
    .split("\n")
    .map((line) => (line.length > 200 && /[\w.-]*\/[\w.-]+/.test(line) ? "[path/output removed]" : line))
    .join("\n");
  return { text: out, redacted: out !== text };
}

/**
 * UserPromptSubmit hook — serves cached context instantly, refreshes when stale.
 *
 * Context lifecycle:
 *   SessionStart  -> warms cache (parallel API calls, 30s budget)
 *   UserPrompt    -> serves cache; refreshes (with 4s timeout) when TTL expires or message threshold hit
 *   PreCompact    -> re-warms cache before context window reset
 *
 * On refresh failure, silently falls back to stale cache.
 * On no cache at all, exits silently — context will arrive next turn.
 */
export async function handleUserPrompt(): Promise<void> {
  let config = loadConfig();
  if (!config) {
    process.exit(0);
  }

  if (!isPluginEnabled()) {
    process.exit(0);
  }

  let hookInput: HookInput = {};
  try {
    const input = getCachedStdin() ?? await Bun.stdin.text();
    if (input.trim()) {
      hookInput = JSON.parse(input);
    }
  } catch {
    process.exit(0);
  }

  const prompt = hookInput.prompt || "";
  const cwd = hookInput.workspace_roots?.[0] || hookInput.cwd || process.cwd();
  config = applyDirectoryOverride(config, cwd);
  const instanceId = hookInput.session_id || getInstanceIdForCwd(cwd);
  const sessionName = getSessionName(cwd, instanceId || undefined);

  setLogContext(cwd, sessionName);

  if (!prompt.trim()) {
    process.exit(0);
  }

  // Non-user turns injected by the Claude Code harness (task notifications,
  // bash-command echoes, slash-command output, system reminders) reach this
  // hook too. They are not the user speaking: don't capture them to memory and
  // don't spend a context fetch on them. See isHarnessTurn (upstream #66).
  if (isHarnessTurn(prompt)) {
    logHook("user-prompt", "Skipping harness-injected turn (not user input)");
    process.exit(0);
  }

  logHook("user-prompt", `Prompt received (${prompt.length} chars)`);

  const honcho = new Honcho(getHonchoClientOptions(config));

  // Best-effort upload. Wrap the entire SDK interaction so a transient
  // rejection during session/peer setup can't abort context retrieval below.
  // Trivial acks ("thanks", "ok", ...) are never stored as user speech --
  // they carry no signal and misattribute filler to the user. Everything
  // below this gate (message-count tracking, context retrieval) still runs.
  const isTrivialAck = TRIVIAL_ACK.test(prompt.trim());
  if (config.saveMessages !== false && isTrivialAck) {
    logHook("user-prompt", "Skipping capture of trivial acknowledgement");
  }
  if (config.saveMessages !== false && !isTrivialAck) {
    // Redact pasted code/diffs/log-dumps before upload so the fact extractor
    // can't attribute them to the user. Only the STORED copy is stripped —
    // context retrieval below still searches the full prompt.
    const { text: cleanPrompt, redacted } = stripPastes(prompt);
    const promptMetadata: Record<string, unknown> = {
      instance_id: instanceId || undefined,
      session_affinity: sessionName,
      ...(redacted ? { type: "user_paste_not_speech" } : {}),
    };
    const uploadPromise = (async () => {
      const [session, userPeer] = await Promise.all([
        honcho.session(sessionName),
        honcho.peer(config.peerName),
      ]);
      const messages = chunkContent(cleanPrompt).map((chunk) =>
        userPeer.message(chunk, { metadata: promptMetadata })
      );
      logApiCall("session.addMessages", "POST", `user prompt (${cleanPrompt.length} chars)`);
      await session.addMessages(messages);
    })();

    let uploadTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bound the wait so a slow host can't blow the hook budget. A timeout is
      // NOT a failure: the request is still in flight and may land server-side.
      // Queuing on timeout would replay a duplicate at the next SessionStart, so
      // we only fall through to the outbox on a hard rejection that beats the
      // timer — that means the send genuinely didn't happen.
      const outcome = await Promise.race([
        uploadPromise.then(() => "sent" as const),
        new Promise<"timeout">((resolve) => {
          uploadTimer = setTimeout(() => resolve("timeout"), uploadTimeoutMs());
        }),
      ]);
      if (outcome === "timeout") {
        logHook("user-prompt", "Upload still in flight — left running to avoid a duplicate");
        // The send may still reject later; swallow it so it can't surface as an
        // unhandled rejection now that the race has moved on.
        uploadPromise.catch(() => {});
      }
    } catch (e) {
      logHook("user-prompt", `Upload failed: ${e}`);
      // Confirmed failure before the timeout — the send didn't land, so queue
      // the prompt locally. Drained at the next SessionStart once the host is back.
      const queuedAt = new Date().toISOString();
      enqueueOutbox(
        chunkContent(cleanPrompt).map((chunk) => ({
          sessionName,
          peerName: config.peerName,
          content: chunk,
          metadata: promptMetadata,
          createdAt: queuedAt,
          queuedAt,
          workspace: config.workspace,
        })),
      );
    } finally {
      clearTimeout(uploadTimer);
    }
  }

  // Track message count for threshold-based refresh
  const messageCountBefore = getMessageCount(config.workspace, resolveCacheScope(config));
  incrementMessageCount(config.workspace, resolveCacheScope(config));
  // Only surface the app.honcho.dev session link when actually pointed at the
  // hosted platform — for self-hosted ("local") or custom-baseUrl deployments
  // the GUI at app.honcho.dev has no access to the user's data and the link
  // would land on an empty workspace.
  const shouldShowSessionLink =
    messageCountBefore === 0 && getEndpointInfo(config).type === "production";

  // Build session link lazily — only materialized on first message
  const sessionLink = shouldShowSessionLink
    ? formatSessionLink(honchoSessionUrl(config.workspace, sessionName))
    : undefined;

  // Skip trivial prompts — no context needed for "y", "ok", etc.
  if (shouldSkipContextRetrieval(prompt)) {
    logHook("user-prompt", "Skipping context (trivial prompt)");
    visSkipMessage("user-prompt", sessionLink ? `${sessionLink} · trivial prompt` : "trivial prompt");
    process.exit(0);
  }

  // Decide whether to refresh: TTL expired or message threshold hit
  const forceRefresh = shouldRefreshKnowledgeGraph(config.workspace, resolveCacheScope(config));
  const cachedContext = getCachedUserContext(config.workspace, resolveCacheScope(config));
  const cacheIsStale = isContextCacheStale(config.workspace, resolveCacheScope(config));

  if (cachedContext && !cacheIsStale && !forceRefresh) {
    // Fresh cache — serve instantly, no API call
    logCache("hit", "userContext", "fresh cache");
    verboseApiResult("peer.context() -> representation (cached)", cachedContext?.representation);
    verboseList("peer.context() -> peerCard (cached)", cachedContext?.peerCard);

    serveContext(config.peerName, cachedContext, true, instanceId || "", sessionLink);
    process.exit(0);
  }

  // Cache is stale or threshold reached — try a fresh fetch with timeout
  logCache("miss", "userContext", forceRefresh ? "threshold refresh" : "stale cache");

  const fetchResult = await Promise.race([
    fetchFreshContext(config, prompt, honcho).then(r => ({ ok: true as const, ...r })),
    new Promise<{ ok: false }>(resolve => setTimeout(() => resolve({ ok: false }), FETCH_TIMEOUT_MS)),
  ]).catch((): { ok: false } => ({ ok: false }));

  if (fetchResult.ok) {
    const { context } = fetchResult;
    if (forceRefresh) {
      markKnowledgeGraphRefreshed(config.workspace, resolveCacheScope(config));
    }
    if (context) {
      serveContext(config.peerName, context, false, instanceId || "", sessionLink);
      process.exit(0);
    }
  }

  // Fetch failed or timed out — silently fall back to stale cache
  const staleContext = getStaleCachedUserContext(config.workspace, resolveCacheScope(config));
  if (staleContext) {
    logHook("user-prompt", "Serving stale cache after timeout");
    serveContext(config.peerName, staleContext, true, instanceId || "", sessionLink);
  }
  // No cache at all — exit silently, context will arrive after session-start completes

  process.exit(0);
}

/**
 * Format and output context injection to Claude.
 */
function serveContext(
  peerName: string,
  context: any,
  cached: boolean,
  instanceId: string,
  sessionLink?: string,
): void {
  const seen = instanceId ? getInjectedConclusions(instanceId) : [];
  const { parts: contextParts, newConclusions } = formatCachedContext(context, peerName, seen);
  if (contextParts.length === 0) return;

  const visMsg = visContextLine("user-prompt", { cached });
  outputContext(peerName, contextParts, sessionLink ? `${sessionLink}\n${visMsg}` : visMsg);

  if (instanceId && newConclusions.length) addInjectedConclusions(instanceId, newConclusions);
}

async function fetchFreshContext(config: any, prompt: string, honcho: Honcho): Promise<{ context: any }> {
  const observationMode = getObservationMode(config);
  const useSelfSpineRead = readsAsUnified(observationMode);

  // unified & hybrid: query the self-spine; directional: per-agent lens with target.
  const contextPeer = useSelfSpineRead
    ? await honcho.peer(config.peerName)
    : await honcho.peer(config.aiPeer);
  const contextTarget = useSelfSpineRead ? undefined : config.peerName;
  const contextLabel = useSelfSpineRead ? "userPeer.context" : "aiPeer.context";

  const startTime = Date.now();

  // Try search-based context first — returns conclusions relevant to the prompt.
  // Fall back to the raw prompt (truncated) when no high-signal topics match:
  // natural text embeds well, and it keeps non-English prompts working.
  const topics = extractTopics(prompt);
  const searchQuery = topics.length > 0 ? topics.join(" ") : prompt.trim().slice(0, 300);

  let contextResult: any = null;

  if (searchQuery) {
    try {
      // The representation merges search hits with frequent/recent conclusions
      // into one timestamp-ordered string, so prompt-relevant lines get lost.
      // Query matched conclusions separately and let the formatter put them first.
      const conclusionScope = contextTarget
        ? contextPeer.conclusionsOf(contextTarget)
        : contextPeer.conclusions;
      const [ctx, matched] = await Promise.all([
        contextPeer.context({
          ...(contextTarget ? { target: contextTarget } : {}),
          searchQuery,
          searchTopK: 5,
          searchMaxDistance: 0.7,
          maxConclusions: 15,
          includeMostFrequent: true,
        }),
        conclusionScope.query(searchQuery, 5).catch((): any[] => []),
      ]);
      contextResult = ctx;
      if (contextResult && matched?.length) {
        contextResult.searchMatched = matched.map((c: any) => c.content).filter(Boolean);
      }
      logApiCall(contextLabel, "GET", `search: ${searchQuery.slice(0, 60)}`, Date.now() - startTime, true);
    } catch (e) {
      // Search failed — fall through to static context
      logHook("user-prompt", `Search context failed, falling back to static: ${e}`);
    }
  }

  // Fallback: static context (no search query)
  if (!contextResult) {
    contextResult = await contextPeer.context({
      ...(contextTarget ? { target: contextTarget } : {}),
      maxConclusions: 15,
      includeMostFrequent: true,
    });
    logApiCall(contextLabel, "GET", `static context`, Date.now() - startTime, true);
  }

  if (contextResult) {
    setCachedUserContext(config.workspace, contextResult, resolveCacheScope(config));
    verboseApiResult("peer.context() -> representation (fresh)", (contextResult as any).representation);
    verboseList("peer.context() -> peerCard (fresh)", (contextResult as any).peerCard);
  }

  return { context: contextResult };
}

/** Strip a conclusion line's leading `[timestamp]` prefix and `- ` bullet. */
export function stripConclusionLine(line: string): string {
  return line.replace(/^\[.*?\]\s*/, "").replace(/^- /, "").trim();
}

export function formatCachedContext(
  context: any,
  _peerName: string,
  seen: string[] = [],
): { parts: string[]; conclusionCount: number; newConclusions: string[] } {
  const parts: string[] = [];
  let conclusionCount = 0;
  const newConclusions: string[] = [];
  const rep = context?.representation;

  // Prompt-matched conclusions first (from semantic search), then the most
  // recent representation lines to fill up to 5 slots. The representation is
  // ordered oldest-first, so taking its head would inject the stalest facts.
  // `seen` carries conclusions already injected earlier this session (per
  // instance), so the same fact isn't re-shown turn after turn.
  const seenKeys = new Set<string>();
  const push = (text: string) => {
    const clean = stripConclusionLine(text);
    const key = clean.toLowerCase();
    if (clean && !seenKeys.has(key) && !seen.includes(clean) && newConclusions.length < 5) {
      seenKeys.add(key);
      newConclusions.push(clean);
    }
  };

  for (const c of context?.searchMatched ?? []) push(String(c));

  if (typeof rep === "string" && rep.trim()) {
    const lines = rep.split("\n").filter((l: string) => l.trim() && !l.startsWith("#"));
    // Sort newest-first when lines carry a leading [timestamp]; else keep order.
    const stamped = lines.map((l: string, i: number) => ({ l, t: l.match(/^\[([^\]]+)\]/)?.[1] ?? "", i }));
    stamped.sort((a, b) => b.t.localeCompare(a.t) || a.i - b.i);
    for (const { l } of stamped) push(l);
  }

  if (newConclusions.length > 0) {
    conclusionCount = newConclusions.length;
    parts.push(`Relevant conclusions: ${newConclusions.join("; ")}`);
  }

  const peerCard = context?.peerCard;
  if (peerCard?.length) {
    parts.push(`Profile: ${peerCard.join("; ")}`);
  }

  return { parts, conclusionCount, newConclusions };
}

function outputContext(peerName: string, contextParts: string[], systemMsg?: string): void {
  let output: any = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `[Honcho Memory for ${peerName}]: ${contextParts.join(" | ")}`,
    },
  };
  if (systemMsg) {
    output = addSystemMessage(output, systemMsg);
  }
  console.log(JSON.stringify(output));
}
