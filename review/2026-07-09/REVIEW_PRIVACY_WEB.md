# Web 個人データ保護レビュー (Web Personal Data Protection Review)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| 対象ブランチ / PR | origin/main |
| レビュー実施日 | 2026-07-09 |
| 対象コミット範囲 | 7a763fc (shallow clone HEAD) |

> Cernere は RULE.md §5 により LUDIARS 全サービスの個人データ単一情報源 (single source of truth) と定義されており、`scripts/check-personal-data.mjs` も Cernere 自身を検査対象外としている (個人データを持つこと自体が正しい設計)。本ドキュメントは「持つべきでないものを持っている」ではなく「持つことが許された個人データを適切に分類・保護・削除できているか」を評価する。

---

## 1. 個人データの分類・最小化 (Data Classification & Minimization)

| データ種別 | 保存場所 | 保持期間 | 根拠 (必要性) |
|-----------|---------|---------|--------------|
| 氏名/メール/パスワードハッシュ/OAuthトークン等 (`users` テーブル) | Cernere PostgreSQL | 未文書化 (アカウント存続期間中と推測されるが明記なし) | 認証・本人特定 |
| デバイスフィンガープリント (`trusted_devices.machine_info`/`browser_info`) | Cernere PostgreSQL | 未文書化 (`revoked_at` はあるが自動失効ポリシーの記載なし) | 不正ログイン検知 |
| 監査ログ (`operation_logs.params`) | Cernere PostgreSQL | 未文書化 | 監査・不正検知 |
| プロジェクト別ユーザーデータ (`project_data_<key>`) | Cernere PostgreSQL (動的テーブル) | プロジェクト定義依存、全社共通ポリシーなし | 各 LUDIARS サービスの機能提供 |

| 重大度 | 該当箇所 | 説明 | 推奨対応 |
|--------|----------|------|----------|
| High | `spec/data/schema.md`, `spec/data/README.md`, `spec/data/cernere.taxonomy.json` | **PRIVACYWEB-001**。RULE_DATA_SCHEMA.md §4 が要求する「データ名 / 種類(master/user) / 権威ソース / 保存先 / 保護要否 / 保護方法」の一覧表が spec/data/ に存在しない。`spec/data/schema.md` は列名・型・制約のみの DB リファレンスであり保護要否の判定列を持たない。`spec/data/cernere.taxonomy.json` は個人データ分類ではなく、`domain-retune` ツール向けのコードパス所有権マップ (`{"domains":[{"name":"authentication","modules":[{"paths":["(^|/)server/src/http/..."]}]}]}`) であり、ファイル名・配置から個人データインベントリと誤認しうる。Cernere は組織の個人データ単一情報源であるにも関わらず、その一元インベントリが最も整備されているべき場所に存在しない。 | `spec/data/schema.md` に「保護要否・保護方法」列を追加するか、専用の `spec/data/personal-data-inventory.md` を新設し RULE_DATA_SCHEMA §4 の表形式で全個人データ項目を明記する。 |

### チェック項目

- [ ] サービスが扱う個人データのインベントリ（種別 / 保存場所 / 保持期間）が `spec/data/` にあるか: 未達 (上表 PRIVACYWEB-001)
- [x] 個人データを各サービス DB に持たず、Cernere を単一情報源としているか: 適合 (RULE.md §5 の想定通り、Cernere 自身が正本)
- [ ] 業務上不要なデータを収集・保持していないか: デバイスフィンガープリント (OS/platform/arch/screen/timezone/language/UA 文字列) の収集範囲は「本人確認」目的に対して概ね妥当だが、収集項目の必要性の説明が spec 側に無く判定しづらい (**PRIVACYWEB-003**、下記)
- [ ] ログ・分析基盤・キャッシュ・バックアップへ個人データが無制限に複製されていないか: `packages/id-cache` はプロファイル情報を Redis キャッシュするが TTL は確認 (`RULE.md §5.2` 準拠、1時間程度)。バックアップ運用は `web/REVIEW_IMPLEMENTATION_WEB.md` IMPLWEB-003 で扱う (二重計上しない)

---

## 2. 同意・法令遵守 (Consent & Compliance)

