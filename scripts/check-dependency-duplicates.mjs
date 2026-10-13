#!/usr/bin/env node
// Fails if more than one version of a watched package is installed anywhere in the tree.
//
// Why: the reference project's Vite dev server problem coincided with two Vite majors
// (8.x hoisted at the root, 7.x inside the frontend workspace) being resolved by different
// parts of the toolchain. We cannot prove that was the cause, but "two copies of one
// toolchain package" is a defect class worth failing CI on, especially for React,
// React DOM and TypeScript.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

function readNpmTree() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    const out = execFileSync(npm, ["ls", "--all", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    return JSON.parse(out);
  } catch (error) {
    // `npm ls` exits non-zero on tree problems but still prints the JSON tree.
    if (error && typeof error.stdout === "string" && error.stdout.trim().startsWith("{")) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const extra = process.argv.slice(2);
  const watched = extra.length > 0 ? extra : DEFAULT_WATCHED;
  const duplicates = findDuplicates(readNpmTree(), watched);
  const names = Object.keys(duplicates);
  if (names.length > 0) {
    console.error("Duplicate package versions found:");
    for (const name of names) console.error(`  ${name}: ${duplicates[name].join(", ")}`);
    console.error("Pin one version in the workspace manifests and/or add a root `overrides` entry.");
    process.exit(1);
  }
  console.log(`No duplicate versions among: ${watched.join(", ")}`);
}
