---
task: service-consent-rollout
project: Cernere
kind: 展開
created: 2026-10-15
memory_links:
  - spec/plan/2026-10-15-service-consent-design.md
---

# 権限確認 (consent) の全サービス展開

## 目的

サービス初回ログイン時の権限確認 ([設計](../plan/2026-10-15-service-consent-design.md)、main 反映済み・AWS 反映済み) を、
Cernere でログインする全サービスで `consent_mode: enforce` にする (neco 2026-10-15「Cr 実装するサービスで全て考慮」)。
マージ時点の既定は `off` なので、サービスごとに宣言と画面対応を済ませてから切り替える。

## 対象の洗い出し

1. 正本拠点 (AWS) の `managed_projects` (is_active) と `oidc_clients` (is_active) を一覧にし、下表に無いものを足す。
2. `CERNERE_COMPOSITE_ALLOWED_ORIGINS` に載っている origin を、どのサービスかに対応付ける。

| サービス | Cernere 側の登録 | 経路 (把握している範囲) |
|---|---|---|
| Memoria | managed project `memoria` | composite / open_url |
| Imperativus | managed project `imperativus` (memoria seed で登録) | composite |
| Legatus | managed project `legatus` | project WS |
| Actio | managed project `actio` (legatus seed で登録) | composite |
| Ludellus | managed project `ludellus` | composite |
| Tirocinium | managed project `tirocinium` | composite |
| Tendentia | managed project `tendentia` | composite (tendentia.ai-run-do.com) |
| Voluptas | managed project + OIDC client (`CERNERE_OIDC_CLIENT_ID`) | OIDC |
| GLAB | managed project (glab bot) | composite / silent SSO (glab / glm.ai-run-do.com) |
| Aedilis | (登録を確認) | composite (ae.ai-run-do.com) |
| Tokyo2070 | (登録を確認) | composite |
| Excubitor | launch credential | サービス間認証のみなら対象外 (確認) |
| EducationLab / Vantan | managed project (education-lab) | composite |
| Cloudflare Access | OIDC client | OIDC (`oidc_client.update_consent`) |

## 各サービスで行うこと (受入条件)

1. `schema_definition.consent` を宣言する (必須/推奨・purpose・visible_to)。上限 (profile_access / identity_claims /
   user_data module / oidc scopes) の外は保存できないので、足りなければ管理者に上限を頼む。
2. silent SSO・project WS 経路で `consent_required` を受けたら `consentUrl` を popup で開く。
3. `consent_denied` で「権限が許可されなかったため利用できません」を表示する。
4. 推奨を外した項目が null / 拒否で返る前提で画面が壊れない。
5. 管理者が `consent_mode` を `warn` にし、`consent.would_block` のログで漏れが無いことを確かめてから `enforce` にする。

## 完了条件

- 表の全サービスが `enforce` で、初回ログイン時に権限確認が出る。
- 全サービスが `enforce` になったら、Cernere の `consent_mode` の既定を `enforce` に変える (設計 §6)。
