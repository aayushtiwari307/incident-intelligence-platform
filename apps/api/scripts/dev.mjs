// Development runner for the API without extra dependencies:
//   1. compile once (so dist/main.js exists), 2. keep tsc in watch mode, 3. run dist/main.js and
//   restart it when dist changes. Ctrl+C stops both. Same behaviour in cmd.exe, PowerShell and bash.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const node = process.execPath;

const first = spawnSync(node, [tsc, "-p", "tsconfig.build.json"], { stdio: "inherit" });
if (first.status !== 0) {
  console.error("\nInitial compile failed; fix the errors above and run again.");
  process.exit(first.status ?? 1);
}

const children = [
  spawn(node, [tsc, "-p", "tsconfig.build.json", "--watch", "--preserveWatchOutput"], { stdio: "inherit" }),
  spawn(node, ["--watch-path=dist", "--env-file-if-exists=.env", "dist/main.js"], { stdio: "inherit" }),
];

let stopping = false;
const stop = (code) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 300).unref();
};
for (const child of children) child.on("exit", (code) => stop(code ?? 1));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
