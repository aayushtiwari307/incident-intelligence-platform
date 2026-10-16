/** Server-to-server routes. They are NOT parsed by the global JSON parser: the webhook reads its own body with its own limit. */
const WEBHOOK_PATH_PREFIX = "/api/v1/integrations/";

/** Express routing is case-insensitive, so the comparison is too (otherwise a differently-cased path would reach the route unparsed-by-us but pre-consumed). */
export function isWebhookPath(url: string | undefined): boolean {
  const path = (url ?? "").split("?")[0] ?? "";
  return path.toLowerCase().startsWith(WEBHOOK_PATH_PREFIX);
}

/** The global parser's `type` test: application/json only (as before) and never for webhook paths. */
export function globalJsonParserShouldParse(req: { url?: string; headers: Readonly<Record<string, string | string[] | undefined>> }): boolean {
  if (isWebhookPath(req.url)) return false;
  const contentType = req.headers["content-type"];
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return (value ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";
}
