// Calls the API health endpoints and prints one line each. Exit code 1 if either is not 200.
// Usage: npm run health            (default http://127.0.0.1:3001)
//        npm run health -- http://127.0.0.1:3001
const base = (process.argv[2] ?? process.env.API_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
let failed = false;
for (const route of ["/health/live", "/health/ready"]) {
  try {
    const res = await fetch(base + route, { signal: AbortSignal.timeout(5000) });
    console.log(`${res.status === 200 ? "OK  " : "FAIL"} ${res.status} ${base}${route} ${await res.text()}`);
    if (res.status !== 200) failed = true;
  } catch (error) {
    console.log(`FAIL --- ${base}${route} ${error instanceof Error ? error.message : error}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
