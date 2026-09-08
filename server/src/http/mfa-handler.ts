/** MFA HTTP contracts; never treat challenge tickets as user credentials. @implements SPEC-MFA-CHALLENGE */
import { AppError } from "../error.js";
import { extractBearerToken, verifyToken } from "../auth/jwt.js";
import { httpActionBinding } from "../auth/action-proof.js";
import { parseMfaInput, requireMfaMethod } from "../auth/mfa-contract.js";
import { sendMfaChallengeCode, verifyMfaChallenge, issueMfaLogin } from "../auth/mfa-challenge.js";
import { mfaStatus, beginMfaManagement, verifyMfaManagement, setupTotp, setupEmailMfa, changeMfaFactor,
  type MfaActor } from "../auth/mfa-settings.js";

async function requireActor(header: string, actionProof?: string): Promise<MfaActor> {
  const token = extractBearerToken(header);
  if (!token) throw AppError.unauthorized("User authentication required");
  return { userId: (await verifyToken(token)).sub, token, actionProof };
}

export async function handleMfaRoute(action: string, body: unknown, authHeader: string, actionProof?: string): Promise<unknown> {
  const p = parseMfaInput(body);
  if (action === "send-code") {
    await sendMfaChallengeCode(p.mfaToken ?? "", requireMfaMethod(p.method), { purpose: "rest" });
    return { sent: true };
  }
  if (action === "verify") return verifyMfaChallenge(p.mfaToken ?? "", requireMfaMethod(p.method), p.code ?? "", { purpose: "rest" }, issueMfaLogin);
  const actor = await requireActor(authHeader, actionProof);
  switch (action) {
    case "status": return mfaStatus(actor.userId);
    case "manage/begin": return beginMfaManagement(actor, p.password);
    case "manage/verify": return verifyMfaManagement(actor, p.mfaToken ?? "", requireMfaMethod(p.method), p.code ?? "");
    case "manage/send-code":
      await sendMfaChallengeCode(p.mfaToken ?? "", requireMfaMethod(p.method), { purpose: "manage", binding: httpActionBinding(actor.token) });
      return { sent: true };
    case "totp/setup": return setupTotp(actor, p.managementToken ?? "");
    case "email/setup":
      await setupEmailMfa(actor, p.managementToken ?? "");
      return { sent: true };
    case "totp/enable": case "totp/disable": case "email/enable": case "email/disable": {
      const method = action.startsWith("totp/") ? "totp" : "email";
      await changeMfaFactor(actor, p.managementToken ?? "", method, action.endsWith("/enable"), p.code);
      return { updated: true };
    }
    default: throw AppError.notFound("Unknown MFA action");
  }
}
