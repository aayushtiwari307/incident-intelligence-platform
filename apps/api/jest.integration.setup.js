module.exports = async () => {
  // Fail closed before a test can create/drop scratch databases. Never print a complete connection string.
  const isLoopback = (hostname) => {
    const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1") return true;
    const parts = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(host);
    return Boolean(parts && Number(parts[1]) === 127 && parts.slice(1).every((part) => Number(part) <= 255));
  };
  for (const key of ["DATABASE_URL", "TEST_DATABASE_URL"]) {
    const raw = process.env[key];
    if (!raw) {
      if (key === "TEST_DATABASE_URL") throw new Error("TEST_DATABASE_URL is required for integration tests (use a disposable local PostgreSQL server)");
      continue;
    }
    let url;
    try { url = new URL(raw); } catch { throw new Error(`${key} is not a valid URL`); }
    if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || !isLoopback(url.hostname)) {
      throw new Error(`${key} must use a loopback PostgreSQL host; integration tests will not use remote or production databases`);
    }
  }
};
