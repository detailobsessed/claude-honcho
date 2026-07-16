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

  test("preserves genuine prose opening with a common crash word (no trace punctuation)", () => {
    // The mirror of the misattribution bug: a user's real words that happen to
    // start with "Panic"/"Fatal error"/"Copilot"/"Stack trace" must survive.
    // Only the punctuated forms (`panic:`, `copilot[bot]`) read as pasted output.
    for (const prompt of [
      "Panic attacks are affecting me and I need to step away for a bit.",
      "Fatal error handling should be refactored to use Result types.",
      "Copilot suggested a cleaner approach — should we take it?",
      "Stack trace was enormous, so let me just summarize the failure instead.",
      "Panic mode: here's what I want, plus a second sentence to be sure.",
    ]) {
      const { text, redacted } = stripPastes(prompt);
      expect(redacted).toBe(false);
      expect(text).toBe(prompt);
    }
  });

  test("still redacts real Go crash output (panic:/fatal error: carry a colon)", () => {
    const prompt =
      "It blew up:\n" +
      "panic: runtime error: invalid memory address or nil pointer dereference\n" +
      "\tgoroutine 1 [running]:\n" +
      "main.main()\n\n" +
      "any idea why?";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(true);
    expect(text).toContain("[tool output removed]");
    expect(text).not.toContain("goroutine");
    expect(text).not.toContain("invalid memory address");
    expect(text).toContain("It blew up:");
    expect(text).toContain("any idea why?");
  });

  test("redacts a review-bot label carrying a bracket (copilot[bot])", () => {
    const prompt = "copilot[bot] flagged this:\nrename the function before merge\n\nthoughts?";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(true);
    expect(text).toContain("[tool output removed]");
    expect(text).not.toContain("rename the function");
    expect(text).toContain("thoughts?");
  });

  // A long expository prose paste (a pasted article/reference block) carries
  // NONE of the earlier markers — no fence, diff, blockquote, bot label, or
  // long path line — and even contains conversational words ("you", "we") and
  // question marks, so no voice heuristic separates it from speech. Left
  // untouched it is stored as the user's own words and the fact extractor mints
  // durable misattributions ("<user> is aware that Lorem Ipsum comes from
  // Cicero"). The only reliable content signal is bulk: a long, multi-sentence
  // block that reads as pasted reference material, not a typed request.
  test("redacts a long marker-free prose paste, keeps the user's own framing", () => {
    const framing = "pasting something random just for testing:";
    const body =
      "Lorem Ipsum is simply dummy text of the printing and typesetting industry. " +
      "It has been the industry's standard dummy text ever since the 1500s, when an " +
      "unknown printer took a galley of type and scrambled it to make a type specimen " +
      "book. It has survived not only five centuries, but also the leap into electronic " +
      "typesetting, remaining essentially unchanged. It was popularised in the 1960s with " +
      "the release of Letraset sheets containing Lorem Ipsum passages, and more recently " +
      "with desktop publishing software like Aldus PageMaker.";
    const prompt = `${framing}\n\n${body}`;
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(true);
    expect(text).toContain(framing); // user's real words survive
    expect(text).not.toContain("dummy text of the printing"); // pasted body gone
    expect(text).toContain("[long paste removed]");
  });

  test("a normal multi-sentence user request is NOT treated as a long paste", () => {
    // Two real sentences, well under the bulk threshold — genuine speech.
    const prompt =
      "Please refactor the auth module for clarity and add tests. " +
      "I think the token refresh path is the riskiest bit, so start there.";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(false);
    expect(text).toBe(prompt);
  });

  // A long expository paragraph pasted alone, with no framing at all — the
  // whole message body is reference material, so the whole thing goes.
  test("a long paste with no framing is redacted whole", () => {
    const prompt =
      "The mitochondria is the powerhouse of the cell and converts nutrients into ATP " +
      "through oxidative phosphorylation. This process occurs across the inner membrane, " +
      "where the electron transport chain establishes a proton gradient. The gradient " +
      "drives ATP synthase to phosphorylate ADP into ATP. Cells with high energy demands " +
      "contain many mitochondria to sustain their activity. Damage to these organelles is " +
      "implicated in numerous metabolic diseases and remains an active area of research.";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(true);
    expect(text.trim()).toBe("[long paste removed]");
    expect(text).not.toContain("mitochondria");
  });

  // The paste sits between the user's question and their sign-off — both the
  // lead-in and the trailing ask must survive, only the pasted block goes.
  test("a paste embedded between the user's lead-in and question is redacted, framing kept", () => {
    const body =
      "The mitochondria is the powerhouse of the cell and converts nutrients into ATP " +
      "through oxidative phosphorylation. This process occurs across the inner membrane, " +
      "where the electron transport chain establishes a proton gradient. The gradient " +
      "drives ATP synthase to phosphorylate ADP into ATP. Cells with high energy demands " +
      "contain many mitochondria to sustain their activity. Damage to these organelles is " +
      "implicated in numerous metabolic diseases and remains an active area of research.";
    const prompt = `Here's the abstract I pasted:\n\n${body}\n\nCan you tl;dr it in two lines?`;
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(true);
    expect(text).toContain("Here's the abstract I pasted:");
    expect(text).toContain("Can you tl;dr it in two lines?");
    expect(text).toContain("[long paste removed]");
    expect(text).not.toContain("oxidative phosphorylation");
  });

  // Two separate long paragraphs — each is redacted independently; the blank
  // line between them is preserved so the output isn't mangled.
  test("multiple long paragraphs are each redacted", () => {
    const a =
      "The mitochondria is the powerhouse of the cell and converts nutrients into ATP " +
      "through oxidative phosphorylation. This process occurs across the inner membrane " +
      "where the electron transport chain sits. The proton gradient drives ATP synthase to " +
      "phosphorylate ADP into ATP. Cells with high energy demands contain many mitochondria " +
      "to sustain their metabolic activity. Damage to these organelles is implicated in " +
      "numerous metabolic diseases.";
    const b =
      "The ribosome translates messenger RNA into a chain of amino acids during the process " +
      "of translation. It reads codons three bases at a time along the length of the " +
      "transcript. Transfer RNA molecules deliver each matching amino acid in turn to the " +
      "growing chain. The polypeptide folds into a functional protein once translation " +
      "completes. A single cell can hold millions of ribosomes working in parallel.";
    const { text, redacted } = stripPastes(`${a}\n\n${b}`);
    expect(redacted).toBe(true);
    expect(text).not.toContain("mitochondria");
    expect(text).not.toContain("ribosome");
    expect(text.match(/\[long paste removed\]/g)?.length).toBe(2);
  });

  // Precision guard: a LONG single run-on sentence (many clauses, one period)
  // is genuine speech, not a paste — bulk alone must not trigger without the
  // multi-sentence signal.
  test("a long single run-on sentence is preserved (needs multiple sentences)", () => {
    const prompt =
      "I really need you to go through the entire authentication subsystem including the " +
      "token refresh logic and the session store and the middleware that validates bearer " +
      "tokens and the retry paths and every error branch, and then tell me where you think " +
      "the single most fragile part is before we start changing anything at all today.";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(false);
    expect(text).toBe(prompt);
  });

  // Version numbers / decimals ("1.10.32") must not inflate the sentence count:
  // the dots are followed by digits, not whitespace, so they don't read as
  // sentence ends. A short cite-heavy line stays under the threshold and is kept.
  test("decimals and version numbers do not count as sentence boundaries", () => {
    const prompt = "See sections 1.10.32 and 1.10.33 in v2.4.1 of the spec for the details.";
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(false);
    expect(text).toBe(prompt);
  });

  // CRLF regression: on Windows-style `\r\n\r\n` blank lines the paragraph
  // split must still fire per-paragraph. Otherwise the whole prompt stays one
  // part and the user's framing + trailing request are redacted wholesale.
  test("CRLF blank lines split per-paragraph, framing and request survive", () => {
    const body =
      "The mitochondria is the powerhouse of the cell and converts nutrients into ATP " +
      "through oxidative phosphorylation. This process occurs across the inner membrane " +
      "where the electron transport chain sits. The proton gradient drives ATP synthase to " +
      "phosphorylate ADP into ATP. Cells with high energy demands contain many mitochondria " +
      "to sustain their metabolic activity. Damage to these organelles is implicated in " +
      "numerous metabolic diseases.";
    const prompt = `Here's what I pasted:\r\n\r\n${body}\r\n\r\nCan you summarize it?`;
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(true);
    expect(text).toContain("Here's what I pasted:");
    expect(text).toContain("Can you summarize it?");
    expect(text).toContain("[long paste removed]");
    expect(text).not.toContain("oxidative phosphorylation");
  });

  // Interaction: a fenced code block (pass 1) AND a long prose paste (pass 6)
  // in one message — both are stripped, and the two placeholders coexist.
  test("a code fence and a long prose paste are both stripped", () => {
    const body =
      "The mitochondria is the powerhouse of the cell and converts nutrients into ATP " +
      "through oxidative phosphorylation. This process occurs across the inner membrane " +
      "where the electron transport chain sits. The proton gradient drives ATP synthase to " +
      "phosphorylate ADP into ATP. Cells with high energy demands contain many mitochondria " +
      "to sustain their metabolic activity. Damage to these organelles is implicated in " +
      "numerous metabolic diseases.";
    const prompt = "```ts\nconst secret = 42;\n```\n\n" + body;
    const { text, redacted } = stripPastes(prompt);
    expect(redacted).toBe(true);
    expect(text).toContain("[code block removed]");
    expect(text).toContain("[long paste removed]");
    expect(text).not.toContain("secret = 42");
    expect(text).not.toContain("mitochondria");
  });
});
