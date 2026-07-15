/**
 * Unit tests for stripPastes (src/hooks/user-prompt.ts).
 *
 * stripPastes redacts pasted non-prose from a user prompt before it's stored
 * as user speech, so the fact extractor can't misattribute pasted code/diffs/
 * log-dumps to the user. It redacts, in order: (1) fenced code blocks, (2)
 * runs of 3+ consecutive unified-diff lines, (3) long (>200 char) lines that
 * carry a filesystem path. Everything else — short path mentions, a lone
 * "+"/"-" line in prose — is preserved untouched.
 */
import { describe, test, expect } from "bun:test";
import { stripPastes } from "../src/hooks/user-prompt.ts";

describe("stripPastes", () => {
  test("pure prose is left untouched", () => {
    const prompt = "Please help me refactor the auth module for clarity.";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(false);
    expect(text).toBe(prompt);
  });

  test("redacts a fenced code block and drops its contents", () => {
    const prompt =
      "Please review this function:\n```ts\nfunction secretFunction() {\n  return 42;\n}\n```\nThanks!";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(true);
    expect(text).toContain("[code block removed]");
    expect(text).not.toContain("secretFunction");
  });

  test("redacts a run of 3+ consecutive unified-diff lines", () => {
    const prompt =
      "Review this:\n+function buildOperatorPlan() {\n-  return old;\n+  return next;\n";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(true);
    expect(text).toContain("[diff removed]");
  });

  test("redacts a long line that carries a filesystem path", () => {
    const longLine = "/Users/foo/project/src/module/file.ts " + "x".repeat(220);
    expect(longLine.length).toBeGreaterThan(200);
    const { text, redacted } = stripPastes(longLine);
    expect(redacted).toBe(true);
    expect(text).toContain("[path/output removed]");
  });

  test("preserves a short line that merely mentions a path", () => {
    const prompt = "Please edit /Users/foo/file.ts to fix the bug";
    expect(prompt.length).toBeLessThan(200);
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(false);
    expect(text).toBe(prompt);
  });

  test("adversarial-review pattern: prose survives, fenced diff is stripped (fence wins)", () => {
    const prompt =
      "Please review this change carefully.\n```diff\n+function buildOperatorPlan() {\n-  return old;\n+  return next;\n```\n";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(true);
    expect(text).toContain("Please review this change carefully.");
    expect(text).toContain("[code block removed]");
    expect(text).not.toContain("buildOperatorPlan");
  });

  test("empty prompt is left untouched", () => {
    const { text, redacted } = stripPastes("");
    expect(redacted).toBe(false);
    expect(text).toBe("");
  });

  test("a single +/- prefixed line in prose is preserved (needs 3+ to count as a diff)", () => {
    const prompt = "I want to note this:\n+ one interesting bullet\nThat's all for now.";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(false);
    expect(text).toBe(prompt);
  });
});
