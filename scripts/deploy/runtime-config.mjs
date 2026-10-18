export function requiredPort(value, fallback, name) {
  const raw = value ?? fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer port`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${name} must be between 1024 and 65535`);
  }
  return String(port);
}

export function apiEnvironment(source = process.env) {
  const origins = new Set(
    (source.CORS_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  if (source.RENDER_EXTERNAL_URL) {
    let url;
    try {
      url = new URL(source.RENDER_EXTERNAL_URL);
    } catch {
      throw new Error("RENDER_EXTERNAL_URL must be a valid HTTPS origin");
    }
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("RENDER_EXTERNAL_URL must be a valid HTTPS origin");
    }
    origins.add(url.origin);
  }

  return {
    ...source,
    API_HOST: "127.0.0.1",
    API_PORT: "3001",
    TRUST_PROXY_HOPS: "1",
    ...(origins.size > 0 ? { CORS_ORIGINS: [...origins].join(",") } : {}),
  };
}
