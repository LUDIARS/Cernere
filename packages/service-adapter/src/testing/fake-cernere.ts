/**
 * テスト用のミニチュア Cernere. peer-adapter テスト専用 —
 * /api/auth/login と /ws/project のうち adapter が叩く部分だけを再現する.
 *
 * 提供:
 *   - project credentials での login → RS256 project JWT 発行
 *   - /ws/project?token=... → managed_project / managed_relay の必要コマンドを
 *     dispatch
 *   - relay_pair は constructor で与えられた配列をインメモリで保持
 */

import { createServer, type Server } from "node:http";
import {
  createSign,
  createVerify,
  createPublicKey,
  generateKeyPairSync,
  createHash,
  randomUUID,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

interface ManagedProject {
  projectKey: string;
  clientId:   string;
  clientSecret: string;
}

export interface FakeCernereOptions {
  projects: ManagedProject[];
  /** [fromProjectKey, toProjectKey] のペアのリスト (bidirectional 前提) */
  relayPairs: Array<[string, string]>;
}

export class FakeCernere {
  private http: Server;
  private ws:   WebSocketServer;
  private privateKey!: KeyObject;
  private publicKeyJwk!: Record<string, string>;
  private kid!: string;
  public port = 0;

  /** projectKey → 登録された SA WS URL. */
  private endpoints = new Map<string, string>();
  /** challenge → {issuer, target, expiresAt} */
  private challenges = new Map<string, { issuer: string; target: string; expiresAt: number }>();

  constructor(private readonly opts: FakeCernereOptions) {
    this.generateKeys();
    this.http = createServer(this.handleHttp.bind(this));
    this.ws   = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (!url.pathname.startsWith("/ws/project")) {
        socket.destroy(); return;
      }
      const token = url.searchParams.get("token") ?? "";
      const projectKey = this.verifyToken(token);
      if (!projectKey) { socket.destroy(); return; }
      this.ws.handleUpgrade(req, socket, head, (wsock) => this.onWs(wsock, projectKey));
    });
  }

  async start(): Promise<{ baseUrl: string }> {
    await new Promise<void>((r) => this.http.listen(0, "127.0.0.1", () => r()));
    const addr = this.http.address();
    if (typeof addr !== "object" || !addr) throw new Error("listen failed");
    this.port = addr.port;
    return { baseUrl: `http://127.0.0.1:${addr.port}` };
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.ws.close(() => r()));
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  // ─── HTTP ─────────────────────────────────────────

  private handleHttp(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    if (req.method === "POST" && req.url === "/api/auth/login") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const { client_id, client_secret, grant_type } = JSON.parse(body || "{}");
          if (grant_type !== "project_credentials") {
            res.writeHead(400).end("bad grant_type"); return;
          }
          const proj = this.opts.projects.find(p => p.clientId === client_id && p.clientSecret === client_secret);
          if (!proj) { res.writeHead(401).end("invalid credentials"); return; }
          const token = this.issueProjectToken(proj.projectKey, proj.clientId);
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
            access_token:  token,
            project_token: token,
            token_type:    "Bearer",
            expires_in:    3600,
          }));
        } catch { res.writeHead(400).end("bad body"); }
      });
      return;
    }
    res.writeHead(404).end();
  }

  // ─── WS ───────────────────────────────────────────

  private onWs(ws: WebSocket, projectKey: string): void {
    ws.send(JSON.stringify({ type: "connected", session_id: randomUUID() }));
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== "module_request") return;
      const cmd = `${msg.module}.${msg.action}`;
      const reqId = (msg.request_id ?? msg.id) as string | undefined;
      const payload = (msg.payload ?? {}) as Record<string, unknown>;
      const respond = (result: unknown) => {
        ws.send(JSON.stringify({ type: "module_response", request_id: reqId, module: msg.module, action: msg.action, payload: result }));
      };
      const fail = (code: string, message: string) => {
        ws.send(JSON.stringify({ type: "error", request_id: reqId, code, message }));
      };
      try {
        if (cmd === "managed_project.get_jwks") {
          respond({ keys: [{
            ...this.publicKeyJwk, kty: "RSA", use: "sig", alg: "RS256", kid: this.kid,
          }] });
        } else if (cmd === "managed_relay.register_endpoint") {
          this.endpoints.set(projectKey, String(payload.saWsUrl));
          respond({ ok: true });
        } else if (cmd === "managed_relay.unregister_endpoint") {
          this.endpoints.delete(projectKey);
          respond({ ok: true });
        } else if (cmd === "managed_relay.request_peer") {
          const target = String(payload.target);
          if (!this.isPairAllowed(projectKey, target)) return fail("pair_not_allowed", `${projectKey} → ${target}`);
          const url = this.endpoints.get(target);
          if (!url) return fail("target_offline", target);
          const ch = randomBytes(24).toString("base64url");
          const expiresAt = Date.now() + 60_000;
          this.challenges.set(ch, { issuer: projectKey, target, expiresAt });
          respond({ saWsUrl: url, challenge: ch, expiresAt });
        } else if (cmd === "managed_relay.verify_challenge") {
          const ch = String(payload.challenge);
          const issuer = String(payload.claimedIssuer);
          const rec = this.challenges.get(ch);
          this.challenges.delete(ch);
          if (!rec) return fail("challenge_unknown", "");
          if (rec.expiresAt < Date.now()) return fail("challenge_expired", "");
          if (rec.issuer !== issuer || rec.target !== projectKey) {
            return fail("challenge_mismatch", "");
          }
          respond({ valid: true });
        } else {
          fail("unknown_command", cmd);
        }
      } catch (err) {
        fail("internal", (err as Error).message);
      }
    });
  }

  // ─── crypto helpers ───────────────────────────────

  private generateKeys(): void {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.publicKeyJwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
    const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    this.kid = createHash("sha256").update(der).digest("hex").slice(0, 32);
  }

  private issueProjectToken(projectKey: string, clientId: string): string {
    const header = { alg: "RS256", typ: "JWT", kid: this.kid };
    const now = Math.floor(Date.now() / 1000);
    const payload = { sub: clientId, projectKey, tokenType: "project", iat: now, exp: now + 3600 };
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const signingInput = `${enc(header)}.${enc(payload)}`;
    const sig = createSign("RSA-SHA256").update(signingInput).end().sign(this.privateKey).toString("base64url");
    return `${signingInput}.${sig}`;
  }

  private verifyToken(token: string): string | null {
    // Minimal local verify — for WS gating.
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return null;
    const pubkey = createPublicKey(this.privateKey);
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).end().verify(pubkey, Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    if (!ok) return null;
    const payload = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (payload.tokenType !== "project") return null;
    return payload.projectKey;
  }

  private isPairAllowed(a: string, b: string): boolean {
    for (const [x, y] of this.opts.relayPairs) {
      if ((x === a && y === b) || (x === b && y === a)) return true;
    }
    return false;
  }
}
