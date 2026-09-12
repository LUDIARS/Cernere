---
task: face-data-local-only-cernere
branch: feat/face-data-local-only
status: implemented
---

# Cernere から顔テンプレート・顔写真の保存を撤去し、同意記録と失効指示だけを残す

## 目的

顔特徴データと顔写真は個人識別符号で、漏洩しても取り消せない。クラウド (Cernere) に正本を
置く限り、Cernere の侵害・誤設定・バックアップ流出がそのまま全施設の生体情報流出になる。
そこで正本を施設の受付端末 (kiosk 上の Ostiarius) へ移し、**Cernere は生体情報を一切持たない**
構成にする。Cernere に残すのは「同意したか」の記録と、「この人の顔データを消せ」という
失効指示だけで、失効指示は 30 日で回収する。

設計正本は Ostiarius `spec/plan/face-data-local-only.md` §2 と
`spec/interface/cernere-face-template.md` §A (どちらも審査中)。本 PR はその Cernere 側全部を
実装する。Cernere 側の契約正本として `spec/feature/face-consent-and-revocation.md` を新設し、
`spec/feature/face-template-store.md` は削除した。

## 完了条件

1. 新設 API が契約どおり動く。
   - `GET /api/identity/face-revocations?facilityId=&since=` (scope `face-revocation:read`) が
     `{ revocations: [{ userId, facilityId, reason, at }] }` を返し、`facilityId` 必須、
     `since` は保持期間 30 日の境界まで切り上げる。reason は `withdrawn` / `left_facility` /
     `graduated` / `account_deleted` / `consent_expired` / `staff_invalidated` のみ。
   - `GET /api/identity/face-consents?facilityId=` (scope `face-consent:read`) が
     `{ consents: [{ userId, consentId, policyVersion, at, revokedAt }] }` を返す。
   - `POST /api/identity/face-consent/revoke` (scope `face-consent:revoke` + `revokedBy`) が
     同意に `revokedAt` を打ち、失効指示 (既定 `withdrawn`) を積む。`revokedBy` は対象施設の
     reviewer role を現に持つこと。
2. `face_revocations` テーブルを migration 054 で追加し、同意撤回・所属離脱・施設削除・
   アカウント削除・365 日再同意なし・職員無効化の各フックから 1 行ずつ積む。30 日で回収する。
   生体情報を含む列を持たない。
3. 撤去: 旧 face-template / face-photo API 全部、テンプレート・写真の封緘モジュールと
   対応テスト、`FACE_TEMPLATE_*` / `FACE_PHOTO_*` / `FACE_SIDECAR_*` の config と
   config-reference 記載、写真正規化のための `sharp` 依存。
4. 同意文に現行版 `face-local-v1` を追加する (「保存先は施設の受付端末 (kiosk) のみ。施設外へ
   出さない。表示は施設内の職員画面と本人に限る」)。旧版は読み取り専用として残し、新規・再同意
   では受理しない。`GET /api/identity/face-consent/policy` は新版を返す。
5. `POST /api/identity/face-consent`・`GET /api/identity/face-consent/policy`・
   `GET /api/identity/roster`・`POST /api/auth/code/exchange`・passkey export の
   `roles` / `facilityIds` 拡張は従来どおり残す。
6. spec: `spec/feature/face-consent-and-revocation.md` を新設、`spec/feature/face-template-store.md`
   を削除、`spec/domains/authentication.domain.json` と
   `spec/domains/persistence-migration.domain.json` の宣言を追従させる。
7. テスト: 新 3 API の認可 (scope なしは 403、facilityId なしは 400)、失効指示の積み上げと
   30 日回収、旧 face-template / face-photo 経路が 404 で route 登録も残らないこと。
8. リポジトリ内に `face_templates` / `face_photos` を読む・書くコードが無い
   (migration の drop を除いて grep 0 件)。`FACE_TEMPLATE_*` / `FACE_PHOTO_*` /
   `FACE_SIDECAR_URL` が config から消えている。typecheck とテストが緑。

## 保留した範囲

- `face_templates` / `face_photos` / `face_template_tombstones` を物理削除する migration 055 は
  **本 PR では出さない** (2026-09-12 ユーザ判断「055 は保留して PR を出す」)。`CLAUDE.md` の
  マイグレーション規約が `DROP TABLE` を禁じているため、生体情報の物理削除は規約の例外として
  別途許可を取ってから単独の migration で出す。本 PR 時点でこれらのテーブルを読み書きする
  コードは無く (`server/tests/http/face-legacy-surface-removed.test.ts` で検査)、データが残る
  だけの死蔵テーブルになる。

## 前提未確定

- `graduated` (卒業) に対応する既存フックが Cernere に無い。現状は
  `POST /api/identity/face-consent/revoke` の `reason` で表現する。卒業イベントが
  Cernere 側に入った時点でそこから積む。
- 「facility 制限」は `facilityId` 必須 + 応答をその施設に限定する形で実装した。
  tool client と施設を紐付ける仕組みが Cernere に無いため、施設単位の credential 分離は
  別タスク。
