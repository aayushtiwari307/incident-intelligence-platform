#!/usr/bin/env node
// Fails if more than one version of a watched package is installed anywhere in the tree.
//
// Why: the reference project's Vite dev server problem coincided with two Vite majors
// (8.x hoisted at the root, 7.x inside the frontend workspace) being resolved by different
// parts of the toolchain. We cannot prove that was the cause, but "two copies of one
// toolchain package" is a defect class worth failing CI on, especially for React,
// React DOM and TypeScript.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export const DEFAULT_WATCHED = [
  "react",
  "react-dom",
  "typescript",
  "@types/react",
  "@types/react-dom",
  "zod",
  "pg",
];

/** Walks an `npm ls --all --json` tree and returns { name: [versions...] } for names with 2+ versions. */
export function findDuplicates(tree, watched = DEFAULT_WATCHED) {
  const seen = new Map();
  const watch = new Set(watched);

  function walk(deps) {
    if (!deps || typeof deps !== "object") return;
    for (const [name, node] of Object.entries(deps)) {
      if (node && typeof node === "object") {
        if (watch.has(name) && typeof node.version === "string") {
          if (!seen.has(name)) seen.set(name, new Set());
          seen.get(name).add(node.version);
        }
        walk(node.dependencies);
      }
    }
  }
  walk(tree?.dependencies);

  const duplicates = {};
  for (const [name, versions] of seen) {
    if (versions.size > 1) duplicates[name] = [...versions].sort();
  }
  return duplicates;
}

const EXTRANEOUS_PROBLEM = /^extraneous: (\S+)@(\S+) (.+)$/;

/**
 * An `extraneous:` problem is benign ONLY when package-lock.json itself declares that exact install path as an optional
 * package at that exact version. That is the shape npm produces for an unconstrained optional package (e.g.
 * @img/sharp-wasm32) whose only dependents are platform-gated (freebsd / wasm32) and therefore not installed here:
 * `npm ci` installs it, `npm ls` reports it as extraneous and still exits 0. Anything else (not in the lockfile, not optional,
 * different version, outside the project) stays a blocking problem.
 */
function packageNameAtInstallPath(relativeInstallPath) {
  const parts = relativeInstallPath.split(/[\\/]+/).filter(Boolean);
  let nodeModulesIndex = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === "node_modules") nodeModulesIndex = index;
  }
  if (nodeModulesIndex < 0) return null;

  const first = parts[nodeModulesIndex + 1];
  if (!first || first === "node_modules") return null;
  if (first.startsWith("@")) {
    const second = parts[nodeModulesIndex + 2];
    if (!second || second === "node_modules") return null;
    return `${first}/${second}`;
  }
  return first;
}

export function createOptionalExtraneousCheck(lockPackages, root) {
  return (problem) => {
    const match = typeof problem === "string" ? EXTRANEOUS_PROBLEM.exec(problem) : null;
    if (!match || !lockPackages || typeof lockPackages !== "object" || Array.isArray(lockPackages)) return false;
    const rel = relative(root, match[3]);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
    const lockPath = rel.split(/[\\/]+/).join("/");
    const entry = lockPackages[lockPath];
    const pathPackageName = packageNameAtInstallPath(lockPath);
    return Boolean(
      pathPackageName === match[1]
      && entry
      && typeof entry === "object"
      && !Array.isArray(entry)
      && entry.optional === true
      && entry.version === match[2],
    );
  };
}

/** Splits npm's `problems` into those that must fail the check and those the predicate proves benign. Unknown shapes block. */
export function classifyProblems(tree, isBenignExtraneous = () => false) {
  const raw = tree?.problems;
  if (raw === undefined || raw === null) return { blocking: [], ignored: [] };
  if (!Array.isArray(raw)) return { blocking: ["npm ls reported a malformed `problems` value"], ignored: [] };
  const blocking = [];
  const ignored = [];
  for (const problem of raw) (isBenignExtraneous(problem) ? ignored : blocking).push(String(problem));
  return { blocking, ignored };
}

