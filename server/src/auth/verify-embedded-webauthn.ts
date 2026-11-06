import { verifyAuthenticationResponse as authenticate, verifyRegistrationResponse as register } from "@simplewebauthn/server";
import { config } from "../config.js";
import { assertWebauthnFrameAllowed } from "./webauthn-frame-policy.js";
import { compositeAllowedOrigins } from "./composite-redirect.js";

/** @implements SPEC-EMBEDDED-COMPOSITE-001 */
export async function verifyAuthenticationResponse(options: Parameters<typeof authenticate>[0], projectEmbeddingOrigins?: readonly string[]): ReturnType<typeof authenticate> {
  assertWebauthnFrameAllowed(options.response.response.clientDataJSON, await compositeAllowedOrigins(), config.webauthnLegacyFramePolicyEnabled);
  const result = await authenticate(options);
  // Only verified clientData can establish the project embedding context. Unlike
  // the legacy hosted-frame gate, this check requires an explicit signed topOrigin.
  if (result.verified && projectEmbeddingOrigins) {
    assertWebauthnFrameAllowed(options.response.response.clientDataJSON, projectEmbeddingOrigins);
  }
  return result;
}

/** @implements SPEC-EMBEDDED-COMPOSITE-001 */
export async function verifyRegistrationResponse(options: Parameters<typeof register>[0]): ReturnType<typeof register> {
  assertWebauthnFrameAllowed(options.response.response.clientDataJSON, await compositeAllowedOrigins(), config.webauthnLegacyFramePolicyEnabled);
  return register(options);
}
