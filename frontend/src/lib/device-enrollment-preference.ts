/** Browser-local display preference only; never an authentication or enrollment proof. */
export function isDeviceEnrollmentDismissed(): boolean {
  try {
    return document.cookie.split(";").some(part => part.trim() === "cernere_hide_device_enrollment=1");
  } catch { return false; /* Cookie-disabled browsers keep showing the optional prompt. */ }
}

export function setDeviceEnrollmentDismissed(dismissed: boolean): void {
  try {
    document.cookie = `cernere_hide_device_enrollment=${dismissed ? "1" : ""}; Path=/; Max-Age=${dismissed ? 31536000 : 0}; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
  } catch { /* Optional display preference cannot prevent login in cookie-disabled browsers. */ }
}
