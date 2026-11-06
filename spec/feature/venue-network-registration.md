# feature: 会場ネットワーク限定の新規登録 (venue registration)

**Status: Designed** (2026-11-06、neco 指示。実装は Cr / Os の別タスク)

関連: [mfa-authenticator.md](mfa-authenticator.md) (SPEC-MFA-ONSITE、kiosk レジストリと LAN 内の nonce 受け渡し) /
[../plan/2026-10-14-registration-approval-design-astra.md](../plan/2026-10-14-registration-approval-design-astra.md) (許可制) /
Ostiarius `spec/feature/onsite-mfa-factor.md`

## 0. 決定事項 (2026-11-06、neco)

| 論点 | 決定 |
|---|---|
| 登録の条件 | Cr の新規登録に Ostiarius (Os) の確認を要求する。確認の形は **会場のネットワーク限定** (Os の LAN に居る端末からの登録) |
| 組織 | Os は組織情報を持つ。会場で登録した利用者は、その Os の組織のメンバーとして登録する |
| 拠点と組織 | 本社 (本社テスト用 Cr) の Os は **GLabテスト** 組織、AWS (本番 Cr) の Os は **GLab** 組織 |
| 例外 | 会場の外からの登録は例外として扱い、**管理者が判断して弾く** |

## 1. 位置付け

許可制 (案 A) では、パスキー登録した新規ユーザーは `pending` で、system admin が許可すると `active` になる。
本機能は許可制の上に「会場の LAN に居た」ことを示す Os の attestation を足す。

| 登録の経路 | 結果 |
|---|---|
| 会場の LAN 経由 (有効な venue attestation あり) | `active`、Os の組織に `member` として所属 |
| それ以外 (attestation なし) | `pending`、組織なし、`registration_origin = outside_venue`。管理者の審査一覧に「例外」として出し、通常は拒否 (`locked`) する |

これは許可制設計 §R14 の「明示した自動承認ポリシー」に当たる。自動承認の根拠は venue attestation だけで、
CF 認証・組織招待・IP アドレスでは自動承認しない。

## 2. フロー

SPEC-MFA-ONSITE と同じ「端末 → Cr で nonce → 端末 → 会場 LAN 上の Os → Os → Cr へ attestation」の形を使う。
新規登録者は顔もパスキーもまだ持たないので、Os は本人確認をしない。Os が保証するのは
「この nonce が会場 LAN 上の端末から Os へ届いた」ことだけである。

```
[端末 (会場 Wi-Fi)]            [Cernere]                         [Ostiarius (会場 LAN)]
 登録画面を開く ─────────────▶ POST /api/auth/venue-registration/start
                               {challengeId, nonce, expiresAt(5分),
                                kiosks:[{lanId, placeId, lanUrl, label}]}
 ◀────────────────────────────
 kiosk の lanUrl へ nonce ──────────────────────────────────────▶ POST /api/venue-registration/sessions {nonce}
                                                                   (LAN 外の送信元は 403)
                               POST /api/auth/venue-registration/attestations ◀── Os が purpose:"registration" で署名
                               {accepted:true}  challenge に「会場確認済み」を記録
 GET .../venue-registration/status?challengeId (約 2 秒ポーリング) → {state: pending|verified|expired}
 パスキー signup-finish / composite-signup-finish に venueChallengeId を付ける
                               → 検証・一回消費 → user 作成 (active) + organization_members(member)
```

- 端末が LAN の Os に届かない (会場の外) とき、端末は確認待ちのまま期限が切れる。登録画面は
  「会場の Wi-Fi に接続してください」を出し、そのまま登録を続けることもできる (例外経路、`pending`)。
- 端末から LAN の Os へは HTTPS で送る (Os `spec/feature/lan-https-and-lan-url.md`)。
  Os は Cr のログイン画面の origin だけを CORS で許可する。
- Os の受け口は送信元が施設 LAN (Os の設定にある LAN の範囲) のときだけ受け付ける。

## 3. attestation

形式は SPEC-MFA-ONSITE と同じ `base64url(JSON payload) + "." + base64url(Ed25519 署名)`。payload は固定順で

`{ sub: null, placeId, lanId, nonce, issuedAt, method: "lan", assurance: "network", purpose: "registration" }`

検証 (順番どおり、失敗コード):

1. 署名: 登録済み・active の kiosk 公開鍵 (`onsite_kiosks`) で検証 (`unknown_kiosk` / `revoked_kiosk` / `invalid_signature`)。
2. 用途: `purpose == "registration"` (`purpose_mismatch`)。`mfa` / `attendance` の attestation は受理しない。
   逆に MFA onsite と Aedilis は `registration` を受理しない (Os 側・Cr の onsite verify 側の両方で拒否する)。
3. 束縛: nonce が有効な venue challenge に一致 (`nonce_unknown` / `nonce_used`)。`sub` は null 必須 (`subject_mismatch`)。
4. 鮮度: `issuedAt` が 120 秒以内 (`stale`)。受理時に nonce を原子的に used へ遷移する。
5. 確度: `method == "lan"` かつ `assurance == "network"` (`assurance_insufficient`)。
6. 場所: `placeId` が kiosk の登録施設と一致 (`place_not_allowed`)。
7. 組織: kiosk の `placeId` が `organizations.id` に解決できる (`organization_unknown`)。