export function validateNpmTree(tree, exitCode = 0, isBenignExtraneous = () => false) {
  const { blocking } = classifyProblems(tree, isBenignExtraneous);
  if (exitCode !== 0 || blocking.length > 0) {
    const shown = blocking.slice(0, 5);
    if (blocking.length > shown.length) shown.push(`...and ${blocking.length - shown.length} more`);
    const detail = [exitCode !== 0 ? `exit code ${exitCode}` : null, ...shown].filter(Boolean).join("; ");
    throw new Error(`npm ls did not produce a healthy dependency tree (${detail}); refusing to report duplicate checks as passing. Run npm ci and retry.`);
  }
  return tree;
}

/**
 * Turns the outcome of `npm ls --all --json` into a validated tree. Each failure mode keeps its own message so the cause is
 * visible, and every one of them fails closed: npm could not run, no JSON came back, or the tree is unhealthy.
 */
export function parseNpmLsResult({ status = null, stdout = "", startError = null }, { lockPackages = null, root = REPO_ROOT } = {}) {
  if (startError) {
    throw new Error(`could not run npm ls (${startError}); refusing to check duplicates against an unavailable dependency tree.`);
  }
  const text = typeof stdout === "string" ? stdout.trim() : "";
  let tree;
  if (text.startsWith("{")) {
    try { tree = JSON.parse(text); } catch { /* reported below */ }
  }
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    throw new Error(`npm ls produced no valid JSON dependency tree (exit code ${status}); refusing to check duplicates against an unavailable dependency tree. Run npm ci and retry.`);
  }
  if (!tree.dependencies || typeof tree.dependencies !== "object" || Array.isArray(tree.dependencies)) {
    throw new Error(`npm ls produced a malformed JSON dependency tree (exit code ${status}): root \`dependencies\` must be an object; refusing to check duplicates as passing.`);
  }
  const isBenign = createOptionalExtraneousCheck(lockPackages, root);
  validateNpmTree(tree, status, isBenign);
  return { tree, ignored: classifyProblems(tree, isBenign).ignored };
}

function runNpmLs(root) {
  const npmCli = process.platform === "win32" ? process.env.npm_execpath : undefined;
  const command = npmCli ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
  const args = npmCli ? [npmCli, "ls", "--all", "--json"] : ["ls", "--all", "--json"];
  try {
    const stdout = execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: !npmCli && process.platform === "win32",
    });
    return { status: 0, stdout };
  } catch (error) {
    // npm ls can emit a JSON tree on a non-zero exit. It is useful for diagnostics, but it is never evidence of a pass.
    if (typeof error?.status === "number") {
      return { status: error.status, stdout: typeof error.stdout === "string" ? error.stdout : "" };
    }
    return { startError: String(error?.code ?? error?.signal ?? error?.message ?? "unknown error") };
  }
}

function readLockPackages(root) {
  try {
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    return lock && typeof lock.packages === "object" ? lock.packages : null;
  } catch {
    return null; // no lockfile evidence means nothing can be proven benign: every problem blocks
  }
}

function readNpmTree(root = REPO_ROOT) {
  return parseNpmLsResult(runNpmLs(root), { lockPackages: readLockPackages(root), root });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const extra = process.argv.slice(2);
  const watched = extra.length > 0 ? extra : DEFAULT_WATCHED;
  try {
    const { tree, ignored } = readNpmTree();
    if (ignored.length > 0) {
      console.log(`Note: ${ignored.length} extraneous package(s) are declared optional in package-lock.json (their platform-gated parents are not installed on this OS/CPU) and were still scanned for duplicates:`);
      for (const problem of ignored) console.log(`  ${problem.replace(/^extraneous: (\S+) .*$/, "$1")}`);
    }
    const duplicates = findDuplicates(tree, watched);
    const names = Object.keys(duplicates);
    if (names.length > 0) {
      console.error("Duplicate package versions found:");
      for (const name of names) console.error(`  ${name}: ${duplicates[name].join(", ")}`);
      console.error("Pin one version in the workspace manifests and/or add a root `overrides` entry.");
      process.exitCode = 1;
    } else {
      console.log(`No duplicate versions among: ${watched.join(", ")}`);
    }
  } catch (error) {
    console.error(`Dependency duplicate check: ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 1;
  }
}
