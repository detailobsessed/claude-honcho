/**
 * Shared harness for integration-testing the plugin's Claude Code hooks.
 *
 * Hooks are awkward to test directly because they (a) construct the Honcho
 * client from the "@honcho-ai/sdk" module, and (b) end every path in
 * `process.exit()`. This harness:
 *
 *   - mocks the SDK so no network call happens and `new Honcho()` returns a
 *     test double whose calls can be inspected, and
 *   - stubs `process.exit` to throw a catchable `ExitSignal`, so a handler can
 *     be driven to completion and its side effects (Honcho calls, outbox/cache
 *     writes) asserted afterwards.
 *
 * IMPORTANT: this module registers the SDK mock at import time, so import it
 * BEFORE the hook under test binds `Honcho`. Load hooks with `await import(...)`
 * inside `beforeAll` — never as a hoisted static import — so the mock wins.
 */
import { mock, spyOn } from "bun:test";

let currentHoncho: unknown = null;

/** Set the client instance the next `new Honcho()` in a hook will return. */
export function setHoncho(instance: unknown): void {
  currentHoncho = instance;
}

// Registered at import time so it beats any later dynamic hook import.
mock.module("@honcho-ai/sdk", () => ({
  Honcho: function Honcho(this: unknown, _opts: unknown) {
    // A constructor that returns an object makes `new Honcho()` yield it.
    return currentHoncho;
  },
}));

/**
 * Honcho env vars that override config resolution. Hook tests clear these in
 * beforeEach so ambient env (or a var another test file leaked) can't disable
 * the plugin or shadow the config under test.
 */
const HONCHO_ENV_VARS = [
  "HONCHO_API_KEY",
  "HONCHO_PEER_NAME",
  "HONCHO_WORKSPACE",
  "HONCHO_AI_PEER",
  "HONCHO_HOST",
  "HONCHO_ENDPOINT",
  "HONCHO_ENABLED",
  "HONCHO_SAVE_MESSAGES",
  "HONCHO_LOGGING",
  "CURSOR_PROJECT_DIR",
];

/** Remove all Honcho-related env vars so config resolves purely from the file. */
export function clearHonchoEnv(): void {
  for (const key of HONCHO_ENV_VARS) delete process.env[key];
}

/** Thrown in place of `process.exit` so a handler can be run to completion. */
export class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
    this.name = "ExitSignal";
  }
}

/** Replace `process.exit` with a throwing stub. Returns the spy for restoration. */
export function stubExit() {
  return spyOn(process, "exit").mockImplementation(((code?: number): never => {
    throw new ExitSignal(code ?? 0);
  }) as never);
}

/** Run a hook handler, translating its `process.exit(code)` into a returned code. */
export async function runHook(handler: () => Promise<void>): Promise<number> {
  try {
    await handler();
    return 0; // handler returned without calling exit
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}

/**
 * A Honcho double whose message uploads reject, to exercise the
 * host-unreachable / outbox paths. Records `session` and `peer` lookups.
 */
export function createFailingHoncho(message = "host unreachable"): any {
  const calls: Record<string, any[]> = {};
  const record = (name: string, args: any[]) => {
    if (!calls[name]) calls[name] = [];
    calls[name].push(args);
  };
  return {
    calls,
    session: async (name: string) => {
      record("session", [name]);
      return {
        addPeers: async () => {
          throw new Error(message);
        },
        addMessages: async () => {
          throw new Error(message);
        },
        summaries: async () => {
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
