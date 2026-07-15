import { Honcho } from "@honcho-ai/sdk";
import {
  loadConfig,
  getHonchoClientOptions,
  isPluginEnabled,
  applyDirectoryOverride,
} from "../config.js";
import { logHook, setLogContext } from "../log.js";
import { drainOutbox } from "../outbox.js";

/**
 * Detached, upload-only worker spawned by the Stop hook.
 *
 * The Stop hook queues each assistant response and returns immediately; this
 * process outlives it and flushes the outbox to Honcho out-of-band, so no
 * turn-end ever waits on the network. It builds the client from the SAME
 * directory-resolved config the Stop hook used (argv: cwd, instanceId) so the
 * just-queued record lands in the correct workspace. Anything it can't send
 * stays queued for the next SessionStart drain.
 */
export async function handleOutboxWorker(): Promise<void> {
  let config = loadConfig();
  if (!config || !isPluginEnabled()) {
    process.exit(0);
  }
  const cwd = process.argv[2] || process.cwd();
  const instanceId = process.argv[3] || "stop-worker";
  config = applyDirectoryOverride(config, cwd);
  setLogContext(cwd, instanceId);
  try {
    const honcho = new Honcho(getHonchoClientOptions(config));
    await drainOutbox(honcho, instanceId, (m) => logHook("outbox-worker", m), {
      timeBudgetMs: 8000,
    });
  } catch (e) {
    logHook("outbox-worker", `drain failed: ${e}`, { error: String(e) });
  }
  process.exit(0);
}
