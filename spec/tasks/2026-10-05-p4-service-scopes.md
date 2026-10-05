# 認証集約 P4 — service_scopes 宣言と呼出先登録 (Cernere 側)

- Actio: `actio:3ba0e56c-d5c8-4984-aee8-1cc942f57380`
- 設計: Corpus `spec/plan/auth-plane-consolidation.md` §6 (P4)
- 仕様: `spec/feature/service-token.md` (決定事項 / P4 の宣言と登録)

## 分解

- [x] persona export の呼出元を特定 (Discutere `scripts/persona-import.ts` → Volputas `GET /api/personas/export`)
- [x] Calliope / Discutere の Cernere 登録有無を確認 (未登録 → `calliope` / `discutere` で最小登録)
- [x] migration 058: service_scopes の冪等マージ (EducationLab / calliope / volputas / discutere)
- [x] migration 058: excubitor → calliope / discutere の launch credential 発行許可
- [x] spec の『判断が要る点』を決定事項 (TTL 15 分 / 新旧両受理) に書き換え
- [x] migration 内容の回帰テスト `server/tests/db/p4-service-scopes-migration.test.ts`

## 範囲外

- 稼働 DB への migration 適用 (運用側)。
- 送り側 / 受け側の実装 (GLAB / Calliope / Volputas / Discutere 各委託)。
