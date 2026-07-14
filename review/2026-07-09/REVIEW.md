# REVIEW (総合評価) — Cernere

**スタイル判定: Web サービス**。根拠: `server/`(TypeScript + uWebSockets.js API/WS サーバ) + `frontend/`(React SPA) + `migrations/`(PostgreSQL) の構成で HTTP(S)/WebSocket 経由で他 LUDIARS サービス・ブラウザにサービスを提供しており、REVIEW.md スタイル判定ルール #2 に該当。加えて Cernere は RULE.md §5 により LUDIARS 全体の認証・個人データ単一情報源であるため、Web 個人データ保護レビュー (`REVIEW_PRIVACY_WEB.md`) を含む Web スタイル全 20 観点を適用する。

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| 対象ブランチ / PR | origin/main (shallow clone HEAD) |
| レビュー実施日 | 2026-07-09 |
| 対象コミット範囲 | `7a763fc` (working tree と一致、乖離なし) |
| **総合評価 (重み付けスコア)** | **B** |

---

## レビュードキュメント一覧

### 共通（common/）

| ドキュメント | 含まれるレビュー観点 |
|------------|-------------------|
| [設計レビュー](REVIEW_DESIGN.md) | 設計強度 / 設計思想の一貫性 / モジュール分割度 |
| [コード品質レビュー](REVIEW_CODE_QUALITY.md) | コード品質 |
| [脆弱性レビュー（共通）](REVIEW_VULNERABILITY.md) | コードレベル脆弱性 / CI/CD・サプライチェーン |
| [品質保証レビュー](REVIEW_QUALITY.md) | テスト戦略 / ライセンス遵守 / ドキュメント完備性 |
| [AI 活用レビュー](REVIEW_AI.md) | LLM 機能のセキュリティ / AI 生成コードの検収 |
| [不足機能評価](REVIEW_MISSING_FEATURES.md) | 機能改善 / 不足機能 |

### Web 固有

| ドキュメント | 含まれるレビュー観点 |
|------------|-------------------|
| [Web 脆弱性レビュー](REVIEW_VULNERABILITY_WEB.md) | Web 脆弱性 / ゼロトラスト / セキュリティ強度 |
| [Web 個人データ保護レビュー](REVIEW_PRIVACY_WEB.md) | 個人データの分類・最小化 / 同意・法令遵守 / 保持・削除 / 第三者提供・テレメトリ |
| [Web 実装評価](REVIEW_IMPLEMENTATION_WEB.md) | データスキーマ / SRE |
| [Web 品質保証レビュー](REVIEW_QUALITY_WEB.md) | パフォーマンス / クロスプラットフォーム / アクセシビリティ・国際化 |

---

## 概要

Cernere は堅牢な認証コア (PASETO Ed25519 project-token、WebAuthn/Passkey、OIDC Provider (PKCE S256)、bcrypt パスワード、Redis ベースレート制限、refresh token ローテーション + 再利用検知、AES-256-GCM 保存時暗号化、right-to-be-forgotten の徹底したカスケード削除) を備え、前回レビュー (2026-06-02) で Critical/High とされた項目の多くを解消済みであることを確認した (詳細は「前回レビューとの突合」参照)。開発チーム自身が `spec/plan/commit-plan.md` に 46 件の改善タスクを重大度付きで自己申告・追跡しており、プロセス面の成熟度は高い。

一方で、フルレビューにより **新たに Critical 2 件** を検出した: (1) composite ログインフロー (`redirect_uri`/`origin`) にオープンリダイレクト対策が無く、認可コード窃取によるアカウント乗っ取りが可能 (`VULNWEB-001`)、(2) `docker-compose.override.yaml` に PASETO 署名秘密鍵がハードコードされたまま git 追跡されている (`VULN-001`、ファイル自身の「Do NOT commit」というコメントに反する)。また個人データ単一情報源であるにも関わらず RULE_DATA_SCHEMA.md が要求する個人データインベントリ・法令適用判定 (GDPR/APPI) の文書が存在しない (`PRIVACYWEB-001`/`002`)。

---

## 総合評価 (Overall Assessment)

