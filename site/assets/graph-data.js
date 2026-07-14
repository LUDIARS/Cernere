// Domain + feature model for graph.html.
// Domains are the architectural areas; each has features; deps are "depends on" edges.
window.CERNERE_GRAPH = {
  domains: [
    { id: "auth", label: "認証 (Authentication)", core: true, features: [
      "メール/パスワード (bcrypt)", "GitHub/Google OAuth", "Passkey (WebAuthn)",
      "MFA (TOTP/SMS/Email)", "トークン発行 (access/refresh/project/tool)", "リフレッシュ・ローテーション",
    ]},
    { id: "session", label: "セッション状態 (Session State)", features: [
      "状態機械 none→logged_in→expired", "Redis TTL 7 日", "SessionRegistry", "ping/pong 生存検証",
    ]},
    { id: "wsproto", label: "WS プロトコル", features: [
      "/auth (user)", "/ws/project", "/auth/composite-ws", "メッセージリレー (同一ユーザー)",
    ]},
    { id: "dispatch", label: "コマンドディスパッチ (RPC)", core: true, features: [
      "module_request 振り分け", "4 層防御ゲート", "権限チェック", "operation_logs 記録",
    ]},
    { id: "oidc", label: "OIDC Provider", features: [
      "authorize + PKCE(S256)", "token / id_token (RS256)", "userinfo", "Discovery / JWKS", "RP クライアント管理", "同意 UI",
    ]},
    { id: "project", label: "プロジェクト管理", core: true, features: [
      "サービス動的登録", "project_data_<key> 生成", "スキーマ版履歴", "論理削除 (is_active)",
    ]},
    { id: "connreg", label: "接続レジストリ (使用中バッジ)", features: [
      "addConnection/removeConnection", "connectionCount", "lastConnected/Disconnected",
    ]},
    { id: "relay", label: "Peer リレー", features: [
      "relay_pairs 許可", "endpoint 登録", "challenge 検証 (60s/単回)", "verify_token round-trip",
    ]},
    { id: "oauthtok", label: "OAuth トークン保管", features: [
      "project_oauth_tokens", "store/get/list/delete", "個人データ単一情報源", "UPSERT",
    ]},
    { id: "idverify", label: "本人確認 (Identity Verification)", features: [
      "デバイスフィンガープリント", "異常検知", "6 桁コード (10分/5回)", "trusted_devices",
    ]},
    { id: "audit", label: "監査ログ", features: [
      "operation_logs", "成功/失敗の記録", "WS 接続イベント記録",
    ]},
    { id: "profile", label: "ユーザープロフィール / PII", features: [
      "user_profiles (bio/expertise)", "プライバシー設定", "data optouts", "passkeys / trusted_devices",
    ]},
    { id: "org", label: "組織管理", features: [
      "organizations", "メンバーロール", "org ごとのプロジェクト有効化",
    ]},
    { id: "userrow", label: "ユーザー行初期化", features: [
      "ensureUserProjectRow", "冪等 (ON CONFLICT DO NOTHING)", "open_url / composite 起点",
    ]},
    { id: "tool", label: "ツール認証", features: [
      "client_credentials", "scopes in JWT", "tool_clients",
    ]},
    { id: "svcreg", label: "サービスレジストリ", features: [
      "service_registry", "service secret (bcrypt)", "service_tickets (SSO)",
    ]},
  ],
  // from depends-on to
  deps: [
    ["session", "auth"],
    ["wsproto", "session"], ["wsproto", "auth"],
    ["dispatch", "auth"], ["dispatch", "session"], ["dispatch", "audit"],
    ["dispatch", "project"], ["dispatch", "oidc"], ["dispatch", "idverify"],
    ["dispatch", "userrow"], ["dispatch", "oauthtok"], ["dispatch", "relay"],
    ["dispatch", "org"], ["dispatch", "profile"],
    ["connreg", "project"], ["connreg", "wsproto"],
    ["relay", "auth"], ["relay", "project"],
    ["idverify", "auth"],
    ["oauthtok", "project"],
    ["userrow", "project"], ["userrow", "auth"],
    ["profile", "auth"],
    ["org", "auth"],
    ["tool", "auth"],
    ["svcreg", "auth"],
    ["oidc", "auth"], ["oidc", "session"], ["oidc", "audit"],
  ],
};
