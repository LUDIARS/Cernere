/**
 * `profile.update` が表示名の出所 (`users.display_name_source`) を確定させること。
 *
 * spec/feature/edge-assertion-login.md §5.2.2 — 本人が設定した表示名は
 * エッジ認証の次回ログインで IdP 名に上書きされてはいけない。 その不変条件は
 * 「本人が名乗ったら source を 'user' にする」 側で成立させている。
 *
 * db は in-memory のフェイクに差し替える (実 DB には接続しない)。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface UpdateCall {
  table: unknown;
  values: Record<string, unknown>;
}

/** select 呼び出しごとに先頭から取り出す戻り値。 */
let selectResults: unknown[][] = [];
const updateCalls: UpdateCall[] = [];
const insertCalls: unknown[] = [];

function selectChain(): Record<string, unknown> {
  const rows = selectResults.shift() ?? [];
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  return chain;
}

vi.mock("../../src/db/connection.js", () => ({
  db: {
    select: () => selectChain(),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updateCalls.push({ table, values });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        insertCalls.push({ table, values });
      },
    }),
  },
}));

const { dispatchProjectCommand } = await import("../../src/ws/project-dispatch.js");
const schema = await import("../../src/db/schema.js");

const USER_ID = "6f1d0b9b-179a-4fc7-a643-d3228fe350b2";

/**
 * `profile.update` が投げる select の順序ぶんだけ結果を積む。
 *   1. user_data_optouts (オプトアウト判定)
 *   2. user_profiles (既存判定)
 *   3. users        (戻り値組み立て)
 *   4. user_profiles (戻り値組み立て)
 */
function queueSelects(): void {
  selectResults = [
    [],
    [{ userId: USER_ID }],
    [{ id: USER_ID, login: "taro", displayName: "山田 太郎", email: "taro@example.co.jp", role: "general" }],
    [],
  ];
}

function usersUpdate(): Record<string, unknown> | undefined {
  return updateCalls.find((c) => c.table === schema.users)?.values;
}

describe("profile.update — display_name_source", () => {
  beforeEach(() => {
    updateCalls.length = 0;
    insertCalls.length = 0;
    queueSelects();
  });

  it("marks the display name as user-set when the user renames themselves", async () => {
    await dispatchProjectCommand("corp-hub", "profile", "update", {
      userId: USER_ID,
      displayName: "たろう",
    });

    expect(usersUpdate()).toMatchObject({
      displayName: "たろう",
      displayNameSource: "user",
    });
  });

  // 表示名を触らない更新で source を書き換えると、 provisional のまま留めておきたい
  // 新規ユーザまで 'user' 扱いになり IdP 名が二度と入らなくなる。
  it("leaves the source untouched when only the avatar changes", async () => {
    await dispatchProjectCommand("corp-hub", "profile", "update", {
      userId: USER_ID,
      avatarUrl: "https://example.invalid/a.png",
    });

    const values = usersUpdate();
    expect(values).toMatchObject({ avatarUrl: "https://example.invalid/a.png" });
    expect(values).not.toHaveProperty("displayNameSource");
  });

  it("does not touch users at all when neither display name nor avatar is given", async () => {
    await dispatchProjectCommand("corp-hub", "profile", "update", {
      userId: USER_ID,
      bio: "hello",
    });

    expect(usersUpdate()).toBeUndefined();
  });
});