| # | レビュー観点 | 区分 | 評価 | 重大指摘数 | ドキュメント |
|---|------------|------|------|-----------|------------|
| 1 | 設計強度 | 共通 | B | 0 | [設計レビュー](REVIEW_DESIGN.md) |
| 2 | 設計思想の一貫性 | 共通 | B | 0 | [設計レビュー](REVIEW_DESIGN.md) |
| 3 | モジュール分割度 | 共通 | B | 0 | [設計レビュー](REVIEW_DESIGN.md) |
| 4 | コード品質 | 共通 | B | 0 | [コード品質レビュー](REVIEW_CODE_QUALITY.md) |
| 5 | コードレベル脆弱性 | 共通 | D | 3 (Critical 1 / High 2) | [脆弱性レビュー（共通）](REVIEW_VULNERABILITY.md) |
| 6 | CI/CD・サプライチェーン | 共通 | C | 2 (High 2) | [脆弱性レビュー（共通）](REVIEW_VULNERABILITY.md) |
| 7 | テスト戦略・カバレッジ | 共通 | C | 1 (High 1) | [品質保証レビュー](REVIEW_QUALITY.md) |
| 8 | ライセンス遵守 | 共通 | B | 0 | [品質保証レビュー](REVIEW_QUALITY.md) |
| 9 | ドキュメント完備性 | 共通 | B | 0 | [品質保証レビュー](REVIEW_QUALITY.md) |
| 10 | LLM 機能のセキュリティ | 共通 | 対象外 (LLM 機能なし) | — | [AI 活用レビュー](REVIEW_AI.md) |
| 11 | AI 生成コードの検収 | 共通 | B | 0 | [AI 活用レビュー](REVIEW_AI.md) |
| 12 | 機能改善 | 共通 | - | High 4 / Medium 0 / Low 0 | [不足機能評価](REVIEW_MISSING_FEATURES.md) |
| 13 | 不足機能 | 共通 | - | High 2 / Medium 3 / Low 0 | [不足機能評価](REVIEW_MISSING_FEATURES.md) |
| 14 | Web 脆弱性 | Web | D | 2 (Critical 1 / High 1) | [Web 脆弱性レビュー](REVIEW_VULNERABILITY_WEB.md) |
| 15 | ゼロトラスト | Web | B | 0 | [Web 脆弱性レビュー](REVIEW_VULNERABILITY_WEB.md) |
| 16 | セキュリティ強度 | Web | C | 3 (High 3) | [Web 脆弱性レビュー](REVIEW_VULNERABILITY_WEB.md) |
| 17 | 個人データ保護 | Web | C | 2 (High 2) | [Web 個人データ保護レビュー](REVIEW_PRIVACY_WEB.md) |
| 18 | データスキーマ | Web | B | 0 | [Web 実装評価](REVIEW_IMPLEMENTATION_WEB.md) |
| 19 | SRE | Web | B | 0 | [Web 実装評価](REVIEW_IMPLEMENTATION_WEB.md) |
| 20 | パフォーマンス・ベンチマーク | Web | B | 0 | [Web 品質保証レビュー](REVIEW_QUALITY_WEB.md) |
| 21 | クロスプラットフォーム互換 | Web | B | 0 | [Web 品質保証レビュー](REVIEW_QUALITY_WEB.md) |
| 22 | アクセシビリティ・国際化 | Web | B | 0 | [Web 品質保証レビュー](REVIEW_QUALITY_WEB.md) |

> 個人データ保護 (行 17) は `REVIEW_PRIVACY_WEB.md` 内 4 観点 (§1 C, §2 C, §3 B, §4 B) の最悪重大度から導出した集約行 (C)。

---

## 重み付けスコアの計算過程

評価を付けた 19 観点 (LLM 機能のセキュリティは対象外のため母数から除外。機能改善/不足機能は評価軸を持たないため元々母数に含まない) の内訳:

| 評価 | 件数 | 該当観点 |
|------|------|---------|
| A | 0 | — |
| B | 13 | 設計強度・設計思想の一貫性・モジュール分割度・コード品質・ライセンス遵守・ドキュメント完備性・AI生成コードの検収・ゼロトラスト・データスキーマ・SRE・パフォーマンス・クロスプラットフォーム・アクセシビリティ |
| C | 4 | CI/CD・サプライチェーン・テスト戦略・セキュリティ強度・個人データ保護 |
| D | 2 | コードレベル脆弱性・Web 脆弱性 |

A=4 / B=3 / C=2 / D=1 として平均: (13×3 + 4×2 + 2×1) ÷ 19 = (39 + 8 + 2) ÷ 19 = 49 ÷ 19 = **2.58** → 四捨五入で 3 → **B**

`critical_count` = 2 (VULN-001, VULNWEB-001)
`high_count` = 11 (VULN-002, VULN-003, CICD-001, CICD-002, QUALITY-001, VULNWEB-002, VULNWEB-003, VULNWEB-004, VULNWEB-005, PRIVACYWEB-001, PRIVACYWEB-002)

