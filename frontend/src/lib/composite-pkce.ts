/** A self login owns its verifier in memory; service verifiers stay in the service page. */
export interface PkceRequest { codeVerifier: string; codeChallenge: string }
export interface CompositeLoginRequest { client_id: string; code_challenge: string; state: string; code_audience?: "kiosk" }
import { createCompositePkce } from "@ludiars/cernere-composite/ui";

export async function createPkceRequest(): Promise<PkceRequest> {
  return createCompositePkce();
}

export function readCompositeLoginRequest(search: string): CompositeLoginRequest | null {
  const params = new URLSearchParams(search);
  const client_id = params.get("client_id") ?? "";
  const code_challenge = params.get("code_challenge") ?? "";
  const state = params.get("state") ?? "";
  if (!client_id || !/^[A-Za-z0-9_-]{43}$/.test(code_challenge) || !/^[A-Za-z0-9_-]{32,512}$/.test(state)) return null;
  return { client_id, code_challenge, state, ...(params.get("code_audience") === "kiosk" ? { code_audience: "kiosk" as const } : {}) };
}
