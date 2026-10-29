// 本社 Vault の cernere の紐付けから CERNERE_IDENTITY_VERIFICATION_DISABLED を外す
// (spec/setup/public-exposure.md)。値と他の紐付けは変えない。本社の端末で実行する。
//   node scripts/site/public-hardening/hq-vault-unbind.mjs
// 残っていると CERNERE_ENV=production の Cernere は起動時に止まる (config.ts)。
const EX = process.env.EXCUBITOR_URL ?? "http://127.0.0.1:17332";
const NAME = "CERNERE_IDENTITY_VERIFICATION_DISABLED";

const status = await (await fetch(`${EX}/api/v1/vault`)).json();
const bindings = status.bindings;
const current = (Array.isArray(bindings) ? bindings.find((b) => b.code === "cernere") : bindings?.cernere) ?? [];
const names = (Array.isArray(current) ? current : []).map((n) => (typeof n === "string" ? n : n.name));
if (names.length === 0) {
  console.log("STOP: cernere の紐付けが読めない");
  process.exit(1);
}
if (!names.includes(NAME)) {
  console.log(`${NAME} は紐付いていない (変更なし)`);
  process.exit(0);
}
const next = names.filter((n) => n !== NAME);
const res = await fetch(`${EX}/api/v1/vault/bindings/cernere`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ names: next }),
});
console.log(res.ok ? `外した (${names.length} → ${next.length} 件)` : `STOP: HTTP ${res.status} ${await res.text()}`);
process.exit(res.ok ? 0 : 1);
