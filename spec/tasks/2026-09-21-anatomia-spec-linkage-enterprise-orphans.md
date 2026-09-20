---
task: anatomia-spec-linkage-enterprise-orphans
project: Cernere
kind: 実装
created: 2026-09-21
memory_links: []
---

# 企業認証モジュールの Anatomia spec_linkage orphan を解消する

## 目的

`git diff main | anatomia verify` の 5 ゲートのうち `spec_linkage` だけが fail し、CLI が
exit 1 を返す。block ゲート (`rule_conformance` / `duplication`) と残り 2 つの warn ゲートは
PASS しているため、審査を止めているのはこの 1 ゲートだけである。

orphan として報告されるのは企業認証の実装ファイルに限られる。

- `server/src/enterprise/connections.ts` (9 関数)
- `server/src/enterprise/sessions.ts` (7 関数)
- `server/src/enterprise/session-store.ts` (4 関数)
- `server/src/enterprise/connection-contract.ts` (`parseConnection`)
- `packages/service-adapter/src/enterprise-middleware.ts` (`createEnterpriseAuthMiddleware`)
- `frontend/src/pages/admin/EnterpriseConnectionsPage.tsx` / `enterprise/ConnectionForm.tsx` /
  `enterprise/IdentityForm.tsx`

不可解なのは、**同じ書式で file-level `@implements` を書いている**
`server/src/enterprise/oidc-policy.ts` (SPEC-ENTERPRISE-OIDC)、`cloudflare-assertion.ts`
(SPEC-ENTERPRISE-ASSERTION)、`admin-command.ts` (SPEC-ENTERPRISE-ADMIN) は orphan にならない点。
参照先の clause は 6 つとも `spec/feature/cloudflare-enterprise-sso.md` に `##` 見出しとして実在する。

調査した範囲では、orphan になるのは SPEC-ENTERPRISE-CONNECTION と SPEC-ENTERPRISE-SESSION を
参照するファイル、および `@implements` が無い `enterprise-middleware.ts` と管理画面 3 ファイルである。
`deleteEnterpriseSession` に関数単位の `@implements SPEC-ENTERPRISE-SESSION` を付けて
`project analyze` をやり直しても解消しなかったため、docblock の書き方ではなく Anatomia の
link store 側の clause 解決の問題と見ている。

この状態は PR #1545 に元からあり、2026-09-21 の main 取り込み (78a8386) で新たに生じたものではない。
衝突解消で触った 13 ファイルは 1 つも orphan に出ていない。

## 完了条件

1. SPEC-ENTERPRISE-CONNECTION / SPEC-ENTERPRISE-SESSION を参照するファイルが orphan になり、
   ASSERTION / ADMIN / OIDC を参照するファイルがならない理由を特定する。
   Anatomia 側の不具合なら Anatomia に起票し、本リポで対処しない。
2. `@implements` が無い `packages/service-adapter/src/enterprise-middleware.ts` と
   管理画面 3 ファイル (`EnterpriseConnectionsPage.tsx` / `ConnectionForm.tsx` / `IdentityForm.tsx`)
   に、実在する clause への `@implements` を付ける。
3. 対処後に `git diff main | node <Anatomia>/bin/anatomia.mjs verify --project <cernere> --json` が
   exit 0 になる。block ゲートを緩める方向 (clause の新設だけで実体と対応しないリンク) で通さない。
4. 既存の 547 tests と tsc が緑のままであること (この作業でコードの挙動を変えない)。

## スコープ (編集可ディレクトリ)

- `server/src/enterprise/`
- `packages/service-adapter/src/`
- `frontend/src/pages/admin/`
- `spec/feature/`, `spec/domains/`
