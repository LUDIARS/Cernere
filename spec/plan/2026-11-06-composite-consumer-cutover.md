# Composite切替の有限consumer一覧

2026-11-06時点。Cr #3627は `b2bc69cf2130c719fa4db3db9cdcf44f4c5f5836` にmerge済み、未配備。
本一覧はcanonical checkoutの `.git/HEAD = refs/heads/main` と実装本文を読取照合した結果であり、
実際の配備・利用有無・全repoの進行中taskを確認した結果ではない。名前一致だけで改修対象を増やさない。
各所有repoの正式task/並行作業/稼働設定を照合してから移行し、他sessionの既存成果を重複実装しない。

## 旧契約の実装が確認できたconsumer

| 所有repo / caller | 確認した現行実装 | 必須差分 / 現状 |
|---|---|---|
| Corpus / GLAB | `Corpus/server/index.ts`、`public/src/cernere-login.tsx`、GLABのCorpus submodule | 共通認証はCo所有。Co `d57e4c9`、GLAB `3417a52`まで保存済み、未審査。残る経路分類・大容量・target契約・pin/設定整合が必要。 |
| Aedilis meetings | `server/meetings/cernere-login.ts`、`public/src/meetings/account.ts` | code-only→global user→project-token。専用Solへ委託済み、task `4e6c8a10`、WT `Aedilis-feat-meetings-pkce-scoped-session`。meetings外のAeは別残件。 |
| Tendentia | `src/runtime/cernere-client.ts:login`、`web/src/account-view.ts` | code-only exchangeとglobal user→project-token。PKCE/own session/失効guardへ移行。 |
| Ludellus-Server / Tokyo2070 / mmo-mock | `Ludellus-Server/src/mmo/cernereRelay.ts`、`web/mmo-mock/src/auth/cernereLogin.ts`、`Tokyo2070/src/client/auth/cernereLogin.ts` | relayがcode-only→global access/refresh。Tokyo2070はrelayへ渡すbrowser callerであり、別のCr backendを作らない。両browserと所有relayを揃える。 |
| Ludellus personal/desktop | `scripts/personal/cernere-login.mjs`、`renderer/login/login-url.js` | global access/refresh→project-token依存。利用中の起動形態と上記relayとの関係を照合し、共有できるadapterへ集約。 |
| Ostiarius kiosk | `server/face/student-auth-code.ts`、`cernere-consent-client.ts` | `/api/auth/code/exchange`。交換だけでなく本人認証時のkiosk audience/projectと許可scopeの正規発行callerも揃える。旧service-purpose code混用不可。 |
| Cocoiru / Memoria plugin | `apps/memoria-plugin/src/session.ts`、root/vendor native SDK tgz | old NativeComposite設定/API。新service-owned native sessionと最終SDK pin/artifactへ更新。vendorだけ差替えて旧callerを残さない。 |
| Actio | `src/auth/composite.ts`、frontend LoginPage/AuthContext | code-only exchangeからglobal access/refreshを受ける実装あり。自身のsession/認可を維持して移行。 |
| Schedula | `src/auth/composite.ts`、frontend LoginPage/AuthContext | 同上。Actioに似るが所有repo/データACLは別。 |
| Nuntius | `src/auth/composite.ts`、`src/auth/routes.ts` | code-only exchange/global access/refresh。自サービスの認可を残す。 |
| Imperativus | `src/auth/composite.ts`、`auth-api.ts`、public auth callers | global accessをservice tokenへ埋め、WS tokenで取り出す旧経路あり。新scopeを旧global credentialへ戻すescapeを残さない。 |
| Tirocinium | `apps/server/src/auth/cernere-session.ts`、desktop login/session callers | code→global pair→project-tokenとrefresh。desktopのPKCE/own sessionと必要target delegationを揃える。 |
| Tabula / Memoria pointer | `Tabula/server/auth/routes.ts` | code-only→global user→project-token cookie。Memoriaの`services/tabula`はLUDIARS/Tabula submodule。Tabula所有repoで変更しMemoria pointerへ反映、コピーを別実装しない。 |

上記は旧呼出しの存在確認。Ae以外の所有task、現在の稼働利用、既存の別session/PRは未照合。
canonical mainに未移行実装があることと、稼働利用中であることを混同しない。

## host/pointerとfixtureを分ける

- VOBの`corpus`はLUDIARS/Corpus submodule、`env-cli.config.ts`に旧`cernere-project-token`設定がある。
  共通Co実装を重複変更せず、利用中ならhost側のpolicy/設定とpointerを移行する。稼働・taskは未確認。
- Curiaの`apps/corpus`も同じ所有repoだが、`.gitmodules`は別のenterprise branchを指定している。
  embedded sourceの存在だけでGLABと同じ配備対象とは断定しない。実際の使用入口とbranch依存を確認する。
- All-In-OneTest配下のCernere/Actio/Nuntius/Imperativus等は複製した統合fixture候補。
  個別本体と同列の本番consumerとして数えず、現行登録テストとfixture利用の正本を確認してから必要な更新だけ行う。
- Cernere自身のself交換・サンプル・契約testはconsumer数に重複加算しない。

## GLABからの必要target

`GLAB/plugins/downstream-operations.ts`の明示method/path/actionが対象の有限入口である。
対象はAedilis（施設/GPS/予約/meetings/Meet等）、Bibliotheca（図書/貸出）、Tirocinium（面談等）、
Voluptas（review/evidence/media等）。送信元の新`Cernere-Delegation`と受信側の最新データACLを両方実装する。
Voluptas画像15MiB/動画200MiBは後続upload予約契約へ揃える。既存machine principal経路をuser委譲へ混同しない。
対象サービスの無関係な機能改善・全認証方式の再設計はこの一覧の受入ではない。

## 完了の分母と証拠

Cr/SDK基盤、bounded upload後続、Co/GLAB、上記の実使用consumer/必要target、管理者origin/hub_url/
service_operations・同意設定、一斉切替と反映先確認を別々に追う。
以前の68%は上記の全consumerを分母に含めた評価ではなかったため、全体率は再算定まで未確認とする。
Cr基盤のmerge/test_okだけでconsumer移行や環境反映を完了にしない。旧互換を残さず先行deployもしない。
現役利用/既存作業を照合した移行単位だけを実装・審査し、fixture/未使用設定の存在で範囲を無制限に広げない。
