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

  test("redacts a ~~~-fenced code block", () => {
    const prompt = "Look at this:\n~~~python\ndef secretFunction():\n    return 42\n~~~\nok?";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(true);
    expect(text).toContain("[code block removed]");
    expect(text).not.toContain("secretFunction");
    expect(text).toContain("Look at this:");
    expect(text).toContain("ok?");
  });

  test("redacts an unterminated fence to end of input", () => {
    // Truncated paste: opening fence, no closing fence.
    const prompt = "Here is the log:\n```\nsecretFunction() threw at line 40\nand a second line";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(true);
    expect(text).toContain("[code block removed]");
    expect(text).not.toContain("secretFunction");
    expect(text).toContain("Here is the log:");
  });

  test("a stray inline ``` in prose does not swallow the message", () => {
    // Opening fence must start a line — an inline backtick run is left alone.
    const prompt = "Please wrap the output in ``` when you show it to me.";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(false);
    expect(text).toBe(prompt);
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

  test("redacts a pasted review-bot comment (the live misattribution repro)", () => {
    // A pasted "macroscope:" finding was being minted as "<user> identified an
    // issue in config.ts around line 681" — the user's own instruction survives.
    const prompt =
      "Please fix this finding:\n" +
      "macroscope: In file @plugins/honcho/src/config.ts around line 681: saveConfig persists the resolved flags\n" +
      "without excluding environment-derived values. Guard them.\n\n" +
      "Go ahead.";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(true);
    expect(text).toContain("[tool output removed]");
    expect(text).toContain("Please fix this finding:");
    expect(text).toContain("Go ahead.");
    expect(text).not.toContain("config.ts");
    expect(text).not.toContain("saveConfig");
    expect(text).not.toContain("environment-derived");
  });

  test("redacts a pasted stack trace opening with a Traceback marker", () => {
    const prompt =
      "It crashed:\n" +
      "Traceback (most recent call last):\n" +
      '  File "/app/main.py", line 10, in <module>\n' +
      "    do_thing()\n" +
      "RuntimeError: boom\n\n" +
      "fix it please";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(true);
    expect(text).toContain("[tool output removed]");
    expect(text).not.toContain("Traceback");
    expect(text).not.toContain("RuntimeError");
    expect(text).toContain("fix it please");
  });

  test("redacts a run of markdown blockquote lines (quoted, not the user's words)", () => {
    const prompt =
      "The reviewer said:\n> This function is misnamed.\n> Rename it before merge.\nWhat do you think?";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(true);
    expect(text).toContain("[quoted text removed]");
    expect(text).not.toContain("misnamed");
    expect(text).toContain("The reviewer said:");
    expect(text).toContain("What do you think?");
  });

  test("preserves an inline 'error:' mention in genuine prose", () => {
    // Not line-anchored to a marker — the user is speaking, not pasting.
    const prompt = "I keep getting an error: the build fails intermittently. Any ideas?";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(false);
    expect(text).toBe(prompt);
  });

  test("preserves a user line that merely opens with 'Error:' (high-precision markers only)", () => {
    // "error"/"warning" are deliberately NOT markers — a user may open a
    // sentence with them. Only bot names and unambiguous crash markers fire.
    const prompt = "Error: my local build is broken. Can you help me debug it?";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(false);
    expect(text).toBe(prompt);
  });
});
