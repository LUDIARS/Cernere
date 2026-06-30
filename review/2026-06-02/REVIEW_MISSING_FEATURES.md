# REVIEW_MISSING_FEATURES — Cernere

**評価: C**

## テスト実装状況 (test-design.md より)

| 種別 | 状態 | 評価 |
|------|------|------|
| 1. ビルド | ✅ | typecheck 実施 |
| 2. ユニット | ✅ | JWT/PASETO 22 本 (token 層のみ) |
| 3. smoke | ❌ | 未着手 |
| 4. 統合 | ❌ | 観点定義あり (register/login/project-token) だがテストなし |
| 5. WS/セッション | ❌ | 常時接続・状態遷移・リレー権限 未 |
| 6. マイグレーション | ❌ | 冪等性・再適用 未 |
| 7. パッケージ契約 | △ | service-adapter のみ |

## Critical 未テスト機能
- T-1: HS256 → PASETO 段階移行の整合性
- T-2: 4 層防御の各層 failover (Layer 1/2/3/4 individual)
- T-3: project-token role 詐称防止
- T-4: PASETO_PREVIOUS_PUBLIC_KEYS rotation
- T-5: WS リレー権限の同一ユーザー制限

## 改善
- smoke/統合/WS テストの CI 配線 (phase plan を spec/test/test-design.md に記載)
- legacy HS256 廃止スケジュール (deadline + deprecation notice)

**総合: C**。token 層テストは充実するが、smoke/統合/WS/migration テストが未配線で全体検証が不十分。
