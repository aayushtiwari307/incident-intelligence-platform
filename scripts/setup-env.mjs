// Creates the three local environment files from their .example templates, with freshly generated
// database password that matches across files. Never overwrites an existing file and never prints
// a password. No dependencies, works the same in cmd.exe, PowerShell and bash.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = "dev_only_change_me";

/** Pure: given template text and two passwords, returns the content of the three files. */
export function buildEnvFiles(templates, postgresPassword) {
  const replaceLine = (text, key, fn) =>
    text.replace(new RegExp(`^(${key}=)(.*)$`, "m"), (_, prefix, value) => prefix + fn(value));
  const root = replaceLine(templates.root, "POSTGRES_PASSWORD", () => postgresPassword);
  const api = replaceLine(templates.api, "DATABASE_URL", (v) => v.split(PLACEHOLDER).join(postgresPassword));
  return { root, api, web: templates.web };
}

const newPassword = () => randomBytes(24).toString("hex"); // URL-safe: no characters that need escaping

function main() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = {
    root: [".env.example", ".env"],
    api: ["apps/api/.env.example", "apps/api/.env"],
    web: ["apps/web/.env.example", "apps/web/.env.local"],
  };
  const read = (rel) => readFileSync(path.join(repo, rel), "utf8");
  const targets = Object.values(files).map(([, target]) => target);
  const existing = targets.filter((t) => existsSync(path.join(repo, t)));

  // The passwords in the root .env and apps/api/.env must match, so either create both or neither.
  if (existing.includes(".env") !== existing.includes("apps/api/.env")) {
    console.error(
      "Only one of .env and apps/api/.env exists, so new passwords could not be kept consistent.\n" +
        "Delete the one that exists (or fix both by hand) and run again.",
    );
    process.exit(1);
  }

  const built = buildEnvFiles(
    { root: read(files.root[0]), api: read(files.api[0]), web: read(files.web[0]) },
    newPassword(),
  );
  for (const [name, [, target]] of Object.entries(files)) {
    if (existsSync(path.join(repo, target))) {
      console.log(`skipped  ${target} (already exists, not modified)`);
    } else {
      writeFileSync(path.join(repo, target), built[name], { flag: "wx" });
      console.log(`created  ${target}`);
    }
  }
  console.log("\nIf you had already started the containers with other passwords, run: npm run services:reset");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
