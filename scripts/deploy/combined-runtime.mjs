import { spawn } from "node:child_process";
import { apiEnvironment, requiredPort } from "./runtime-config.mjs";

const APP_ROOT = "/app";
const STARTUP_TIMEOUT_MS = 90_000;
const SHUTDOWN_TIMEOUT_MS = 8_000;
const API_PORT = "3001";
const WEB_PORT = "3000";

const children = new Map();
let stopping = false;
let shutdownPromise;

function startChild(name, command, args, env) {
  console.log(`starting managed process ${name}: ${command}`);

  const child = spawn(command, args, {
    cwd: APP_ROOT,
    env,
    stdio: "inherit",
  });
  const record = {
    child,
    closed: new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
  };
  children.set(name, record);
  child.once("error", (error) => {
    console.error(
      `managed process ${name} failed to start: ${error.message}`,
    );
    console.error(
      `process details: name=${name}, command=${command}, code=${error.code ?? "unknown"}, syscall=${error.syscall ?? "unknown"}`,
    );
  });
  child.once("close", (code, signal) => {
    if (stopping) return;
    console.error(
      `managed process ${name} exited unexpectedly (code=${code}, signal=${signal})`,
    );
    void shutdown(1, "SIGTERM");
  });
  return record;
}

async function shutdown(code, signal) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    const active = [...children.values()].filter(
      ({ child }) => child.exitCode === null,
    );
    for (const { child } of active) child.kill(signal);

    let timeout;
    const timedOut = new Promise((resolve) => {
      timeout = setTimeout(() => resolve(true), SHUTDOWN_TIMEOUT_MS);
    });
    const closed = Promise.all(active.map(({ closed }) => closed)).then(
      () => false,
    );
    if (await Promise.race([closed, timedOut])) {
      console.error(
        "managed processes exceeded the graceful shutdown deadline; forcing termination",
      );
      for (const { child } of active) {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      await Promise.all(active.map(({ closed }) => closed));
    }
    clearTimeout(timeout);
    process.exitCode = code;
  })();
  return shutdownPromise;
}

async function checkReady(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServices() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  console.log(
    "waiting for API liveness and the web server before opening the public listener",
  );
  while (Date.now() < deadline) {
    if (stopping)
      throw new Error("startup interrupted while stopping managed processes");
    const [apiReady, webReady] = await Promise.all([
      checkReady(`http://127.0.0.1:${API_PORT}/health/live`),
      checkReady(`http://127.0.0.1:${WEB_PORT}/login`),
    ]);
    if (apiReady && webReady) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    "API and web server did not become healthy before the startup deadline",
  );
}

async function main() {
  const publicPort = requiredPort(process.env.PORT, "10000", "PORT");
  const apiEnv = apiEnvironment();
  const webEnv = {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: WEB_PORT,
  };

  startChild(
    "API",
    process.execPath,
    [`${APP_ROOT}/apps/api/dist/main.js`],
    apiEnv,
  );
  startChild(
    "web",
    process.execPath,
    [`${APP_ROOT}/apps/web/server.js`],
    webEnv,
  );
  await waitForServices();

  startChild(
    "Caddy",
    "/usr/bin/caddy",
    [
      "run",
      "--config",
      `${APP_ROOT}/deploy/render/Caddyfile`,
      "--adapter",
      "caddyfile",
    ],
    { ...process.env, PORT: publicPort },
  );
  console.log(`public reverse proxy started on port ${publicPort}`);

  await Promise.all([...children.values()].map(({ closed }) => closed));
  if (!stopping) {
    console.error("a managed process exited unexpectedly");
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`received ${signal}; shutting down managed processes`);
    void shutdown(0, signal);
  });
}

main().catch(async (error) => {
  console.error(
    `combined runtime startup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  await shutdown(1, "SIGTERM");
});