| 規制 | 適用有無 | 対応状況 | 所見 |
|------|---------|---------|------|
| GDPR | 未判定 | 未対応 | `spec/interface/oauth-token-storage.md:8` に「GDPR 等の right to be forgotten を Cernere 一カ所で完結させる」という設計動機の 1 行があるのみで、GDPR 域内ユーザーの取扱いに関する対応方針・法的根拠の文書は存在しない |
| 個人情報保護法 (APPI、日本) | 未判定 | 未対応 | `spec/`・`docs/` 全体を検索したが「個人情報保護法」「APPI」の言及は 0 件。UI/コメントが日本語中心であることから日本国内ユーザーが主対象と推測されるが、APPI 適用有無の判断自体が文書化されていない |
| 業界規制 | 未判定 | 未対応 | 記載なし |

| 重大度 | 該当箇所 | 説明 | 推奨対応 |
|--------|----------|------|----------|
| High | spec/ 全体 (該当ファイル無し) | **PRIVACYWEB-002**。適用法令の特定が行われていない。Cernere が個人データの単一情報源である以上、GDPR/APPI 等の適用判定はこの 1 リポジトリで組織全体分を代表することになるが、判定結果を記した文書が存在しない (`grep -ri "GDPR\|個人情報保護法\|APPI" spec/ docs/` で GDPR 1 件のみ、APPI 0 件)。プライバシーポリシーの提示・Cookie 同意機構の有無もフロントエンド (`frontend/src/pages/*`) に確認できず。 | 適用法域・規制を判定し `spec/setup/` または新規 `spec/plan/privacy-compliance.md` に記録する。プライバシーポリシー文書とその実装 (同意取得 UI) の有無を明確にする。 |

### チェック項目

- [ ] 適用される法令・規制が特定されているか: 未達 (上表)
- [ ] プライバシーポリシーが提示され、収集目的・第三者提供の記載が実装の実態と一致しているか: フロントエンドにプライバシーポリシーへのリンク/ページは確認できず (`frontend/src/pages/` 全 12 ページを確認したが該当なし)
- [ ] Cookie / トラッキングの同意取得（オプトイン）と撤回手段があるか: CSRF/セッション用 cookie (`ars_session`, `cernere_csrf_state`) は機能的必須 Cookie であり同意取得の対象外と解釈できるが、その整理自体が文書化されていない
- [ ] データ越境移転（保存リージョン / 外部 SaaS の所在地）の制約を満たしているか: AWS SES/SNS のリージョン (`config.ts:71` 既定 `ap-northeast-1`) は確認できるが、越境移転の制約整理は spec/ に無し (未確認)
- [ ] 漏洩インシデント発生時の通知義務・対応手順が定義されているか: `RULE_SRE.md` §2 の Issue 報告運用はあるが、個人データ漏洩インシデント固有の通知義務プロセス (法令上の通知期限等) は未定義

---

## 3. 保持・削除 (Retention & Erasure)

| 評価 | 所見 |
|------|------|
| 適合 (削除機構は堅牢) | `deleteUserAccount()` (`server/src/project/service.ts:494-516`) は FK CASCADE (`refresh_sessions`/`verification_codes`/`trusted_devices`/`passkeys`/`organization_members`/`tool_clients`/`user_profiles`/`projects`/`service_tickets`/`user_data_optouts`/`project_oauth_tokens`/`project_data_<key>` 全動的テーブル) に加え、CASCADE を持たない `operation_logs.user_id` を明示的に事前 purge し、`project_definition_history.applied_by` を NULL 化するトランザクション処理を実装。right-to-be-forgotten としては高い完成度を確認した。オプトアウト (`setModuleOptout`) も対象モジュールのデータを NULL 化 + `_deleted_columns` へ退避監査するなど丁寧な設計。 |
| 未文書化 (保持期間) | 上記削除**機構**は堅牢な一方、「削除されるまでの既定保持期間」がどのデータ種別にも明記されていない (PRIVACYWEB-001 の一部として計上、本行では新規指摘としない)。 |

### チェック項目

- [ ] データ種別ごとの保持期間が定義され、超過分の自動削除があるか: 未定義 (PRIVACYWEB-001 参照、二重計上しない)。`refresh_sessions`/`service_tickets` の期限切れレコード削除 cron が無いことは `spec/plan/commit-plan.md` M8/M19 として自己認識済み・未着手 (`common/REVIEW_MISSING_FEATURES.md` で言及、本行では新規指摘としない)
- [x] ユーザーが自分のデータをエクスポート・削除できる手段があるか: `managed_project.my_data`/`my_data_all` (自分のプロジェクトデータ閲覧) + `user.delete_account` (完全削除) を確認。`frontend/src/pages/DataOptOutPage.tsx` で UI 提供も確認
- [x] 削除がバックアップ・レプリカ・キャッシュ・検索インデックス・外部連携先へ伝播するか: `cache.invalidate()`/`cache.invalidateProject()` 呼び出しを削除・更新経路で確認 (Redis キャッシュへの伝播は適合)。バックアップ/レプリカへの伝播は運用手順の記載が無く**未確認**
- [x] 退会・解約時のデータの扱い（即時削除 / 猶予期間 / 匿名化）が定義されているか: `deleteUserAccount()` は即時物理削除 (猶予期間なし)。挙動としては明確 (適合)

