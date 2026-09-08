/**
 * プロジェクト WS コマンドディスパッチャ
 *
 * プロジェクト (Schedula 等) が Cernere 経由で実行できるコマンドを定義する。
 * ユーザー WS の dispatch とは別管理 — プロジェクトは userId を明示指定し、
 * 共通プロフィールは管理者が許可したユーザーと項目に限定する。
 */

import { getServiceProfile, updateServiceProfile } from "../project/profile-service.js";

const VOLPUTAS_PROJECT_KEY = "volputas";

function requireStr(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v) {
    throw new Error(`Missing or invalid field: ${key}`);
  }
  return v;
}

export async function dispatchProjectCommand(
  projectKey: string,
  module: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  switch (`${module}.${action}`) {
    case "profile.get":
      return getServiceProfile(projectKey, payload);
    case "profile.update":
      return updateServiceProfile(projectKey, payload);
    // ─── edge assertion (Cloudflare Access バイパス、 spec/feature/edge-assertion-login.md) ───
    // Hub から生アサーションを受け取り、 Cernere 自身が CF の JWKS で検証する。
    // Hub の主張は信用しない。 REST は生やさず project WS 限定にしてある。
    case "auth.edge_assertion": {
      const { authenticateEdgeAssertion, EdgeAssertionError } = await import("../auth/edge-assertion.js");
      const { ensureUserProjectRow } = await import("../project/service.js");
      // payload の形の検査は try の外。 内側に置くと下の catch が握り潰してしまう。
      const assertion = requireStr(payload, "assertion");
      const cfAuthorization = typeof payload.cfAuthorization === "string"
        ? payload.cfAuthorization
        : undefined;
      try {
        const result = await authenticateEdgeAssertion({ projectKey, assertion, cfAuthorization });
        // composite と同じく、 認証成立時に project_data_<key> の行を確保する。
        await ensureUserProjectRow(result.userId, projectKey);
        return { authCode: result.authCode, groups: result.groups };
      } catch (err) {
        if (err instanceof EdgeAssertionError) {
          throw new Error(`edge_assertion_rejected: ${err.reason}`);
        }
        // project WS のエラーは message がそのままクライアントへ返る。 想定外の失敗
        // (DB 制約違反等) の生メッセージで内部構造を晒さないよう、 ここで潰す。
        console.error("[edge_assertion] unexpected failure:",
          err instanceof Error ? err.message : err);
        throw new Error("edge_assertion_rejected: internal");
      }
    }
    // ─── auth (embedded SPA login for mobile; CORS-free via project WS) ───
    case "auth.login":
    case "auth.register":
    case "auth.mfa-verify":
    case "auth.mfa-send-code": {
      const { executeCompositeAction } = await import("../http/composite-handler.js");
      // projectKey を ctx に載せて、認証完了時に project_data_<key> へ
      // 行を初期化できるようにする (ensureUserProjectRow).
      return executeCompositeAction(
        action as "login" | "register" | "mfa-verify" | "mfa-send-code",
        payload,
        { projectKey },
      );
    }
    // ─── auth.passkey-* (埋め込み SDK のパスキー ceremony; CORS-free via project WS) ───
    // begin は WebAuthn options、 finish は authCode を返す。 WebAuthn の origin 検証は
    // Cernere 側 (composite 許可 origin) で行うので、 サービスは中継するだけでよい。
    // レート制限は認証済み WS に bind された projectKey を使う。payload の clientIp は
    // サービスが任意に詐称できるため、security boundary には使わず ceremony からも除く。
    case "auth.passkey-login-begin":
    case "auth.passkey-login-finish":
    case "auth.passkey-signup-begin":
    case "auth.passkey-signup-finish": {
      const { executePasskeyCompositeAction, isPasskeyCompositeAction } =
        await import("../http/passkey-handler.js");
      if (!isPasskeyCompositeAction(action)) {
        throw new Error(`Unknown passkey action: ${action}`);
      }
      const ceremony = { ...payload };
      delete ceremony.clientIp;
      return executePasskeyCompositeAction(action, ceremony, {
        projectKey,
      });
    }
    // ─── managed_project: project_data_{key} へのユーザーデータアクセス ───
    // projectKey は WS セッションで bind される。targetProjectKey を省略した操作は
    // 常に自己 project に限定し、別 project の read/write は data_sharing grant を
    // fail-closed で検査する。delete は引き続き自己 project のみ。
    case "managed_project.get_user_data": {
      const userId = requireStr(payload, "userId");
      const columns = Array.isArray(payload.columns) ? payload.columns as string[] : undefined;
      const targetProjectKey = typeof payload.targetProjectKey === "string"
        ? payload.targetProjectKey
        : undefined;

      // targetProjectKey が自分自身と異なる場合のみ、他プロジェクトの data_sharing
      // 許可を経由するクロスプロジェクト読み取りに回す。省略時/自分自身の場合は
      // 既存の自己データ読み取りのまま (挙動変更なし)。
      if (targetProjectKey && targetProjectKey !== projectKey) {
        const { getSharedUserColumns } = await import("../project/data-sharing.js");
        return getSharedUserColumns(projectKey, targetProjectKey, userId, columns);
      }

      const svc = await import("../project/service.js");
      return svc.getUserColumns(projectKey, userId, columns);
    }
    case "managed_project.set_user_data": {
      const svc = await import("../project/service.js");
      const userId = requireStr(payload, "userId");
      const data = payload.data as Record<string, unknown> | undefined;
      if (!data || typeof data !== "object") {
        throw new Error("Missing or invalid field: data");
      }
      const targetProjectKey = typeof payload.targetProjectKey === "string"
        ? payload.targetProjectKey
        : undefined;
      if (targetProjectKey && targetProjectKey !== projectKey) {
        const { setSharedUserColumns } = await import("../project/data-sharing.js");
        return setSharedUserColumns(projectKey, targetProjectKey, userId, data);
      }
      return svc.setUserData(projectKey, userId, data);
    }
    case "managed_project.delete_user_data": {
      const svc = await import("../project/service.js");
      const userId = requireStr(payload, "userId");
      const columns = Array.isArray(payload.columns) ? payload.columns as string[] : [];
      return svc.deleteUserColumns(projectKey, userId, columns);
    }
    // プロジェクトスキーマ更新 (Schedula の SDK loader が起動時に呼ぶ想定)
    case "managed_project.update_schema": {
      const svc = await import("../project/service.js");
      // payload 全体が ProjectDefinition (key は WS セッション固定と整合チェック)
      if (payload.key && payload.key !== projectKey) {
        throw new Error("project key mismatch");
      }
      // 管理者所有フィールドはプロジェクト側の自己申告で書き換えさせない。
      // identity_claims を自己付与できると、プロジェクトが users の identity 列を
      // 勝手に開示対象にできてしまうため data_sharing と同じ扱いにする。
      const adminOwnedFields = ["data_sharing", "identity_claims", "profile_access"] as const;
      const submittedAdminOwned = adminOwnedFields.filter(
        (f) => Object.prototype.hasOwnProperty.call(payload, f),
      );
      const projectOwnedPayload = { ...payload };
      for (const field of adminOwnedFields) delete projectOwnedPayload[field];
      const protectedDef = {
        ...projectOwnedPayload,
        project: { ...(projectOwnedPayload.project as object ?? {}), key: projectKey },
      };
      // project client の schema auto-sync では管理者所有の data_sharing を保存対象から
      // 外す。updateProjectSchema の partial-update semantics が現行 grant を保持する。
      const result = await svc.updateProjectSchema(projectKey, protectedDef, undefined);
      return submittedAdminOwned.length > 0
        ? { ...result, adminOwnedFieldsPreserved: submittedAdminOwned }
        : result;
    }
    // ─── OAuth token storage (個人データ保管禁止ルールの基盤) ───
    case "managed_project.store_oauth_token": {
      const svc = await import("../project/service.js");
      const userId = requireStr(payload, "userId");
      const provider = requireStr(payload, "provider");
      return svc.storeOAuthToken(projectKey, userId, {
        provider,
        accessToken: (payload.accessToken ?? null) as string | null,
        refreshToken: (payload.refreshToken ?? null) as string | null,
        expiresAt: (payload.expiresAt ?? null) as string | null,
        tokenType: (payload.tokenType ?? null) as string | null,
        scope: (payload.scope ?? null) as string | null,
        metadata: (payload.metadata ?? {}) as Record<string, unknown>,
      });
    }
    case "managed_project.get_oauth_token": {
      const svc = await import("../project/service.js");
      const userId = requireStr(payload, "userId");
      const provider = requireStr(payload, "provider");
      return svc.getOAuthToken(projectKey, userId, provider);
    }
    case "managed_project.list_oauth_tokens": {
      const svc = await import("../project/service.js");
      const userId = requireStr(payload, "userId");
      return svc.listOAuthTokens(projectKey, userId);
    }
    case "managed_project.delete_oauth_token": {
      const svc = await import("../project/service.js");
      const userId = requireStr(payload, "userId");
      const provider = requireStr(payload, "provider");
      return svc.deleteOAuthToken(projectKey, userId, provider);
    }
    // ─── service adapter — peer から渡された project token をリモート検証 ───
    //
    // 旧 get_jwks (RS256 + ローカル検証) は廃止. peer 側は token を
    // Cernere に投げて { valid, projectKey, clientId } を取得する.
    case "managed_project.verify_token": {
      const token = requireStr(payload, "token");
      const { resolveProjectWsAuth } = await import("./project-handler.js");
      try {
        const claims = await resolveProjectWsAuth(token);
        if (!claims) return { valid: false };
        return {
          valid: true,
          projectKey: claims.projectKey,
          clientId: claims.sub,
          exp: claims.exp,
        };
      } catch {
        return { valid: false };
      }
    }
    // ─── Volputas survey responses ────────────────────────────────────────
    // The project key is bound to the authenticated WS connection. Only the
    // Volputas service may access the response store it delegates to Cernere.
    case "volputas_survey.list_response_statuses": {
      requireVolputasProject(projectKey);
      const service = await import("../project/volputas-survey-response.js");
      return service.listResponseStatuses(payload);
    }
    case "volputas_survey.get_response": {
      requireVolputasProject(projectKey);
      const service = await import("../project/volputas-survey-response.js");
      return service.getResponse(payload);
    }
    case "volputas_survey.save_response": {
      requireVolputasProject(projectKey);
      const service = await import("../project/volputas-survey-response.js");
      return service.saveResponse(payload);
    }
    // ─── identity claim / 横断検索 ───
    //
    // users 側の identity 列 (discord_id 等) と「条件に合うユーザの列挙」を、
    // サービス名に依存しない形で提供する。可否は managed_projects の
    // schema_definition (identity_claims / user_data.columns) だけで決まるため、
    // Cernere は呼び出し元が何のサービスかを知らなくてよい。
    case "managed_project.get_identity_claims": {
      const service = await import("../project/identity-claims.js");
      const userId = requireStr(payload, "userId");
      const claims = Array.isArray(payload.claims) ? payload.claims as string[] : undefined;
      return service.getIdentityClaims(projectKey, userId, claims);
    }
    case "managed_project.resolve_user_by_claim": {
      const service = await import("../project/identity-claims.js");
      return service.resolveUserByClaim(
        projectKey,
        requireStr(payload, "claim"),
        requireStr(payload, "value"),
      );
    }
    case "managed_project.list_user_data": {
      const service = await import("../project/user-data-query.js");
      return service.listUserData(projectKey, {
        columns: Array.isArray(payload.columns) ? payload.columns as string[] : undefined,
        where: (payload.where ?? undefined) as Record<string, string | number | boolean | null> | undefined,
        activeAt: (payload.activeAt ?? undefined) as { column: string; at?: string } | undefined,
        claims: Array.isArray(payload.claims) ? payload.claims as string[] : undefined,
        limit: typeof payload.limit === "number" ? payload.limit : undefined,
      });
    }
    // ─── managed_relay: peer SA 間の仲介 (Phase 0b) ───
    //
    // Cernere は認証局に徹する. challenge 発行 / pair 許可 / endpoint
    // registry までを担当し、データ経路 (peer ↔ peer) には入らない.
    case "managed_relay.register_endpoint": {
      const { registerEndpoint } = await import("../project/relay-service.js");
      const saWsUrl = requireStr(payload, "saWsUrl");
      registerEndpoint(projectKey, saWsUrl);
      return { ok: true };
    }
    case "managed_relay.unregister_endpoint": {
      const { unregisterEndpoint } = await import("../project/relay-service.js");
      unregisterEndpoint(projectKey);
      return { ok: true };
    }
    case "managed_relay.request_peer": {
      const { requestPeer } = await import("../project/relay-service.js");
      const target = requireStr(payload, "target");
      const userId = requireStr(payload, "userId");  // fail-closed: opt-out チェックに必須
      return await requestPeer(projectKey, target, userId);
    }
    case "managed_relay.verify_challenge": {
      // 呼び出し元 (B) は自身の projectKey を WS セッションから提供し、
      // claimedIssuer (A が提示してきた projectKey) と照合する.
      const { verifyChallenge } = await import("../project/relay-service.js");
      const challenge     = requireStr(payload, "challenge");
      const claimedIssuer = requireStr(payload, "claimedIssuer");
      return verifyChallenge(challenge, claimedIssuer, projectKey);
    }
    default:
      throw new Error(`Unknown command: ${module}.${action} (project: ${projectKey})`);
  }
}

function requireVolputasProject(projectKey: string): void {
  if (projectKey !== VOLPUTAS_PROJECT_KEY) {
    throw new Error("Volputas survey commands require the Volputas project");
  }
}