機械検査 (REVIEW.md Phase 5): 各観点の「重大指摘数」列の合計 = 3+2+1+2+3+2 = 13 = critical_count(2) + high_count(11) = 13 ✓ 一致。

---

## カバレッジ (読んだ範囲 / 走査した範囲 / 未確認の範囲)

**全読 (直接 Read):**
- `server/src/` 全 49 ファイル中 44 ファイルを全読 (auth/ 8、http/ 7、ws/ 9、project/ 8、oidc/ 4、db/ 3、lib/ 3、logging/ 2 中 1、app.ts/bootstrap.ts/commands.ts/config.ts/error.ts/index.ts/redis.ts)
- `frontend/src/` 全 20 ファイル (サブエージェント経由で全読、Critical 発見箇所は自分で開き直し再確認)
- `packages/` 全 4 パッケージの `src/` (env-cli 7・id-cache 3・id-service 13・service-adapter 10 ファイル、サブエージェント経由で全読)
- `spec/` 全 35 ファイル (サブエージェント経由で全読)
- `migrations/` 全 26 ファイル・899 行 (サブエージェント経由で全読)
- `.github/workflows/` 全 4 ファイル、`docker-compose*.yaml` 全 3 ファイル、`Dockerfile` 2 本、`.env.example`、`.gitignore`、`LICENSE`、`README.md` (サブエージェント経由 + 自分で再確認)
- `review/` 過去 6 回分 (2026-05-13〜2026-06-02) の突合対象ドキュメント

**走査のみ (grep / 部分確認、全読していない):**
- `server/src/logging/dev-logger.ts`、`server/src/ws/events.ts`・`project-registry.ts`・`protocol.ts`、`server/src/project/user-data-cache.ts` (計 5 ファイル、約 250 行) — grep によるシグネチャ確認のみ。上記以外の主要ファイルとの相互参照から用途は把握したが、個別の脆弱性・品質チェックは未実施のため、これらファイル固有の指摘は「無し」ではなく「未確認」として扱う。
- `docs/*.md` (6 ファイル) — サブエージェントによる見出しレベルのスキム確認のみ、本文の逐語検証はしていない。
- `frontend/package-lock.json`・`server/package-lock.json`・`*/pnpm-lock.yaml` — 依存パッケージ名の grep 確認のみ、トランジティブ依存の CVE スキャンは未実施。
- `server/service/*` (bibliotheca/imperativus/nuntius/schedula の schema.json テンプレート) — `project/service.ts` からの参照経路のみ確認、個別ファイルの中身は未読。
- `demo/` ディレクトリ — README 記載の存在確認のみ。
- `site/` ディレクトリ (静的サイト生成物) — 存在確認のみ。

**未確認 (確認手段なし・理由付き):**
- 依存ライブラリの既知 CVE: サンドボックス環境から `npm audit`/Snyk 等の外部レジストリ照会が実施できず (`common/REVIEW_VULNERABILITY.md` §1 に記載)。
- GitHub リポジトリの branch protection 設定 (CI 必須化の実運用): リポジトリのファイルベースでは確認不能 (`common/REVIEW_QUALITY.md` §1 に記載)。
- 本番相当ネットワークでの TLS 終端設定: リバースプロキシ層の設定はリポジトリ範囲外 (`web/REVIEW_VULNERABILITY_WEB.md` §3 に記載)。
- 実データベースの `project_oauth_tokens`/`users` 行における暗号化移行の進捗 (`secret-box.ts` の lazy migration シムにより、暗号化導入前の平文行が現存するかは実データを見ないと判定不能)。

読んでいない範囲を根拠に「適合」とした指摘は無い。上記「走査のみ」「未確認」区分のファイル固有の欠陥については、指摘 0 件ではなく「未確認」として扱い、該当する観点 (design_consistency, modularity 等) は A ではなく B 上限キャップの対象として評価した。

---

## 前回レビューとの突合

