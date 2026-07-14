// Cernere API inventory — source of truth for api.html.
// Derived from server/src/http/*, server/src/commands.ts and server/src/ws/*.
// Each endpoint renders as a toggle-expandable <details> block.
window.CERNERE_API = [
  /* ============================ REST: Auth ============================ */
  {
    group: "REST — 認証 (/api/auth)",
    desc: "ユーザー / プロジェクト / ツールの認証とトークン管理。公開境界の中心。",
    endpoints: [
      {
        method: "POST", path: "/api/auth/register", auth: "public",
        summary: "メール + パスワードで新規ユーザー登録",
        body: [
          { n: "name", t: "string", r: true, d: "表示名" },
          { n: "email", t: "string", r: true, d: "メールアドレス" },
          { n: "password", t: "string", r: true, d: "8 文字以上" },
        ],
        returns: "201 · { user: { id, displayName, email, role }, accessToken, refreshToken }",
        notes: [
          "最初の登録ユーザーは role=admin、以降は general。",
          "レート制限: email あたり 5 回 / 600 秒。",
        ],
      },
      {
        method: "POST", path: "/api/auth/login", auth: "public",
        summary: "ユーザー / プロジェクト / ツールのログイン（grant_type で分岐）",
        body: [
          { n: "email", t: "string", r: false, d: "ユーザーログイン時" },
          { n: "password", t: "string", r: false, d: "ユーザーログイン時" },
          { n: "grant_type", t: '"client_credentials" | "project_credentials"', r: false, d: "ツール / プロジェクト認証時" },
          { n: "client_id", t: "string", r: false, d: "ツール / プロジェクト認証時" },
          { n: "client_secret", t: "string", r: false, d: "ツール / プロジェクト認証時" },
        ],
        returns: "200 · user: { user, accessToken, refreshToken } | MFA 要求時 { mfaRequired:true, mfaMethods } / tool: { tokenType:'tool', accessToken, expiresIn, client } / project: { tokenType:'project', accessToken, expiresIn, project }",
        notes: [
          "MFA 有効時は 200 + mfaRequired:true を返す。",
          "レート制限: user 10/900s/email、project 10/300s/client_id。",
        ],
      },
      {
        method: "POST", path: "/api/auth/refresh", auth: "public",
        summary: "リフレッシュトークンを新しいトークンペアに交換（ローテーション）",
        body: [{ n: "refreshToken", t: "string", r: true, d: "発行済みリフレッシュトークン" }],
        returns: "200 · { accessToken, refreshToken }",
        notes: ["DB の refresh_sessions レコードを新トークンで更新。"],
      },
      {
        method: "POST", path: "/api/auth/logout", auth: "public",
        summary: "リフレッシュトークンを失効",
        body: [{ n: "refreshToken", t: "string", r: false, d: "失効対象（任意）" }],
        returns: '200 · { message: "Logged out" }',
      },
      {
        method: "POST", path: "/api/auth/verify", auth: "public",
        summary: "トークン（user / project）の検証・introspection",
        body: [{ n: "token", t: "string", r: true, d: "検証する JWT" }],
        returns: "200 · { valid:true, tokenType:'project'|'user', project|user } | { valid:false }",
        notes: ["どのトークン種別が有効かを過度に漏らさない設計。", "レート制限: 60/60s/IP。"],
      },
      {
        method: "POST", path: "/api/auth/exchange", auth: "public",
        summary: "ワンタイム authCode をフルトークンセットに交換",
        body: [{ n: "code", t: "string", r: true, d: "OAuth / passkey フローで発行された code" }],
        returns: "200 · { accessToken, refreshToken, user }",
        notes: ["Redis 上の code は単回限り（GETDEL）。TTL 60s（OAuth）/ 300s（passkey）。"],
      },
      {
        method: "POST", path: "/api/auth/project-token", auth: "bearer (user)",
        summary: "認証済みユーザー向けに短命のプロジェクト別トークンを発行",
        body: [
          { n: "project_key", t: "string", r: true, d: "プロジェクト識別子（旧 project_id も可）" },
          { n: "hub_url", t: "string", r: false, d: "宛先サービス URL。指定で PASETO/EdDSA・aud 付与" },
        ],
        returns: "200 · hub_url 有: { tokenType:'user_for_project', accessToken(PASETO EdDSA), expiresIn:900, audience, alg:'EdDSA' } / 無: HS256 fallback, expiresIn:3600",
        notes: ["要 Authorization: Bearer <user accessToken>。", "レート制限: 60/60s/(userId, projectKey)。", "404: プロジェクト未登録 / 無効。"],
      },
      {
        method: "GET", path: "/api/auth/me", auth: "bearer (user)",
        summary: "認証済みユーザーのプロフィール取得",
        returns: "200 · { id, name, email, role, hasGoogleAuth, hasPassword, googleScopes[] }",
      },
    ],
  },

  /* ============================ REST: Passkey ============================ */
  {
    group: "REST — Passkey (WebAuthn / FIDO2)",
    desc: "公開鍵ベースの登録・ログイン。/api/auth/passkey/* 配下。",
    endpoints: [
      {
        method: "POST", path: "/api/auth/passkey/register-begin", auth: "bearer (user)",
        summary: "登録開始 — チャレンジ生成（PublicKeyCredentialCreationOptions）",
        returns: "200 · { challenge, rp, user, pubKeyCredParams, excludeCredentials, authenticatorSelection }",
        notes: ["challenge は Redis passkey:challenge:reg:{userId}（TTL 300s）。"],
      },
      {
        method: "POST", path: "/api/auth/passkey/register-finish", auth: "bearer (user)",
        summary: "登録完了 — アサーション検証して保存",
        body: [
          { n: "response", t: "RegistrationResponseJSON", r: true, d: "WebAuthn 応答" },
          { n: "nickname", t: "string", r: false, d: "資格情報の表示名（最大 64）" },
        ],
        returns: "201 · { ok:true, credentialId, nickname, deviceType, backedUp }",
        notes: ["userVerification 必須。counter のクローン検出あり。"],
      },
      {
        method: "POST", path: "/api/auth/passkey/login-begin", auth: "public",
        summary: "ログイン開始 — 認証用チャレンジ生成",
        body: [{ n: "email", t: "string", r: false, d: "指定で対象ユーザーに限定（usernameless 可）" }],
        returns: "200 · { options(PublicKeyCredentialRequestOptions), challengeOwner }",
        notes: ["レート制限: 30/900s/(email|IP)。"],
      },
      {
        method: "POST", path: "/api/auth/passkey/login-finish", auth: "public",
        summary: "ログイン完了 — JWT トークンを返す",
        body: [
          { n: "response", t: "AuthenticationResponseJSON", r: true, d: "WebAuthn 応答" },
          { n: "challengeOwner", t: "string", r: true, d: "login-begin で得た値" },
        ],
        returns: "200 · { user, accessToken, refreshToken }",
      },
      {
        method: "POST", path: "/api/auth/passkey/composite-login-finish", auth: "public",
        summary: "composite（ポップアップ）フロー用 — 直接 JWT ではなく authCode を返す",
        body: [
          { n: "response", t: "AuthenticationResponseJSON", r: true, d: "WebAuthn 応答" },
          { n: "challengeOwner", t: "string", r: true, d: "login-begin で得た値" },
        ],
        returns: "200 · { authCode }（後で /api/auth/exchange）",
      },
      {
        method: "POST", path: "/api/auth/passkey/list", auth: "bearer (user)",
        summary: "登録済み passkey 一覧（プロフィール管理用）",
        returns: "200 · { items: [{ id, credentialId, nickname, deviceType, backedUp, aaguid, createdAt, lastUsedAt }] }",
      },
      {
        method: "POST", path: "/api/auth/passkey/delete", auth: "bearer (user)",
        summary: "passkey 資格情報を削除",
        body: [{ n: "id", t: "string", r: true, d: "passkey 内部 ID" }],
        returns: "200 · { ok:true, removed }",
      },
      {
        method: "GET", path: "/api/auth/passkey/export", auth: "bearer (admin | project)",
        summary: "passkey 一括エクスポート（オフライン検証 / Ostiarius 等）",
        params: [{ n: "project", t: "string", r: false, d: "プロジェクトキー（将来のフィルタ用）" }],
        returns: "200 · { credentials: [{ userId, credentialId, publicKey, counter, transports }] }",
        notes: ["admin ユーザー JWT またはプロジェクトトークンが必要。公開鍵のみ返す。"],
      },
    ],
  },

  /* ============================ REST: Composite Auth ============================ */
  {
    group: "REST — Composite Auth (/api/auth/composite)",
    desc: "別サービスに埋め込んだログイン UI 用。資格情報検証 → ticket → デバイス確認 WS。",
    endpoints: [
      {
        method: "POST", path: "/api/auth/composite/login", auth: "public",
        summary: "メール/パスワード検証 → デバイス確認用 ticket を返す",
        body: [
          { n: "email", t: "string", r: true, d: "" },
          { n: "password", t: "string", r: true, d: "" },
        ],
        returns: "200 · { deviceVerificationRequired:true, ticket, wsPath } | { mfaRequired:true, mfaMethods }",
        notes: ["auth_session を Redis に作成（TTL 10 分）。レート制限 10/900s/email。"],
      },
      {
        method: "POST", path: "/api/auth/composite/register", auth: "public",
        summary: "新規登録 → composite セッションを開く",
        body: [
          { n: "name", t: "string", r: true, d: "表示名" },
          { n: "email", t: "string", r: true, d: "" },
          { n: "password", t: "string", r: true, d: "8 文字以上" },
        ],
        returns: "200 · { deviceVerificationRequired:true, ticket, wsPath }",
      },
      {
        method: "POST", path: "/api/auth/composite/mfa-verify", auth: "public",
        summary: "MFA 検証後に composite セッションを開く",
        body: [
          { n: "mfaToken", t: "string", r: true, d: "login で返された token" },
          { n: "method", t: "string", r: true, d: "MFA 方式" },
          { n: "code", t: "string", r: true, d: "検証コード" },
        ],
        returns: "200 · { deviceVerificationRequired:true, ticket, wsPath }",
      },
    ],
  },

  /* ============================ REST: OAuth callbacks ============================ */
  {
    group: "REST — OAuth プロバイダ連携",
    desc: "GitHub / Google OAuth の開始・コールバック。CSRF state + composite モード対応。",
    endpoints: [
      {
        method: "GET", path: "/auth/github/login", auth: "public",
        summary: "GitHub OAuth 開始（authorize へリダイレクト）",
        params: [{ n: "composite_origin", t: "string", r: false, d: "ポップアップ呼び出し元 origin" }],
        returns: "302 · github.com/login/oauth/authorize へ（scope: read:user user:email repo）",
        notes: ["cernere_csrf_state Cookie（600s, HttpOnly, Secure, SameSite=Lax）。"],
      },
      {
        method: "GET", path: "/auth/github/callback", auth: "public",
        summary: "GitHub コールバック — ユーザー作成 / 連携",
        params: [
          { n: "code", t: "string", r: true, d: "OAuth 認可コード" },
          { n: "state", t: "string", r: true, d: "CSRF state" },
        ],
        returns: "302 · 通常: / へ（ars_session Cookie）/ composite: /composite/callback?code= へ",
      },
      {
        method: "GET", path: "/auth/google/login", auth: "public",
        summary: "Google OAuth 開始",
        params: [{ n: "composite_origin", t: "string", r: false, d: "composite origin" }],
        returns: "302 · accounts.google.com（scope: openid email profile, access_type=offline）",
      },
      {
        method: "GET", path: "/auth/google/callback", auth: "public",
        summary: "Google コールバック — ユーザー作成 / 連携、OAuth トークン暗号化保存",
        params: [
          { n: "code", t: "string", r: true, d: "OAuth 認可コード" },
          { n: "state", t: "string", r: true, d: "CSRF state" },
        ],
        returns: "302 · ?authCode= 付きで frontendUrl へ（composite は /composite/callback）",
        notes: ["googleAccessToken / googleRefreshToken は暗号化して DB 保存。"],
      },
    ],
  },

  /* ============================ REST: OIDC Provider ============================ */
  {
    group: "REST — OIDC Provider (IdP)",
    desc: "Cernere を OpenID Connect Provider として外部 RP に公開。id_token は RS256。",
    endpoints: [
      {
        method: "GET", path: "/oidc/authorize", auth: "public",
        summary: "OIDC 認可エンドポイント（authorization code + PKCE）",
        params: [
          { n: "client_id", t: "string", r: true, d: "登録済み RP" },
          { n: "redirect_uri", t: "string", r: true, d: "コールバック URI" },
          { n: "response_type", t: '"code"', r: true, d: "" },
          { n: "scope", t: "string", r: true, d: "例: openid email profile" },
          { n: "state", t: "string", r: true, d: "CSRF" },
          { n: "code_challenge", t: "string", r: false, d: "PKCE（S256 のみ）" },
          { n: "code_challenge_method", t: "string", r: false, d: "S256" },
          { n: "nonce", t: "string", r: false, d: "id_token バインド" },
        ],
        returns: "302 · redirect_uri?code=&state= / 同意要時 /oidc/consent?request_id=",
        notes: ["認可リクエストは Redis（request_id, TTL 10 分）。"],
      },
      {
        method: "POST", path: "/oidc/token", auth: "client credentials",
        summary: "OIDC トークンエンドポイント（code → tokens）",
        body: [
          { n: "grant_type", t: '"authorization_code"', r: true, d: "" },
          { n: "code", t: "string", r: true, d: "authorize の code" },
          { n: "redirect_uri", t: "string", r: true, d: "authorize と一致" },
          { n: "client_id", t: "string", r: true, d: "" },
          { n: "client_secret", t: "string", r: false, d: "Basic 認証でも可" },
          { n: "code_verifier", t: "string", r: false, d: "PKCE verifier" },
        ],
        returns: '200 · { access_token, id_token(RS256), token_type:"Bearer", expires_in:3600 }',
      },
      {
        method: "GET", path: "/oidc/userinfo", auth: "bearer (OIDC access_token)",
        summary: "OIDC userinfo エンドポイント",
        returns: "200 · { sub, email, email_verified, name, picture }",
        notes: ["401 時 WWW-Authenticate: Bearer error=invalid_token。"],
      },
      {
        method: "GET", path: "/api/auth/oidc/request", auth: "public",
        summary: "同意画面用の認可情報取得（フロント専用）",
        params: [{ n: "request_id", t: "string", r: true, d: "authorize リダイレクト由来" }],
        returns: "200 · { clientId, clientName, scopes[], requestId } | 404",
      },
      {
        method: "POST", path: "/api/auth/oidc/approve", auth: "bearer (user)",
        summary: "ユーザーが認可を承認",
        body: [{ n: "request_id", t: "string", r: true, d: "" }],
        returns: "200 · { redirectUri, code }",
      },
      {
        method: "POST", path: "/api/auth/oidc/deny", auth: "public",
        summary: "ユーザーが認可を拒否",
        body: [{ n: "request_id", t: "string", r: true, d: "" }],
        returns: '200 · { redirectUri, error:"access_denied" }',
      },
    ],
  },

  /* ============================ REST: Discovery / Health ============================ */
  {
    group: "REST — Discovery / Health",
    desc: "公開メタデータと稼働確認。認証不要。",
    endpoints: [
      {
        method: "GET", path: "/.well-known/openid-configuration", auth: "public",
        summary: "OIDC Discovery ドキュメント",
        returns: "200 · { issuer, authorization_endpoint, token_endpoint, userinfo_endpoint, jwks_uri, ... }",
        notes: ["Cache 300s, CORS *。OIDC 未設定時は 503。"],
      },
      {
        method: "GET", path: "/.well-known/jwks.json", auth: "public",
        summary: "OIDC JWKS（id_token 検証用公開鍵 / RS256）",
        returns: "200 · { keys: [{ kid, kty, use, alg, n, e }] }",
      },
      {
        method: "GET", path: "/.well-known/cernere-public-key", auth: "public",
        summary: "プロジェクトトークン検証用 PASETO 公開鍵（EdDSA）",
        returns: "200 · { keys: [...] }",
        notes: ["OIDC とは別。Memoria Hub 等がローカル検証に使用。Cache 600s。"],
      },
      {
        method: "GET", path: "/health", auth: "public",
        summary: "ヘルス / レディネスチェック",
        returns: '200 · { status:"ok", timestamp }',
      },
    ],
  },

  /* ============================ WS: upgrade endpoints ============================ */
  {
    group: "WebSocket — 接続エンドポイント",
    desc: "3 経路。すべて 30s ping / 10s pong で生存検証。",
    endpoints: [
      {
        method: "WS", path: "GET /auth", auth: "token | session_id | guest",
        summary: "ユーザー WS ゲートウェイ（認証セッション）",
        params: [
          { n: "token", t: "string", r: false, d: "新規接続用 JWT/PASETO" },
          { n: "session_id", t: "string", r: false, d: "再接続用セッション ID" },
        ],
        returns: "connected: { session_id, user_state } / ゲストは guest_connected",
        notes: ["最大ペイロード 16MB、idle 120s。token も session_id も無ければゲスト。"],
      },
      {
        method: "WS", path: "GET /ws/project", auth: "project token",
        summary: "プロジェクトサービス WS ゲートウェイ",
        params: [{ n: "token", t: "string", r: true, d: "プロジェクトアクセストークン（EdDSA/PASETO or HS256）" }],
        returns: "connected: { connection_id, project_key, client_id }",
        notes: ["projectKey はセッション束縛。payload で上書き不可。無効時 401。"],
      },
      {
        method: "WS", path: "GET /auth/composite-ws", auth: "ticket",
        summary: "composite 認証のデバイス確認 WS",
        params: [{ n: "ticket", t: "string", r: true, d: "composite login/register の ticket" }],
        returns: "state: { state, data } / authenticated: { authCode }",
        notes: ["最大ペイロード 1MB、idle 60s。auth_session TTL 10 分。"],
      },
    ],
  },

  /* ============================ WS: message envelope ============================ */
  {
    group: "WebSocket — メッセージ種別",
    desc: "WS 上でやり取りされるトップレベルメッセージ。module_request/response が操作の中心。",
    endpoints: [
      {
        method: "WS", path: "→ pong", auth: "session",
        summary: "クライアント → サーバー ハートビート応答",
        body: [{ n: "ts", t: "number", r: true, d: "" }],
        returns: "—",
      },
      {
        method: "WS", path: "→ module_request", auth: "session",
        summary: "クライアント → サーバー コマンド要求",
        body: [
          { n: "module", t: "string", r: true, d: "対象モジュール" },
          { n: "action", t: "string", r: true, d: "アクション" },
          { n: "payload", t: "object", r: false, d: "引数" },
          { n: "request_id", t: "string", r: false, d: "（project WS）応答の相関 ID" },
        ],
        returns: "module_response: { module, action, payload } / error: { code, message }",
      },
      {
        method: "WS", path: "→ relay", auth: "session (認証済み)",
        summary: "クライアント → サーバー メッセージリレー",
        body: [
          { n: "target", t: '"broadcast" | { user } | { session }', r: true, d: "送信先" },
          { n: "payload", t: "object", r: true, d: "中継内容" },
        ],
        returns: "受信側に relayed: { from_session, payload }",
        notes: ["ゲストはリレー不可（guest_restricted）。既定は同一ユーザーのセッション間のみ。"],
      },
      {
        method: "WS", path: "← connected / ← ping / ← state_changed / ← event", auth: "—",
        summary: "サーバー → クライアント の通知系",
        returns: "ping:{ts} / state_changed:{user_state} / event:{event, payload}（例 member.presence）",
      },
    ],
  },

  /* ============================ WS: user modules ============================ */
  {
    group: "WS module — organization",
    desc: "組織の作成・更新・削除・プレゼンス。",
    endpoints: [
      { method: "WS", path: "organization.list", auth: "認証済み", summary: "所属組織の一覧", returns: "OrganizationResponse[]" },
      { method: "WS", path: "organization.get", auth: "認証済み", summary: "組織詳細", body: [{ n: "organizationId", t: "UUID", r: true, d: "" }], returns: "OrganizationResponse" },
      { method: "WS", path: "organization.create", auth: "system admin", summary: "組織作成（作成者が owner）", body: [{ n: "name", t: "string", r: true, d: "" }, { n: "slug", t: "string", r: true, d: "" }, { n: "description", t: "string", r: false, d: "" }], returns: "OrganizationResponse" },
      { method: "WS", path: "organization.presence", auth: "認証済み", summary: "オンラインメンバー一覧", body: [{ n: "organizationId", t: "UUID", r: true, d: "" }], returns: "[{ userId, online }]" },
      { method: "WS", path: "organization.update", auth: "system admin", summary: "組織名 / 説明の更新", body: [{ n: "organizationId", t: "UUID", r: true, d: "" }, { n: "name", t: "string", r: true, d: "" }, { n: "description", t: "string", r: false, d: "" }], returns: "{ ok:true }" },
      { method: "WS", path: "organization.delete", auth: "system admin", summary: "組織削除", body: [{ n: "organizationId", t: "UUID", r: true, d: "" }], returns: "{ ok:true }" },
    ],
  },
  {
    group: "WS module — member",
    desc: "組織メンバーの管理。",
    endpoints: [
      { method: "WS", path: "member.list", auth: "メンバー", summary: "メンバー一覧", body: [{ n: "organizationId", t: "UUID", r: true, d: "" }], returns: "MemberResponse[]" },
      { method: "WS", path: "member.add", auth: "admin/owner/maintainer", summary: "メンバー追加", body: [{ n: "organizationId", t: "UUID", r: true, d: "" }, { n: "userId", t: "UUID", r: true, d: "" }, { n: "role", t: "string", r: false, d: "既定 member。owner 不可" }], returns: "{ ok:true }" },
      { method: "WS", path: "member.update_role", auth: "admin/owner/maintainer", summary: "ロール変更", body: [{ n: "organizationId", t: "UUID", r: true, d: "" }, { n: "userId", t: "UUID", r: true, d: "" }, { n: "role", t: "string", r: true, d: "" }], returns: "{ ok:true }" },
      { method: "WS", path: "member.remove", auth: "admin/owner/maintainer | 自身", summary: "メンバー削除 / 自己退出", body: [{ n: "organizationId", t: "UUID", r: true, d: "" }, { n: "userId", t: "UUID", r: true, d: "" }], returns: "{ ok:true }" },
    ],
  },
  {
    group: "WS module — project_definition",
    desc: "プロジェクト定義テンプレートの CRUD（システム管理者）。",
    endpoints: [
      { method: "WS", path: "project_definition.list", auth: "認証済み", summary: "定義一覧", returns: "ProjectDefinitionResponse[]" },
      { method: "WS", path: "project_definition.get", auth: "認証済み", summary: "定義取得", body: [{ n: "id", t: "UUID", r: true, d: "" }], returns: "ProjectDefinitionResponse" },
      { method: "WS", path: "project_definition.create", auth: "system admin", summary: "定義作成", body: [{ n: "code", t: "string", r: true, d: "" }, { n: "name", t: "string", r: true, d: "" }, { n: "dataSchema", t: "object", r: false, d: "" }, { n: "commands", t: "array", r: false, d: "" }, { n: "pluginRepository", t: "string", r: false, d: "" }], returns: "ProjectDefinitionResponse" },
      { method: "WS", path: "project_definition.update", auth: "system admin", summary: "定義更新", body: [{ n: "id", t: "UUID", r: true, d: "" }, { n: "name", t: "string", r: true, d: "" }, { n: "dataSchema", t: "object", r: false, d: "" }, { n: "commands", t: "array", r: false, d: "" }, { n: "pluginRepository", t: "string", r: false, d: "" }], returns: "{ ok:true }" },
      { method: "WS", path: "project_definition.delete", auth: "system admin", summary: "定義削除", body: [{ n: "id", t: "UUID", r: true, d: "" }], returns: "{ ok:true }" },
    ],
  },
  {
    group: "WS module — org_project",
    desc: "組織ごとのプロジェクト有効化。",
    endpoints: [
      { method: "WS", path: "org_project.list", auth: "メンバー", summary: "有効化済み定義一覧", body: [{ n: "organizationId", t: "UUID", r: true, d: "" }], returns: "ProjectDefinitionResponse[]" },
      { method: "WS", path: "org_project.enable", auth: "admin/owner/maintainer", summary: "プロジェクト有効化", body: [{ n: "organizationId", t: "UUID", r: true, d: "" }, { n: "projectDefinitionId", t: "UUID", r: true, d: "" }], returns: "{ ok:true }" },
      { method: "WS", path: "org_project.disable", auth: "admin/owner/maintainer", summary: "プロジェクト無効化", body: [{ n: "organizationId", t: "UUID", r: true, d: "" }, { n: "projectDefinitionId", t: "UUID", r: true, d: "" }], returns: "{ ok:true }" },
    ],
  },
  {
    group: "WS module — user / profile",
    desc: "ユーザー検索・公開プロフィール、および自分のプロフィール / オプトアウト。",
    endpoints: [
      { method: "WS", path: "user.get", auth: "認証済み", summary: "ユーザープロフィール取得", body: [{ n: "userId", t: "UUID", r: true, d: "" }], returns: "{ id, login, displayName, avatarUrl, email, role }" },
      { method: "WS", path: "user.search", auth: "認証済み", summary: "ユーザー検索（最大 10 件）", body: [{ n: "query", t: "string", r: true, d: "2 文字以上" }], returns: "User[]" },
      { method: "WS", path: "user.get_profile", auth: "認証済み", summary: "公開プロフィール（プライバシー適用）", body: [{ n: "userId", t: "UUID", r: true, d: "" }], returns: "{ roleTitle, bio, expertise, hobbies }" },
      { method: "WS", path: "profile.get", auth: "認証済み", summary: "自分のプロフィール", returns: "{ roleTitle, bio, expertise[], hobbies[], privacy }" },
      { method: "WS", path: "profile.update", auth: "認証済み", summary: "プロフィール更新", body: [{ n: "roleTitle", t: "string", r: false, d: "" }, { n: "bio", t: "string", r: false, d: "" }, { n: "expertise", t: "string[]", r: false, d: "" }, { n: "hobbies", t: "string[]", r: false, d: "" }], returns: "{ ok:true }" },
      { method: "WS", path: "profile.update_privacy", auth: "認証済み", summary: "公開設定の更新", body: [{ n: "privacy", t: "{ bio, roleTitle, expertise, hobbies: boolean }", r: true, d: "" }], returns: "{ ok:true }" },
      { method: "WS", path: "profile.list_optouts", auth: "認証済み", summary: "データ提供オプトアウト一覧", returns: "[{ serviceId, categoryKey, optedOutAt }]" },
      { method: "WS", path: "profile.optout", auth: "認証済み", summary: "オプトアウト（core/personality は該当データ削除）", body: [{ n: "serviceId", t: "string", r: true, d: "" }, { n: "categoryKey", t: "string", r: true, d: "" }], returns: "{ ok:true }" },
      { method: "WS", path: "profile.remove_optout", auth: "認証済み", summary: "オプトアウト解除（削除データは復元しない）", body: [{ n: "serviceId", t: "string", r: true, d: "" }, { n: "categoryKey", t: "string", r: true, d: "" }], returns: "{ ok:true }" },
    ],
  },
  {
    group: "WS module — managed_project (user WS)",
    desc: "動的登録サービスの管理・自分の委託データ閲覧・SSO 起動。",
    endpoints: [
      { method: "WS", path: "managed_project.list", auth: "認証済み", summary: "登録サービス一覧（接続状態付き）", returns: "[{ key, name, connectionCount, lastConnectedAt, frontendUrl, ... }]" },
      { method: "WS", path: "managed_project.get", auth: "認証済み", summary: "サービス詳細", body: [{ n: "key", t: "string", r: true, d: "" }], returns: "{ schemaDefinition, columnsByModule, isActive, ... }" },
      { method: "WS", path: "managed_project.templates", auth: "認証済み", summary: "サービステンプレート一覧", returns: "[{ key, name, description }]" },
      { method: "WS", path: "managed_project.get_template", auth: "認証済み", summary: "テンプレート schema.json", body: [{ n: "key", t: "string", r: true, d: "" }], returns: "schema.json" },
      { method: "WS", path: "managed_project.register", auth: "system admin", summary: "サービス登録 / 再有効化", body: [{ n: "project", t: "{ key, name, description }", r: true, d: "" }, { n: "user_data", t: "{ columns }", r: true, d: "" }, { n: "endpoint", t: "object", r: false, d: "" }, { n: "data_sharing", t: "object", r: false, d: "" }], returns: "{ clientId, clientSecret, tableCreated, columnsAdded }" },
      { method: "WS", path: "managed_project.delete", auth: "system admin", summary: "サービス無効化（論理削除）", body: [{ n: "key", t: "string", r: true, d: "" }], returns: "{ ok:true }" },
      { method: "WS", path: "managed_project.update_schema", auth: "system admin", summary: "スキーマ更新（マイグレーション）", body: [{ n: "key", t: "string", r: true, d: "" }, { n: "...ProjectDefinition", t: "object", r: true, d: "_deleted で列退避" }], returns: "{ ok, ... }" },
      { method: "WS", path: "managed_project.definition_history", auth: "認証済み", summary: "スキーマ版履歴", body: [{ n: "key", t: "string", r: true, d: "" }], returns: "[{ version, definition, appliedBy, createdAt }]" },
      { method: "WS", path: "managed_project.my_data", auth: "認証済み", summary: "自分の委託データ", body: [{ n: "projectKey", t: "string", r: true, d: "" }], returns: "{ schema, data, projectKey, projectName }" },
      { method: "WS", path: "managed_project.my_data_all", auth: "認証済み", summary: "全プロジェクトの自分のデータ", returns: "[{ projectKey, data }]" },
      { method: "WS", path: "managed_project.overview", auth: "認証済み", summary: "プロジェクト別の利用概況", returns: "[{ totalColumns, filledColumns, inUse, connectionCount, frontendUrl }]" },
      { method: "WS", path: "managed_project.open_url", auth: "認証済み", summary: "SSO 用 authCode を発行し URL を返す", body: [{ n: "projectKey", t: "string", r: true, d: "" }], returns: "{ url(?code=) }" },
      { method: "WS", path: "managed_project.connections", auth: "認証済み", summary: "WS 接続詳細", body: [{ n: "projectKey", t: "string", r: true, d: "" }], returns: "{ connectionCount, connections[], lastConnectedAt, lastDisconnectedAt }" },
      { method: "WS", path: "managed_project.list_optouts / optout / remove_optout", auth: "認証済み", summary: "プロジェクトモジュール単位のオプトアウト", body: [{ n: "projectKey", t: "string", r: true, d: "" }, { n: "moduleKey", t: "string", r: false, d: "optout 時" }], returns: "{ ok:true } / 一覧" },
    ],
  },
  {
    group: "WS module — oidc_client / oidc_keys",
    desc: "Cernere を IdP とする RP クライアント管理と署名鍵状態（システム管理者）。",
    endpoints: [
      { method: "WS", path: "oidc_client.list", auth: "system admin", summary: "RP クライアント一覧", returns: "[{ key, name, isActive, redirectUris, createdAt }]" },
      { method: "WS", path: "oidc_client.register", auth: "system admin", summary: "RP 登録（clientSecret は一度だけ平文返却）", body: [{ n: "name", t: "string", r: true, d: "" }, { n: "redirectUris", t: "string[]", r: true, d: "" }], returns: "{ clientId, clientSecret }" },
      { method: "WS", path: "oidc_client.rotate_secret", auth: "system admin", summary: "シークレットローテーション", body: [{ n: "clientId", t: "string", r: true, d: "" }], returns: "{ clientSecret }" },
      { method: "WS", path: "oidc_client.update_redirect_uris", auth: "system admin", summary: "リダイレクト URI 更新", body: [{ n: "clientId", t: "string", r: true, d: "" }, { n: "redirectUris", t: "string[]", r: true, d: "" }], returns: "{ ok:true }" },
      { method: "WS", path: "oidc_client.enable / disable", auth: "system admin", summary: "クライアント有効 / 無効", body: [{ n: "clientId", t: "string", r: true, d: "" }], returns: "{ ok:true }" },
      { method: "WS", path: "oidc_keys.status", auth: "system admin", summary: "署名鍵の状態（current kid / deprecated）", returns: "{ current, deprecated[] }" },
    ],
  },

  /* ============================ WS: project modules ============================ */
  {
    group: "WS module (project WS) — managed_project",
    desc: "/ws/project 上でサービスがユーザーデータ・OAuth トークンを読み書き。projectKey はセッション束縛。",
    endpoints: [
      { method: "WS", path: "managed_project.get_user_data", auth: "project client", summary: "ユーザー列の取得", body: [{ n: "userId", t: "string", r: true, d: "" }, { n: "columns", t: "string[]", r: false, d: "空 = 全有効列" }], returns: "{ [column]: value|null }" },
      { method: "WS", path: "managed_project.set_user_data", auth: "project client", summary: "ユーザーデータの upsert（オプトアウト列はブロック）", body: [{ n: "userId", t: "string", r: true, d: "" }, { n: "data", t: "{ [column]: value }", r: true, d: "" }], returns: "{ ok:true, updated[] }" },
      { method: "WS", path: "managed_project.delete_user_data", auth: "project client", summary: "ユーザー列を NULL 化", body: [{ n: "userId", t: "string", r: true, d: "" }, { n: "columns", t: "string[]", r: false, d: "" }], returns: "{ ok:true, deleted[] }" },
      { method: "WS", path: "managed_project.update_schema", auth: "project client", summary: "起動時スキーマ更新（SDK loader）", body: [{ n: "...ProjectDefinition", t: "object", r: true, d: "project.key 一致必須" }], returns: "{ ok, ... }" },
      { method: "WS", path: "managed_project.store_oauth_token", auth: "project client", summary: "OAuth トークン保管（UPSERT）", body: [{ n: "userId", t: "string", r: true, d: "" }, { n: "provider", t: "string", r: true, d: "" }, { n: "accessToken", t: "string|null", r: false, d: "" }, { n: "refreshToken", t: "string|null", r: false, d: "" }, { n: "expiresAt", t: "string|null", r: false, d: "" }, { n: "scope", t: "string|null", r: false, d: "" }, { n: "metadata", t: "object", r: false, d: "" }], returns: "{ ok:true, provider }" },
      { method: "WS", path: "managed_project.get_oauth_token / list_oauth_tokens / delete_oauth_token", auth: "project client", summary: "OAuth トークン取得 / 一覧 / 削除", body: [{ n: "userId", t: "string", r: true, d: "" }, { n: "provider", t: "string", r: false, d: "get/delete 時" }], returns: "OAuthTokenRecord | OAuthTokenRecord[] | { ok:true, deleted:true }" },
      { method: "WS", path: "managed_project.verify_token", auth: "project client", summary: "プロジェクト JWT のリモート検証", body: [{ n: "token", t: "string", r: true, d: "" }], returns: "{ valid:true, projectKey, clientId, exp } | { valid:false }" },
    ],
  },
  {
    group: "WS module (project WS) — profile / auth / managed_relay",
    desc: "サービス側のプロフィール read/write、埋め込みログイン、peer リレー調整。",
    endpoints: [
      { method: "WS", path: "profile.get", auth: "project client", summary: "ユーザープロフィール取得", body: [{ n: "userId", t: "string", r: true, d: "" }], returns: "{ id, login, displayName, email, bio, roleTitle, expertise[], hobbies[], privacy }" },
      { method: "WS", path: "profile.update", auth: "project client", summary: "プロフィール更新（オプトアウト尊重）", body: [{ n: "userId", t: "string", r: true, d: "" }, { n: "displayName", t: "string", r: false, d: "" }, { n: "bio", t: "string", r: false, d: "" }, { n: "roleTitle", t: "string", r: false, d: "" }, { n: "expertise", t: "string[]", r: false, d: "" }, { n: "hobbies", t: "string[]", r: false, d: "" }], returns: "{ ok:true }" },
      { method: "WS", path: "auth.login / register / mfa-verify", auth: "guest (project WS)", summary: "埋め込み SPA ログイン（CORS フリー）", body: [{ n: "email", t: "string", r: false, d: "" }, { n: "password", t: "string", r: false, d: "" }, { n: "name", t: "string", r: false, d: "register 時" }, { n: "mfaToken", t: "string", r: false, d: "mfa-verify 時" }, { n: "code", t: "string", r: false, d: "mfa-verify 時" }], returns: "{ accessToken, refreshToken, user } | { mfaRequired, mfaMethods }" },
      { method: "WS", path: "managed_relay.register_endpoint", auth: "project client", summary: "SA WS URL を登録", body: [{ n: "saWsUrl", t: "string", r: true, d: "" }], returns: "{ ok:true }" },
      { method: "WS", path: "managed_relay.unregister_endpoint", auth: "project client", summary: "SA エンドポイント解除", returns: "{ ok:true }" },
      { method: "WS", path: "managed_relay.request_peer", auth: "project client", summary: "peer 接続要求（relay_pairs 確認）", body: [{ n: "target", t: "string", r: true, d: "対象キー" }], returns: "{ saWsUrl, challenge, expiresAt }（TTL 60s）" },
      { method: "WS", path: "managed_relay.verify_challenge", auth: "project client", summary: "ハンドシェイク中の challenge 検証（単回）", body: [{ n: "challenge", t: "string", r: true, d: "" }, { n: "claimedIssuer", t: "string", r: true, d: "" }], returns: "{ valid:true }" },
    ],
  },

  /* ============================ WS: composite auth ============================ */
  {
    group: "WebSocket — Composite Auth フロー (/auth/composite-ws)",
    desc: "pending_device → challenge_pending → authenticated の状態機械。",
    endpoints: [
      { method: "WS", path: "→ device", auth: "ticket", summary: "デバイスフィンガープリント送信", body: [{ n: "payload", t: "{ machine, browser, geo }", r: false, d: "" }], returns: "state: authenticated{authCode} | challenge_pending{anomalies}" },
      { method: "WS", path: "→ verify_code", auth: "ticket", summary: "チャレンジコード検証", body: [{ n: "code", t: "string", r: true, d: "メール 6 桁コード" }], returns: "authenticated{authCode} | challenge_pending{remainingAttempts} | error{retryable}" },
      { method: "WS", path: "→ resend", auth: "ticket", summary: "コード再送（challenge_pending 時のみ）", returns: "state" },
    ],
  },
];
