/** Browser storage for native Cr authentication; device secrets remain in HttpOnly cookies. */
let deviceAccessToken: string | null = null;
const KIND_KEY = "cernere_session_kind";
export function usesDeviceSession(): boolean { return localStorage.getItem(KIND_KEY) === "device"; }
export function getAccessToken(): string | null { return usesDeviceSession() ? deviceAccessToken : localStorage.getItem("accessToken"); }
export function getRefreshToken(): string | null { return usesDeviceSession() ? null : localStorage.getItem("refreshToken"); }
export function setTokens(access: string, refresh: string): void {
  if (!refresh) {
    deviceAccessToken = access;
    localStorage.setItem(KIND_KEY, "device");
    localStorage.removeItem("accessToken");
    localStorage.removeItem("refreshToken");
  } else {
    deviceAccessToken = null;
    localStorage.setItem(KIND_KEY, "legacy");
    localStorage.setItem("accessToken", access);
    localStorage.setItem("refreshToken", refresh);
  }
  localStorage.setItem("cernere_returning", "1");
}
export function clearTokens(): void {
  deviceAccessToken = null;
  localStorage.removeItem(KIND_KEY);
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  localStorage.removeItem("user");
  sessionStorage.removeItem("cernere_rotation_id");
}
