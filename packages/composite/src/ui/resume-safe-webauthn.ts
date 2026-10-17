import {
  startAuthentication as authenticate,
  startRegistration as register,
} from "@simplewebauthn/browser";

let activeCeremonies = 0;

export function isWebAuthnActive(): boolean { return activeCeremonies > 0; }

/** Native authenticators can hide the browser while still using this document. */
async function duringCeremony<T>(operation: () => Promise<T>): Promise<T> {
  activeCeremonies++;
  try { return await operation(); }
  finally { activeCeremonies--; }
}

export const startAuthentication: typeof authenticate = (options) =>
  duringCeremony(() => authenticate(options));
export const startRegistration: typeof register = (options) =>
  duringCeremony(() => register(options));
