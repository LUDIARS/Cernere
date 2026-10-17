/** Display hint only. HttpOnly session secrets must never be exposed to JavaScript. */
export function hasLoginCookie(): boolean {
  try {
    return document.cookie.split(";").some(part => {
      return part.trim() === "cernere_returning=1";
    });
  } catch { return false; }
}

export function rememberLoginCookie(): void {
  try {
    document.cookie = `cernere_returning=1; Path=/; Max-Age=31536000; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
  } catch { /* Cookie-disabled browsers retain the first-time entry choices. */ }
}
