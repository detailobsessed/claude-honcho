/**
 * Shared test setup — runs before all test files.
 *
 * Creates a single temp directory and mocks `os.homedir()` to return it.
 * All test files share this temp home; each clears the .honcho directory
 * in their beforeEach hook.
 *
 * This file is loaded via `bun test --preload tests/setup.ts` or via
 * the `preload` field in bunfig.toml.
 */
import { mkdtempSync, rmSync, existsSync, readdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mock } from "bun:test";

// Create a single temp home directory for all tests
const tempHome = mkdtempSync(join(tmpdir(), "honcho-test-shared-"));

// Mock os.homedir() to return our temp dir.
// This MUST be set up before any source module is imported, because
// the source modules call homedir() at module load time.
mock.module("os", () => {
  const actual = require("os");
  return { ...actual, homedir: () => tempHome };
});

// Export the shared paths so test files can use them
export const SHARED_HOME = tempHome;
export const SHARED_HONCHO_DIR = join(tempHome, ".honcho");

/** Clear all contents of the shared .honcho directory. */
export function clearSharedHonchoDir(): void {
  if (!existsSync(SHARED_HONCHO_DIR)) return;
  for (const entry of readdirSync(SHARED_HONCHO_DIR)) {
    try {
      unlinkSync(join(SHARED_HONCHO_DIR, entry));
    } catch {
      // ignore
    }
  }
}

// Clean up on process exit
process.on("beforeExit", () => {
  try {
    rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
