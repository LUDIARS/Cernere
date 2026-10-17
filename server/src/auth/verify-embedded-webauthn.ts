import { verifyAuthenticationResponse as authenticate, verifyRegistrationResponse as register } from "@simplewebauthn/server";
import { config } from "../config.js";
import { assertWebauthnFrameAllowed } from "./webauthn-frame-policy.js";

/** @implements SPEC-EMBEDDED-COMPOSITE-001 */
export function verifyAuthenticationResponse(options: Parameters<typeof authenticate>[0]): ReturnType<typeof authenticate> {
  assertWebauthnFrameAllowed(options.response.response.clientDataJSON, config.compositeAllowedOrigins);
  return authenticate(options);
}

/** @implements SPEC-EMBEDDED-COMPOSITE-001 */
export function verifyRegistrationResponse(options: Parameters<typeof register>[0]): ReturnType<typeof register> {
  assertWebauthnFrameAllowed(options.response.response.clientDataJSON, config.compositeAllowedOrigins);
  return register(options);
}
