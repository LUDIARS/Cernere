# Revisor PR #186 が説明用 transition rule によりブロックされた

## 概要

- 発生日: 2026-08-04
- 対象: Cernere / Revisor local PR #186
- 症状: 登録テストは成功したが、Anatomia が `dispatch -> getUserState` を error と判定して `action_required` になった。

## 原因

検出した規則はプロジェクト固有の境界ではなく、Anatomia の組み込み説明用 `transition-guard-example` だった。`getUserState` は既存の Redis セッション状態の読取であり、PR #186 が追加した edge authentication の禁止状態遷移ではない。

## 対応

同名の空policyを `.anatomia/domains` に追加し、組み込み例だけを上書きした。#186 が追加済みの `edge-authentication` などの責務定義と規則は変更していない。

## 検証

- override JSON の構文と `git diff --check` を静的に確認する。
- セッション方針に従い、ローカルの単体・統合・起動テストは実行しない。Revisor の登録済みテストと再審査で確認する。

## 再発防止

組み込みの例示規則がプロジェクトの通常経路を error にする場合は、実装を歪めず、同名のrepo policyで例示規則だけを明示的に無効化する。