---

## 4. 第三者提供・テレメトリ (Third-Party Sharing & Telemetry)

| 重大度 | 該当箇所 | 説明 | 推奨対応 |
|--------|----------|------|----------|
| Medium | `frontend/src/lib/device-fingerprint.ts`, `packages/composite/src/ui/device-fingerprint.ts`, `server/src/auth/identity-verification.ts` | **PRIVACYWEB-004**。composite ログイン時に OS/platform/CPU アーキテクチャ/画面解像度/タイムゾーン/言語/完全な User-Agent 文字列 + 接続元 IP を収集し (`identity-verification.ts:1-16` のコメントで用途は明記)、不正ログイン検知に用いる。目的自体は正当 (anti-fraud) だが、収集**時点**でユーザーへの告知 UI が無い (`CompositeLoginPage.tsx` にプライバシー通知の表示は確認できず)。また §1 のインベントリ (PRIVACYWEB-001) にもこのフィンガープリント収集が記載されていない。 | composite ログイン画面に「不正ログイン検知のためデバイス情報を収集します」旨の告知を追加し、収集項目を個人データインベントリに明記する。 |

### チェック項目

- [ ] 外部送信するデータと送信先が文書化されているか: GitHub/Google OAuth (`oauth-handler.ts`)、AWS SES (メール送信)、AWS SNS (SMS、`config.ts:72`) が外部送信先として実装上確認できるが、これらを一覧化した文書は spec/ に無い (未確認、PRIVACYWEB-002 と関連するため新規の High とはしない)
- [ ] 送信前のマスキング・匿名化・集約が行われているか: `logAuthEvent()`/`redactSensitive()` はログ内の token/secret をマスクする (適合、`common/REVIEW_VULNERABILITY.md` で確認済み) が、外部送信 (SES/SNS) 時点でのマスキング方針は対象外 (通知メール本文に確認コード等の必要最小限情報のみを含めており、過剰送信は確認されず — 適合)
- [ ] サブプロセッサ（SaaS / CDN / 監視サービス）の規約・契約が個人データの取扱いをカバーしているか: 契約書類はリポジトリ範囲外のため**対象外 (理由: コードレビューの対象外)**

---

## 総合評価

| # | レビュー観点 | 評価 | 重大指摘数 |
|---|------------|------|-----------|
| 1 | 個人データの分類・最小化 | C | 1 (High 1) |
| 2 | 同意・法令遵守 | C | 1 (High 1) |
| 3 | 保持・削除 | B | 0 |
| 4 | 第三者提供・テレメトリ | B | 0 (Medium 1) |

**個人データ保護 (集約評価)**: **C** (§1/§2 の High 2 件が最悪重大度)。`web/REVIEW.md` 総合評価表の「個人データ保護」行はこの集約値を用いる。

**評価基準**（重大度の定義・導出ルール・対象外の扱いは [REVIEW.md「評価の決定ルール」](../../../REVIEW.md#評価の決定ルール) を正本とする）:
- **A**: 指摘 0 件。チェック項目をすべて満たす
- **B**: Medium / Low の指摘のみ。運用上の影響は低い
- **C**: High の指摘が 1 件以上。リリース前の対応を推奨
- **D**: Critical の指摘が 1 件以上。即時対応が必要

### 反証パス (High)

- **PRIVACYWEB-001**: `spec/data/schema.md`・`spec/data/README.md`・`spec/data/cernere.taxonomy.json`・`spec/data/ontology/*.json` (7 ファイル) を全読し、保護要否列を持つ表が存在しないことを再確認。反証成立せず。
- **PRIVACYWEB-002**: `grep -ri "GDPR\|個人情報保護法\|APPI\|プライバシーポリシー" spec/ docs/ README.md` を実行し、GDPR 1 件 (設計動機の 1 行) 以外に一致が無いことを再確認。反証成立せず。
