#!/usr/bin/env bun
/**
 * Cut a release: bump the plugin version, stamp the changelog, tag, and push.
 *
 * Automates the three manual steps this fork repeats every release:
 *   1. bump "version" in plugins/honcho/.claude-plugin/plugin.json (the tag's
 *      source of truth — release.yml refuses a tag that doesn't match it),
 *   2. rename the "## [Unreleased]" changelog heading to "## [x.y.z] - <date>"
 *      and open a fresh empty Unreleased above it (the exact Keep-a-Changelog
 *      shape release.yml's awk extractor parses),
 *   3. commit "chore(release): x.y.z", annotate-tag "vx.y.z", and push both —
 *      which fires .github/workflows/release.yml to publish the GitHub Release.
 *
 * Usage:
 *   bun scripts/release.ts [patch|minor|major|X.Y.Z]   (default: patch)
 *     --dry-run   print the plan (new version + changelog section) and exit
 *     --no-push   commit and tag locally, but don't push (inspect first)
 *
 * Deliberately dependency-free and format-owning: because this script writes
 * the changelog heading itself, it can't drift from what release.yml expects.
 */
import { $ } from "bun";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const noPush = args.includes("--no-push");
const bumpArg = args.find((a) => !a.startsWith("--")) ?? "patch";

const root = (await $`git rev-parse --show-toplevel`.text()).trim();
const PLUGIN_JSON = `${root}/plugins/honcho/.claude-plugin/plugin.json`;
const CHANGELOG = `${root}/CHANGELOG.md`;

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function nextVersion(current: string, bump: string): string {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump; // explicit version
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) fail(`current version "${current}" is not X.Y.Z`);
  const [maj, min, pat] = m.slice(1).map(Number);
  if (bump === "major") return `${maj + 1}.0.0`;
  if (bump === "minor") return `${maj}.${min + 1}.0`;
  if (bump === "patch") return `${maj}.${min}.${pat + 1}`;
  fail(`unknown bump "${bump}" — use patch | minor | major | X.Y.Z`);
}

// --- read current state ------------------------------------------------------
const pluginRaw = await Bun.file(PLUGIN_JSON).text();
const curVersion = JSON.parse(pluginRaw).version as string;
const version = nextVersion(curVersion, bumpArg);
const tag = `v${version}`;
const date = new Date().toISOString().slice(0, 10);

// Guard: never re-cut an existing tag.
const existing = (await $`git tag -l ${tag}`.text()).trim();
if (existing) fail(`tag ${tag} already exists`);

// Guard: refuse to cut an empty release — the Unreleased section must have
// content, or the published notes would be blank.
const changelogRaw = await Bun.file(CHANGELOG).text();
const unreleased = changelogRaw.match(/## \[Unreleased\]\n([\s\S]*?)\n## \[/);
if (!unreleased) fail("could not locate the '## [Unreleased]' section in CHANGELOG.md");
const notes = unreleased[1].trim();
if (!notes) fail("'## [Unreleased]' is empty — add changelog entries before releasing");

console.log(`  ${curVersion} → ${version}   (tag ${tag}, ${date})`);
console.log(`\n  release notes:\n${notes.split("\n").map((l) => `    ${l}`).join("\n")}\n`);

if (dryRun) {
  console.log("  --dry-run: no files changed.");
  process.exit(0);
}

// --- write plugin.json (targeted, preserves formatting) ----------------------
const pluginNext = pluginRaw.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
if (pluginNext === pluginRaw) fail('could not find a "version" field in plugin.json');
await Bun.write(PLUGIN_JSON, pluginNext);

// --- write CHANGELOG: open a fresh Unreleased above the dated section --------
const changelogNext = changelogRaw.replace(
  "## [Unreleased]",
  `## [Unreleased]\n\n## [${version}] - ${date}`,
);
await Bun.write(CHANGELOG, changelogNext);

// --- commit, tag, push -------------------------------------------------------
await $`git -C ${root} add ${PLUGIN_JSON} ${CHANGELOG}`;
await $`git -C ${root} commit -m ${`chore(release): ${version}`}`;
await $`git -C ${root} tag -a ${tag} -m ${tag}`;
console.log(`✓ committed and tagged ${tag}`);

if (noPush) {
  console.log(`  --no-push: run 'git push --follow-tags' when ready.`);
  process.exit(0);
}

await $`git -C ${root} push --follow-tags`;
console.log(`✓ pushed ${tag} → release.yml will publish the GitHub Release`);
