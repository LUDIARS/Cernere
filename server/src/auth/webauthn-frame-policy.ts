/** Validate the signed client-data embedding context before the normal cryptographic verification.
 * @implements SPEC-EMBEDDED-COMPOSITE-001
 */
export function assertWebauthnFrameAllowed(clientDataJSON: string, allowedOrigins: readonly string[], legacyFramePolicyEnabled = false): void {
  const data: unknown = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8"));
  if (!data || typeof data !== "object") throw new Error("Invalid WebAuthn client data");
  const context = data as { crossOrigin?: unknown; topOrigin?: unknown };
  if (context.crossOrigin === undefined || context.crossOrigin === false) return;
  if (context.crossOrigin !== true) throw new Error("Invalid WebAuthn cross origin flag");
  if (allowedOrigins.length === 0) throw new Error("Missing WebAuthn embedding allowlist");
  // Level 2 clients omit topOrigin. The hosted UI's enforced CSP frame-ancestors
  // supplies the embedding boundary; supplied signed topOrigin remains checked.
  if (context.topOrigin === undefined && legacyFramePolicyEnabled) return;
  if (typeof context.topOrigin !== "string") throw new Error("Invalid WebAuthn top origin");
  const top = new URL(context.topOrigin);
  if (top.origin !== context.topOrigin || !allowedOrigins.includes(top.origin)) throw new Error("Untrusted WebAuthn embedding origin");
}
