/** Resolve only an explicitly injected loopback management endpoint. Never guess a port. */
export function resolveVaultEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const raw = env.EXCUBITOR_URL;
    if (!raw && (!env.EXCUBITOR_PORT || !/^\d+$/.test(env.EXCUBITOR_PORT))) throw new Error();
    const url = new URL(raw || `http://127.0.0.1:${env.EXCUBITOR_PORT}`);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || url.port === "0") throw new Error();
    return url.origin;
  } catch {
    // URL parser exceptions can echo credentials embedded in malformed configuration.
    throw new Error("Set EXCUBITOR_URL or EXCUBITOR_PORT to the loopback Excubitor management endpoint");
  }
}
