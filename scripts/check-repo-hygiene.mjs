#!/usr/bin/env node
// Repository hygiene checks, run in CI and before commits:
//   1. No real .env files are tracked (or present in a ZIP source-tree scan; only *.example is allowed).
//   2. No archives (zip/tar/tgz/gz) are tracked; the reference ZIP contained real .env files.
//   3. Frontend env files contain no secret-looking variable names, and NEXT_PUBLIC_ variables
//      never look like secrets (they are embedded in the browser bundle).
//   4. No obvious credential patterns appear in tracked text files.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SECRETY_NAME = /(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|API_?KEY|CREDENTIAL)/i;

export function findTrackedEnvFiles(files) {
  return files.filter((f) => /(^|\/)\.env(\.[^/]*)?$/.test(f) && !f.endsWith(".example"));
}

export function findTrackedArchives(files) {
  return files.filter((f) => /\.(zip|tar|tgz|gz|7z|rar)$/i.test(f));
}

/** Variable names defined in a dotenv-style text. */
export function envVariableNames(text) {
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

/** Secret-looking variable names in a frontend env file (anything is suspicious there). */
export function findSecretyFrontendVars(text) {
  return envVariableNames(text).filter((name) => SECRETY_NAME.test(name));
}

// Built by concatenation so this file does not match its own patterns.
const CREDENTIAL_PATTERNS = [
  { name: "OpenAI-style key", re: new RegExp("\\bsk-" + "[A-Za-z0-9_-]{20,}") },
  { name: "GitHub token", re: new RegExp("\\bgh[pousr]_" + "[A-Za-z0-9]{30,}") },
  { name: "GitHub fine-grained token", re: new RegExp("\\bgithub_pat_" + "[A-Za-z0-9_]{30,}") },
  { name: "Google API key", re: new RegExp("\\bAIza" + "[0-9A-Za-z_-]{35}\\b") },
  { name: "private key block", re: new RegExp("-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE" + " KEY-----") },
  { name: "AWS access key id", re: new RegExp("\\bAKIA" + "[0-9A-Z]{16}\\b") },
];

export function findCredentialPatterns(text) {
  return CREDENTIAL_PATTERNS.filter(({ re }) => re.test(text)).map(({ name }) => name);
}

const GENERATED_DIRS = new Set([".git", "node_modules", ".next", "coverage", "dist", ".turbo", "out", "build", "test-results", "playwright-report"]);

export function sourceTreeFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!GENERATED_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return files.sort();
}

function trackedFiles(root = process.cwd()) {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    return out.split("\0").filter(Boolean);
  } catch {
    // ZIP handoffs normally omit .git. Scan the source tree in that case, excluding generated directories.
    return sourceTreeFiles(root);
  }
}

function isProbablyText(path) {
  return !/\.(png|jpe?g|gif|ico|woff2?|pdf|zip|tar|tgz|gz)$/i.test(path);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = trackedFiles(process.cwd());
  const problems = [];

  for (const f of findTrackedEnvFiles(files)) problems.push(`tracked env file: ${f}`);
  for (const f of findTrackedArchives(files)) problems.push(`tracked archive: ${f}`);

  for (const f of files.filter((p) => /^apps\/web\/\.env/.test(p) && p.endsWith(".example"))) {
    for (const name of findSecretyFrontendVars(readFileSync(f, "utf8"))) {
      problems.push(`secret-looking variable in frontend env file ${f}: ${name}`);
    }
  }

  for (const f of files) {
    // This script and its tests legitimately mention credential shapes.
    if (f.startsWith("scripts/check-repo-hygiene")) continue;
    if (!isProbablyText(f)) continue;
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const kind of findCredentialPatterns(text)) problems.push(`${kind} pattern in ${f}`);
  }

  if (problems.length > 0) {
    console.error("Repository hygiene problems:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`Repository hygiene OK (${files.length} files checked).`);
}
