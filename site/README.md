# Cernere ドキュメントサイト (`site/`)

Cernere のサービス概要・ドメイングラフ・API リファレンス・仕様レビューを
GitHub Pages で公開するための静的サイト。ビルド不要の素の HTML/CSS/JS。

## ページ構成

| ファイル | 内容 |
|---|---|
| `index.html` | サービスの役割・特徴・設計（セキュリティモデル / 認可 / 技術スタック / トークン署名） |
| `graph.html` | ドメインと機能、その依存関係を示すインタラクティブグラフ（vis-network） |
| `api.html` | REST / WebSocket の全エンドポイント。トグル展開で詳細・パラメータを確認 |
| `review.html` | `spec/` 資料とコードの対応状況・乖離点のレビュー結果 |

### データソース（更新時はここを編集）

| ファイル | 役割 |
|---|---|
| `assets/api-data.js` | API インベントリ（`window.CERNERE_API`）。`api.html` の唯一の真実源 |
| `assets/graph-data.js` | ドメイン / 機能 / 依存関係（`window.CERNERE_GRAPH`） |
| `assets/style.css` | 共通スタイル | 
| `assets/nav.js` | 共通ヘッダー / フッター |
| `assets/api.js` / `assets/graph.js` | レンダラ |

## 公開

`main` への push で `.github/workflows/pages.yml` が `site/` を Pages にデプロイする。
リポジトリ設定の **Settings → Pages → Build and deployment → Source** を
**GitHub Actions** にしておくこと。

## ローカルプレビュー

```bash
cd site && python3 -m http.server 8000
# http://localhost:8000 を開く
```

> グラフは vis-network を CDN から読み込む。オフライン時はテキスト表現に自動フォールバックする。