前回成果物: `review/2026-06-02/` (legacy フォーマット、`format_version` フィールド無し・独自 ID 体系 V-1〜V-4/#1〜#3/T-1〜T-5/a〜c。`review/latest.json` の日付は 2026-05-14 のままで 2026-06-02 分は未反映というリポジトリ側の運用ギャップも確認したが、本レビューでは 2026-06-02 の内容を「前回」として扱う)。前回は対象範囲が「main 直近 4 commit」でありサーバー中心の限定レビューだった一方、本レビューは全リポジトリを対象とする初のフルレビューであるため、前回に無かった観点 (frontend/packages/spec/migrations 等) の指摘はすべて「新規」である。

| 前回 ID | 前回内容 | 分類 | 今回の対応 |
|---------|---------|------|----------|
| V-1 (Critical) | PASETO/JWT env 未設定時の silent fallback (本番で legacy HS256 継続のリスク) | **解消** | `config.ts:60-68` で `JWT_SECRET` 未設定時に無言フォールバックせず throw する設計に変更済み。project-token 発行経路 (`auth-handler.ts:365-371`) も PASETO 未設定時に fail-closed (500) へ変更済みで、当時懸念された「本番で気づかず legacy 継続」の実害経路は解消したことをコード上で確認。ただし `paseto.ts` の `loadKeys()` 自体は今も console.warn のみで起動継続する部分残存があり、これは新規 ID **VULN-005 (Medium)** として別途起票 (重大度は大幅に低下したため新規 Medium 指摘とし、V-1 の「継続」扱いにはしない)。 |
| V-2 (High) | project-token の hub_url 未バリデーション (malformed URL が aud claim にセット) | **継続 (重大度見直し: High→Medium)** | 新 ID **VULN-004**。`hub_url` 必須化・PASETO 未設定時 fail-closed という設計変更により、当時懸念された bypass 経路は無くなったが、URL 形式検証自体は今も実装されていないため「継続」だが重大度は Medium に見直し。 |
| V-3 (High) | HS256 token に aud claim なし (legacy service が別プロジェクトで再利用可能) | **解消** | 該当コード (`generateUserProjectToken`/`verifyUserProjectToken`) 自体が撤去されており (`jwt.ts:77-82` のコメントで明記)、「user_for_project」用途の HS256 経路は存在しない。残存する HS256 「project」token (`generateProjectToken`) はプロジェクト自身の識別トークンであり用途が異なるため V-3 の指摘対象ではないことをコード読解で確認。 |
| V-4 (High) | project-token の hub_url 未バリデーション / email・password 入力バリデーション欠落 (複合指摘) | **継続 (2 指摘に分離)** | hub_url 部分は V-2 と重複記載だったため統合して上記へ。email/password バリデーション欠落部分は新 ID **VULN-002 (High)** として継続。 |
| 設計課題 #1 (High, HS256 token に aud claim なし) | V-3 と同一事象 | **解消** | 上記 V-3 参照。 |
| 設計課題 #2 (Medium, hub_url バリデーションなし) | V-2 と同一事象 | **継続** | 上記 VULN-004 参照。 |
| 設計課題 #3 (Medium, HS256 廃止タイムラインなし) | — | **解消 (体系変更を伴う実質解消)** | HS256 の「user_for_project」用途自体が撤去済みのため、廃止タイムラインの論点が消滅。 |
| T-1〜T-5 (テスト未整備 5 件) | HS256→PASETO移行整合性/4層防御 failover/role詐称防止/鍵ローテーション/WSリレー権限 のテスト欠如 | **継続 (実質)** | 個別 5 項目としては前回の粒度が細かすぎるため今回は統合し、新 ID **QUALITY-001 (High)** として「認証・認可の中核 (auth-handler/ws/commands.ts) にテストが無い」という上位概念で再起票。 |
| a (Medium, Zod でのリクエストスキーマ定義なし) | — | **継続** | VULN-002 の一部として統合 (RULE_CODE §9 Zod 未使用の指摘を包含)。 |
| b (Medium, redis session/state のインターフェース抽象化) | — | **継続 (指摘化見送り)** | 実害の具体的経路を示せず、本レビューでは新規指摘としては起票しない (対象外ではなく「確認したが Critical/High の実害が示せなかったため Low 相当、記載省略」)。 |
| c (Low, paseto.ts の cast 冗長性) | — | **未確認 (再調査せず)** | 軽微な Low 指摘であり本レビューでは優先度低のため個別再検証はしていない。 |

**解消 3 件 / 継続 3 件 (うち 1 件は重大度見直し・1 件は 2 指摘へ分離) / 新規多数 (フルレビュー初回のため)**。前回が確認していなかった frontend・packages・spec・migrations 領域から Critical 1 件 (VULNWEB-001) を含む多数の新規指摘が生じた。

---

**評価基準**（重大度の定義・導出ルール・対象外の扱いは [REVIEW.md「評価の決定ルール」](../../../REVIEW.md#評価の決定ルール) を正本とする）:
- **A**: 指摘 0 件。チェック項目をすべて満たす
- **B**: Medium / Low の指摘のみ。運用上の影響は低い
- **C**: High の指摘が 1 件以上。リリース前の対応を推奨
- **D**: Critical の指摘が 1 件以上。即時対応が必要
