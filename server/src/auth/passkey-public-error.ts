/** User-safe errors that may cross the project WebSocket authentication boundary. */

const PUBLIC_PASSKEY_MESSAGES = [
  /^Rate limit exceeded\. Please try again later\.$/,
  /^A valid name \(and optional email\) is required$/,
  /^Registration failed\. Please check your input and try again\.$/,
  /^signupId and response are required$/,
  /^response is required$/,
  /^challengeOwner is required$/,
  /^Challenge expired or missing (?:-|—) please retry$/,
  /^Passkey registration failed verification$/,
  /^Unauthorized: passkey (?:not registered|signature failed)$/,
  /^Account creation completed, but sign-in completion failed\. Return to login and use your new passkey\.$/,
] as const;

/**
 * Preserve deliberate client guidance while suppressing infrastructure and persistence details.
 * @implements SPEC-COMPOSITE-PASSKEY-PUBLIC-ERRORS
 */
export function publicPasskeyCompositeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "";
  if (PUBLIC_PASSKEY_MESSAGES.some((pattern) => pattern.test(message))) {
    return error as Error;
  }
  return new Error("Passkey authentication failed");
}
