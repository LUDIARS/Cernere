# service 文脈 token (P2) と service_scopes 宣言 (P3)

- Actio: `actio:bc7011da-9494-472f-a3aa-dc4ee72448f4`
- 設計: Corpus `spec/plan/auth-plane-consolidation.md` §4.2 / §4.3
- 仕様: `spec/feature/service-token.md`

## 分解

- [x] PASETO 署名・検証を user 版 / service 版で共有できるよう `paseto.ts` に汎用関数を切り出す
- [x] `auth/service-token.ts`: `kind: "service"` claims、署名、検証、scope 照合
- [x] `project/schema.ts`: `service_scopes` (形式検証付き) を定義へ追加
- [x] `service_scopes` を管理者所有に (update_schema で落とす / partial update で保持)
- [x] `project/service-scopes.ts`: 保存済み宣言からの scope 導出
- [x] `project/service-token-issuer.ts` と `POST /api/auth/service-token`
- [x] テスト追加 (未実行。実行は指示待ち)

## migration

不要。`service_scopes` は既存の `schema_definition` (jsonb) に載るため DDL を伴わない。
