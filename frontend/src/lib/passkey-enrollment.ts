/** PC enrollment navigation; only local return paths survive the login round trip. */
import { resolveSelfRedirectTarget } from "./composite-auth-handoff";
import { hasRegisteredPasskeyCookie } from "./login-cookie";
import { isDeviceEnrollmentDismissed } from "./device-enrollment-preference";

export const PASSKEY_ENROLLMENT_PATH = "/passkeys/register";

/** A one-navigation UI hint prevents skipping from looping back into enrollment. */
export function skipDeviceEnrollmentUrl(returnTo: string, origin = window.location.origin): string {
  const target = new URL(resolveSelfRedirectTarget(returnTo, origin), origin);
  if (target.pathname === "/composite/login" || target.pathname === "/login") {
    target.searchParams.set("device_add_skipped", "1");
  }
  return `${target.pathname}${target.search}${target.hash}`;
}

export function passkeyEnrollmentUrl(returnTo: string, origin = window.location.origin): string {
  return `${PASSKEY_ENROLLMENT_PATH}?${new URLSearchParams({ return: resolveSelfRedirectTarget(returnTo, origin) })}`;
}

/** Attachment is a UX hint, never proof that a PC has (or lacks) a credential. */
export function shouldOfferPcEnrollment(attachment: string | null | undefined, mobile: boolean, returnTo: string, origin = window.location.origin, requested = false): boolean {
  return !mobile && (requested || attachment === "cross-platform")
    && !hasRegisteredPasskeyCookie() && !isDeviceEnrollmentDismissed()
    && new URL(resolveSelfRedirectTarget(returnTo, origin), origin).pathname !== PASSKEY_ENROLLMENT_PATH;
}
