/**
 * OIDC クライアント (RP) 登録 CLI
 *
 * Cloudflare Access 等の RP を Cernere に登録し、 client_id / client_secret を
 * 表示する。 client_secret はここでしか取得できない (DB には bcrypt ハッシュのみ)。
 *
 * 使い方 (server/ で実行):
 *   tsx scripts/register-oidc-client.ts --name "Cloudflare Access" \
 *     --redirect https://<team>.cloudflareaccess.com/cdn-cgi/access/callback
 *
 *   複数 redirect は --redirect を繰り返す。 --scopes "openid email profile" で上書き可。
 *
 * 環境変数 DATABASE_URL が server と同じ DB を指している必要がある。
 */

import { registerClient } from "../src/oidc/clients.js";

function parseArgs(argv: string[]): { name: string; redirectUris: string[]; scopes?: string[] } {
  let name = "";
  const redirectUris: string[] = [];
  let scopes: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") name = argv[++i] ?? "";
    else if (a === "--redirect") redirectUris.push(argv[++i] ?? "");
    else if (a === "--scopes") scopes = (argv[++i] ?? "").split(/\s+/).filter(Boolean);
  }
  return { name, redirectUris: redirectUris.filter(Boolean), scopes };
}

async function main(): Promise<void> {
  const { name, redirectUris, scopes } = parseArgs(process.argv.slice(2));
  if (!name || redirectUris.length === 0) {
    console.error("usage: tsx scripts/register-oidc-client.ts --name <name> --redirect <uri> [--redirect <uri> ...] [--scopes \"openid email profile\"]");
    process.exit(1);
  }

  const { client, clientSecret } = await registerClient({ name, redirectUris, scopes }, null);

  console.log("\nOIDC client registered:\n");
  console.log(`  name           : ${client.name}`);
  console.log(`  client_id      : ${client.clientId}`);
  console.log(`  client_secret  : ${clientSecret}   <-- shown ONCE, store it now`);
  console.log(`  redirect_uris  : ${client.redirectUris.join(", ")}`);
  console.log(`  scopes         : ${client.scopes.join(" ")}`);
  console.log("\nDiscovery URL: <CERNERE_PUBLIC_URL>/.well-known/openid-configuration\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("registration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
