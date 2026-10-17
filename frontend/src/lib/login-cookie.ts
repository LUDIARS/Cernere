const INFRA_COOKIES = new Set(["__cf_bm", "_cfuvid", "cf_clearance", "__cflb", "__cfruid"]);

/** Display hint only. HttpOnly session secrets must never be exposed to JavaScript. */
export function hasLoginCookie(): boolean {
  try {
    return document.cookie.split(";").some(part => {
      const name = part.split("=")[0]?.trim();
      return !!name && !INFRA_COOKIES.has(name);
    });
  } catch { return false; }
}

export function rememberLoginCookie(): void {
  try {
    document.cookie = `cernere_returning=1; Path=/; Max-Age=31536000; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
  } catch { /* Cookie-disabled browsers retain the first-time entry choices. */ }
}
