/**
 * WS module "signup_fields" — オンボーディングの最初の手順で、ログイン先サービスの入力項目を聞く (設計書 §4.2)。
 *
 *   signup_fields.for_return  { returnTo }            戻り先 (Cernere 内パス) からサービスを解決し、
 *                                                     公開情報 (名前・聞く項目) と本人の入力状況を返す。
 *                                                     解決できなければ null
 *   signup_fields.save        { projectKey, fields }  聞いた項目を保存する。誤りは { fieldErrors } (何も保存しない)
 *
 * どちらも本人の WS セッションで、本人の行だけを読み書きする。
 */

import { z } from "zod";
import { AppError } from "../error.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { resolveProjectSubject, resolveSubjectByOrigin, type ResolvedConsentSubject } from "../consent/project-resolver.js";
import { getConsentRecord } from "../consent/store.js";
import { SignupFieldsInvalidError } from "./errors.js";
import { evaluateSignupFieldsForUser } from "./evaluate.js";
import type { SignupFieldsRequirement } from "./requirement.js";
import { returnTargetOf } from "./return-target.js";
import { saveSignupFields } from "./submission.js";

const forReturnSchema = z.object({ returnTo: z.string().max(4096) }).strict();
const saveSchema = z.object({
  projectKey: z.string().min(1).max(128),
  fields: z.record(z.string().max(128), z.unknown()),
}).strict();

export interface SignupFieldsForService {
  projectKey: string;
  serviceName: string;
  version: number;
  fields: SignupFieldsRequirement["fields"];
  missingRequired: string[];
}

function view(resolved: ResolvedConsentSubject, requirement: SignupFieldsRequirement): SignupFieldsForService {
  return {
    projectKey: resolved.subject.key,
    serviceName: resolved.name,
    version: requirement.version,
    fields: requirement.fields,
    missingRequired: requirement.missingRequired,
  };
}

async function forReturn(userId: string, returnTo: string): Promise<SignupFieldsForService | null> {
  const target = returnTargetOf(returnTo);
  if (!target) return null;
  const resolved = await resolveSubjectByOrigin(target);
  if (!resolved?.signupFields) return null;
  const record = await getConsentRecord(userId, resolved.subject);
  return view(resolved, await evaluateSignupFieldsForUser(userId, resolved, record));
}

export async function signupFieldsCommand(userId: string, action: string, payload?: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case "for_return": {
      const parsed = forReturnSchema.safeParse(payload ?? {});
      if (!parsed.success) throw AppError.badRequest("returnTo is required");
      return forReturn(userId, parsed.data.returnTo);
    }
    case "save": {
      const parsed = saveSchema.safeParse(payload ?? {});
      if (!parsed.success) throw AppError.badRequest("projectKey and fields are required");
      const resolved = await resolveProjectSubject(parsed.data.projectKey);
      if (!resolved?.signupFields) throw AppError.notFound("This service does not ask for sign-up fields");
      try {
        const requirement = await saveSignupFields(userId, resolved, parsed.data.fields);
        logAuthEvent({ event: "signup_fields.saved", userId, projectKey: resolved.subject.key });
        return { ok: true, ...view(resolved, requirement) };
      } catch (error) {
        // WS のエラー応答は message しか運べないので、項目ごとの誤りは通常の応答で返す。
        if (error instanceof SignupFieldsInvalidError) return { ok: false, fieldErrors: error.fieldErrors };
        throw error;
      }
    }
    default:
      throw AppError.badRequest(`Unknown signup_fields action: ${action}`);
  }
}