Os の呼出には Os の project token を使い、呼出元 project の `service_scopes` に
`venue-registration:submit` の宣言を要る (無ければ 403)。

## 4. 組織の決め方

組織は **Cr に登録された kiosk の `placeId`** で決まる。`placeId` は組織の `organizations.id` (UUID) とする。
Os の設定 `OSTIARIUS_FACILITY_ID` に同じ UUID を入れる (顔の同意・失効の facilityId も同じ値。
Os が UUID でない施設 ID `glab-main` を送って face-consents が 400 になっている不具合もこれで解消する)。

attestation 自体には組織を載せない。Os が任意の組織を名乗っても、Cr は kiosk 登録時に admin が決めた
`placeId` だけを使う。

| 拠点 | Cr | Os の組織 (placeId) |
|---|---|---|
| 本社 | `cernere-test` (DB `cernere_test`) | GLabテスト |
| AWS | `cernere` (本番) | GLab |

各拠点の組織の作成と kiosk の登録 (`POST /api/admin/onsite-kiosks`) は admin が行う。
本社の Os は現在 AWS の本番 Cr を向いているので、本社テストでは `cernere-test` を向ける。
本番の GLab 組織用 Os は会場 (学校) の LAN に置く。

## 5. データ

migration で追加する (番号は実装時に main の最大番号から採番する):

- `venue_registration_challenges` — `id uuid PK`, `nonce_hash text unique`, `expires_at`, `verified_at`,
  `lan_id`, `place_id`, `consumed_at`, `created_at`。nonce は SHA-256 で保存し、平文は発行時の応答だけで返す。
- `users.registration_origin text` — `venue` | `outside_venue` | NULL (本機能以前の登録)。
- `users.registration_place_id text` — 会場登録時の placeId。

challenge の作成は未認証で呼べるので、接続元ごとのレート制限 (既存 `credential-rate-limit` の枠) をかける。
期限切れの challenge は 1 日で回収する。

## 6. API

| 口 | 認可 | 結果 |
|---|---|---|
| `POST /api/auth/venue-registration/start` | 未認証 (レート制限) | `{ challengeId, nonce, expiresAt, kiosks }`。active kiosk が無ければ 503 |
| `POST /api/auth/venue-registration/attestations` `{ attestation }` | Os project token + `venue-registration:submit` | `{ accepted: true }` / 4xx `{ error }` |
| `GET /api/auth/venue-registration/status?challengeId=` | 未認証 | `{ state }`。lanId / placeId は返さない |
| `signup-finish` / `composite-signup-finish` に `venueChallengeId?` | 既存 | 下記 |

signup の扱い:

- `venueChallengeId` が verified かつ未消費・期限内 → 同じトランザクションで challenge を消費し、
  user を `access_status = active`、`registration_origin = venue` で作り、`organization_members` に `member` で入れる。
- 指定なし → 従来どおり `pending`、`registration_origin = outside_venue`。
- 指定ありで無効 (未確認・期限切れ・消費済み) → 422 `venue_challenge_invalid`。何も作らない
  (例外経路に黙って落とさない。端末は指定を外して例外経路を選び直せる)。

## 7. 管理者の審査

既存の許可待ち一覧に `registration_origin` を出す。`outside_venue` は「会場外からの登録 (例外)」と表示し、
拒否 (`locked`) を既定の操作にする。許可も従来どおりできる (fresh passkey action proof 必須)。
会場登録 (`venue`) で自動許可された利用者も、一覧で後から停止できる。

## 8. 脅威

| 脅威 | 対策 |
|---|---|
| 会場外の端末が nonce を会場内の協力者に渡す | 防げない。nonce の期限 5 分と 1 回消費で範囲を絞る。管理者は一覧で事後に停止できる |
| attestation の使い回し・他用途への流用 | purpose 分離 + nonce 一回消費 + 鮮度 120 秒 |
| Os を名乗って任意の組織に入れる | 組織は Cr の kiosk 登録 (admin 所有) からしか決まらない。attestation は登録済み鍵でのみ検証 |
| challenge の大量発行 | 未認証の口に接続元ごとのレート制限、nonce はハッシュで保存 |
| 例外経路の悪用 | pending のまま。許可制の最低限の権限 (本人の Cr 設定のみ) に留まる |

## 9. 受け入れ条件

- 会場 LAN の端末から登録すると、`active` かつ Os の組織の member になる (本社テスト: GLabテスト)。
- 会場外の端末から登録すると `pending`・組織なし・`outside_venue` になり、管理画面で例外として拒否できる。
- `mfa` / `attendance` の attestation、期限切れ・使用済み nonce、未登録 kiosk の attestation は受理しない。
- 既存の MFA onsite と Aedilis の出席は `registration` の attestation を受理しない。

## 10. 実装の分担

| リポ | 内容 |
|---|---|
| Cernere | migration、§6 の API、signup の分岐、許可待ち一覧の表示、登録画面の会場確認 (LAN の Os への送信とポーリング)、MFA onsite 側の `registration` 拒否 |
| Ostiarius | `POST /api/venue-registration/sessions` (LAN 送信元限定・CORS)、`purpose: "registration"` の署名と Cr への送信、出席・MFA 経路での `registration` 拒否、`OSTIARIUS_FACILITY_ID` を組織 UUID にする設定変更 |
