/** Administrator-owned Composite origins are canonical origins, never redirect URLs. */
export function isOriginAllowed(target: string | null | undefined, allowedOrigins: readonly string[]): boolean {
  if (!target) return false;
  try {
    const url = new URL(target);
    return !url.username && !url.password && url.origin !== "null" && allowedOrigins.includes(url.origin);
  } catch { return false; }
}

export function isCompositeOrigin(value: unknown, projectKey: string, development = false): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || url.hostname.includes("*")) return false;
    const loopback = url.hostname === "localhost" || url.hostname.endsWith(".localhost")
      || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if (development && projectKey === "cernere-test") return url.protocol === "https:" || url.protocol === "http:";
    return url.protocol === "https:" && !loopback;
  } catch { return false; }
}

export function declaredCompositeOrigins(definition: unknown, projectKey: string, development = false): string[] {
  if (!definition || typeof definition !== "object") return [];
  const origins = (definition as { composite_origins?: unknown }).composite_origins;
  if (!Array.isArray(origins) || !origins.every(origin => isCompositeOrigin(origin, projectKey, development))) return [];
  return [...new Set(origins)];
}
