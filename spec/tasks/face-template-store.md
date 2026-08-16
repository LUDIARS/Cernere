---
task: face-template-store
project: Cernere
kind: 実装
status: completed
---

# 顔テンプレート保存・配布

## 目的

顔テンプレートを Cernere の暗号化された正本として保持し、施設単位で安全に配布・撤回できるようにする。

## 完了条件

- [x] AES-256-GCM 保存、施設別再暗号化 export、同意・tombstone API を実装する。
- [x] passkey export に role・facility 情報と施設フィルタを追加する。
- [x] プロフィールで顔認証登録状態の確認・削除を可能にする。
- [x] サーバー／フロントエンドのビルド型検査を通す。
