/** PC enrollment navigation; only local return paths survive the login round trip. */
import { resolveSelfRedirectTarget } from "./composite-auth-handoff";

export const PASSKEY_ENROLLMENT_PATH = "/passkeys/register";

export function passkeyEnrollmentUrl(returnTo: string, origin = window.location.origin): string {
  return `${PASSKEY_ENROLLMENT_PATH}?${new URLSearchParams({ return: resolveSelfRedirectTarget(returnTo, origin) })}`;
}

/** Attachment is a UX hint, never proof that a PC has (or lacks) a credential. */
export function shouldOfferPcEnrollment(attachment: string | null | undefined, mobile: boolean, returnTo: string, origin = window.location.origin): boolean {
  return !mobile && attachment === "cross-platform"
    && new URL(resolveSelfRedirectTarget(returnTo, origin), origin).pathname !== PASSKEY_ENROLLMENT_PATH;
}
