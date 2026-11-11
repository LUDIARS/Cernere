# feature: GLab の入会・OB 切り替えと GitHub チーム管理 (SPEC-GLAB-MEMBERSHIP-GITHUB)

決定: neco 2026-11-10。関連: [glab-alumni-registration.md](glab-alumni-registration.md) (登録画面の在校生/OB タブ)、
[admin-menu-and-org-leader.md](admin-menu-and-org-leader.md) (リーダー)。

## 0. 決定事項

| 論点 | 決定 |
|---|---|
| 記録 | GLab に入会したとき・卒業して OB になったときを Cernere で管理する |
| 切り替える人 | GLab 組織のリーダー以上 (`organization` の leader/maintainer/admin/owner) とシステム管理者。本人は自分の区分を変えられない |
| GitHub | GLab の GitHub 組織のアクセス権とチーム登録を Cernere から管理する |
| チーム | **在校生チーム** と **OB チーム** に分ける |
| リポジトリ | 基本は **private** 運用。public では作れない |
| 在校生 | 在校生が作ったリポジトリを読み書きできる |
| OB | 在校生のリポジトリは **読むだけ**。自分でリポジトリを作れる (private のみ)。作った本人が管理する |
| 自動の権限 | 在校生が作ったリポジトリにだけ、在校生チーム=読み書き・OB チーム=読むだけを自動で付ける。OB が作ったものには付けない |
| 食い違い | GitHub 側の状態と Cernere の記録が違えば確認画面に出す |

## 1. 状態

| 区分 | 記録 | 在校生チーム | OB チーム |
|---|---|---|---|
| 在校生 (`student`) | `joined_at` | 入れる (未参加なら組織に招待される) | 外す |
| OB (`alumni`) | `alumni_at` | 外す | 入れる |

- 在校生 → OB の一方向。OB → 在校生への戻しは誤操作の訂正として「在校生に戻す」で行える (記録は残す)。
- GitHub アカウントをつないでいない人は「未連携」と出し、GitHub への反映を保留する。連携後に「GitHub に反映」で反映する。
- 反映に失敗したら理由を記録に残し、画面に出す (記録の変更自体は取り消さない)。

## 2. リポジトリの権限

- GitHub の `repository` webhook (`created`) を受け、作った人 (`sender`) を Cernere の GitHub 連携から引く。
  - 在校生なら: 在校生チーム `push`、OB チーム `pull` を付ける。
  - OB・不明なら: 何もしない (作った本人が決める)。
- 組織の設定 (システム管理者が「組織の設定を反映」): メンバーの private リポジトリ作成を許可、public・internal の作成を禁止、
  既定の権限を `none`。この設定はチームごとに分けられないため、在校生も private を作れる。
- これ以外の個別の権限は GitHub で直接付けてよい。確認画面には出さない (チーム所属の食い違いだけを出す)。

## 3. 確認画面 (照合)

GitHub の 2 チームのメンバーと Cernere の記録を比べ、次を出す:

| 種類 | 例 |
|---|---|
| `alumni_in_student_team` | OB なのに在校生チームに残っている |
| `student_missing` | 在校生なのに在校生チームにいない |
| `alumni_missing` | OB なのに OB チームにいない |
| `student_in_alumni_team` | 在校生なのに OB チームにいる |
| `unknown_member` | チームにいるが、Cernere の記録に無い (GitHub 未連携を含む) |
| `unlinked` | Cernere の記録はあるが GitHub 未連携 |

## 4. データ (migration 082)

- `glab_memberships`: `organization_id uuid`, `user_id uuid` (PK 2 列)、`status text (student|alumni)`, `joined_at`, `alumni_at`,
  `github_synced_at`, `github_sync_error`, `updated_by uuid`, `updated_at`。
- `glab_github_repos`: `repo_full_name text PK`, `creator_github_id bigint`, `creator_user_id uuid`, `creator_status text`,
  `granted_at`, `created_at`。webhook で受けたリポジトリと、自動で権限を付けたかの記録。

## 5. 設定 (Vault: cernere)

| キー | 内容 |
|---|---|
| `CERNERE_GLAB_ORGANIZATION_ID` | Cernere の GLab 組織 ID (本社テストは GLabテスト、本番は GLab) |
| `CERNERE_GLAB_GITHUB_ORG` | GitHub の組織名 |
| `CERNERE_GLAB_GITHUB_APP_ID` / `CERNERE_GLAB_GITHUB_INSTALLATION_ID` | GitHub App |
| `CERNERE_GLAB_GITHUB_APP_PRIVATE_KEY` | GitHub App の秘密鍵 (PEM) |
| `CERNERE_GLAB_GITHUB_WEBHOOK_SECRET` | webhook の署名鍵 |
| `CERNERE_GLAB_GITHUB_STUDENT_TEAM` / `CERNERE_GLAB_GITHUB_ALUMNI_TEAM` | チームの slug (既定 `students` / `alumni`) |

`CERNERE_GLAB_ORGANIZATION_ID` が無ければ在籍の記録も無効。GitHub の値が欠けていれば記録だけを行い、反映は「未設定」として保留する。

## 6. API

WebSocket `glab_membership` (GLab 組織の leader 以上 / システム管理者):

| action | 内容 |
|---|---|
| `list` | 組織メンバーと在籍記録・GitHub 連携の有無 |
| `join {userId}` | 在校生として入会を記録し、GitHub に反映 |
| `graduate {userId}` | OB に切り替え、GitHub に反映 |
| `restore_student {userId}` | 誤操作の訂正 (OB → 在校生) |
| `sync {userId}` | GitHub に反映し直す |
| `reconcile` | §3 の照合結果 |
| `apply_org_settings` | §2 の組織設定 (システム管理者のみ) |

HTTP `POST /api/glab/github/webhook` (`X-Hub-Signature-256` 必須): `repository.created` で §2 の自動付与。

## 7. GitHub App に要る権限

- Organization: Members (read & write)、Administration (read & write、組織設定)
- Repository: Administration (read & write、チームへのリポジトリ権限)、Metadata (read)
- Webhook: Repository イベント

## 8. 人にお願いすること

1. GLab の GitHub 組織に「在校生チーム」と「OB チーム」を作る (slug を §5 に入れる)。
2. GitHub App を作り §7 の権限で GLab 組織に入れる。Webhook URL は `https://<Cernere>/api/glab/github/webhook`、
   Secret を決める。
3. §5 の値を Excubitor の Vault (cernere) に登録して Cernere を再起動する。
4. 管理画面の「組織」→ GLab →「組織の設定を反映」を押す (システム管理者)。

## 9. 実装 (Cernere)

| 責務 | 置き場所 |
|---|---|
| 設定 | `server/src/glab/glab-config.ts` |
| 状態遷移・チーム・権限の規則 (純粋) | `server/src/glab/membership-policy.ts` |
| 照合 (純粋) | `server/src/glab/reconcile.ts` |
| 記録の保存 | `server/src/glab/membership-store.ts` |
| GitHub App 認証と API | `server/src/glab/github-app.ts` / `github-org-client.ts` |
| 反映 | `server/src/glab/github-sync.ts` |
| webhook | `server/src/glab/github-webhook.ts`、HTTP は `server/src/http/glab-github-routes.ts` |
| WebSocket コマンド | `server/src/glab/glab-membership-command.ts` |
| 画面 | `frontend/src/pages/organizations/GlabMembershipPanel.tsx` (組織画面の GLab 組織に出す) |
