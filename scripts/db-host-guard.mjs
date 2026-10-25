/** Shared safety checks for local-only backup/restore scripts. Never include the URL in errors or logs. */
export function isLoopbackHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const octets = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(host);
  return Boolean(octets && Number(octets[1]) === 127 && octets.slice(1).every((part) => Number(part) <= 255));
}

export function parseDatabaseTarget(connectionString, { allowNonLocal = false } = {}) {
  let url;
  try { url = new URL(connectionString); } catch { throw new Error("DATABASE_URL must be a valid PostgreSQL URL"); }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  if (!url.hostname || !url.pathname || url.pathname === "/") throw new Error("DATABASE_URL must include a database name");
  if (!allowNonLocal && !isLoopbackHost(url.hostname)) throw new Error("Refusing a non-local database target. Use a disposable loopback PostgreSQL database.");
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode && !["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(sslmode)) {
    throw new Error("DATABASE_URL contains an unsupported sslmode value");
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port || "5432",
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ...(sslmode ? { sslmode } : {}),
  };
}

export function pgToolEnvironment(connectionString, { allowNonLocal = false, base = process.env } = {}) {
  const target = parseDatabaseTarget(connectionString, { allowNonLocal });
  return {
    ...base,
    PGHOST: target.host,
    PGPORT: target.port,
    PGDATABASE: target.database,
    ...(target.user ? { PGUSER: target.user } : {}),
    ...(target.password ? { PGPASSWORD: target.password } : {}),
    ...(target.sslmode ? { PGSSLMODE: target.sslmode } : {}),
  };
}
