/**
 * link 開始時の state に付ける目印。 権限は一切持たない (link 対象 user_id は必ず
 * Redis の `oauthlink:<state>` からのみ読む) が、 「これは link のつもりだった」 を
 * callback 側で判別するために使う。 これが無いと Redis の TTL が切れた link callback
 * が通常ログインへ落ち、 「連携する」 を押しただけの利用者が意図せず別アカウントに
 * サインイン (未登録なら新規作成) されてしまう。
 */
const LINK_STATE_PREFIX = "link:";

/** link 用の state を発行する。 値そのものは推測不能な UUID。 */
export function createLinkStateToken(randomId: string): string {
  return `${LINK_STATE_PREFIX}${randomId}`;
}

/**
 * state が link 由来かどうか。 偽装可能な目印なので、 これ単体では何も許可しない。
 * 「Redis エントリが無い callback を通常ログインへ落とさない」 判定にだけ使う。
 */
export function isLinkStateToken(stateParam: string | null | undefined): boolean {
  return typeof stateParam === "string" && stateParam.startsWith(LINK_STATE_PREFIX);
}

/** OAuth callback CSRF state must be an exact cookie match. */
export function verifyOAuthStateParam(input: {
  stateParam: string | null | undefined;
  cookieState: string | undefined;
}): { ok: boolean } {
  return {
    ok: typeof input.stateParam === "string"
      && input.stateParam.length > 0
      && typeof input.cookieState === "string"
      && input.cookieState.length > 0
      && input.stateParam === input.cookieState,
  };
}
