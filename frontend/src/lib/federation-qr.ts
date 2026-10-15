/**
 * 引き継ぎの QR の中身 (account-federation §4)。QR は /federate/approve#t=<token> (新しい端末が出す) か
 * /federate/join#t=<token> (使っている端末が出す招待) の URL。
 */

/** QR / URL の fragment (#t=) から token を取り出す。URL でなく token そのものでもよい。 */
export function readJoinToken(value: string, base: string = globalThis.location?.origin ?? "https://cernere.invalid"): string | null {
  const text = value.trim();
  if (!text) return null;
  if (/^[A-Za-z0-9_-]{16,512}$/.test(text)) return text;
  try {
    const url = new URL(text, base);
    const token = new URLSearchParams(url.hash.replace(/^#/, "")).get("t") ?? url.searchParams.get("t");
    return token && /^[A-Za-z0-9_-]{16,512}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** QR の URL の行き先。読んだ QR が承認する側用か加わる側用かを見分ける。 */
export function joinUrlKind(value: string, base: string = globalThis.location?.origin ?? "https://cernere.invalid"): "approve" | "join" | null {
  try {
    const url = new URL(value.trim(), base);
    if (url.pathname.endsWith("/federate/approve")) return "approve";
    if (url.pathname.endsWith("/federate/join")) return "join";
  } catch { /* URL でない */ }
  return null;
}
