/**
 * 利用許可 (許可制 案 A) の WS API。
 * 本人: 状態の確認・申請・取り下げ。admin: 一覧と許可・拒否・ロック・解除 (この端末のパスキーで確かめる)。
 */

import { wsClient } from "./ws-client";

export type AccessStatus = "pending" | "active" | "locked";

export interface MyAccess {
  status: AccessStatus;
  request: { id: string; state: string; purpose: string; createdAt: string } | null;
}

export interface AccessReviewItem {
  userId: string;
  displayName: string;
  status: AccessStatus;
  revision: number;
  createdAt: string;
  request: { id: string; purpose: string; createdAt: string } | null;
}

export type AccessDecision = "approve" | "reject" | "lock" | "unlock";

export const userAccess = {
  status(): Promise<MyAccess> {
    return wsClient.sendCommand<MyAccess>("user_access", "status", {});
  },
  apply(purpose: string): Promise<{ requestId: string }> {
    return wsClient.sendCommand("user_access", "apply", { purpose });
  },
  withdraw(): Promise<{ withdrawn: boolean }> {
    return wsClient.sendCommand("user_access", "withdraw", {});
  },
  async list(status: "requests" | AccessStatus): Promise<AccessReviewItem[]> {
    return (await wsClient.sendCommand<{ items: AccessReviewItem[] }>("user_access", "list", { status })).items;
  },
  decide(item: AccessReviewItem, decision: AccessDecision, reasonCode: string): Promise<{ status: AccessStatus; revision: number }> {
    return wsClient.sendCommand("user_access", "decide", {
      userId: item.userId,
      decision,
      expectedRevision: item.revision,
      reasonCode,
    });
  },
};

/** サーバーが許可待ちを理由に断ったか (WS / REST のエラーから判定)。 */
export function isApprovalRequired(err: unknown): boolean {
  return err instanceof Error && /waiting for approval|approval_required/i.test(err.message);
}
