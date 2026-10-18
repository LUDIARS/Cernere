/** Authentication and bearer destinations must be configured origins, never redirects. */
export function serviceOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("An HTTPS or loopback HTTP origin is required");
  }
  return url.origin;
}
