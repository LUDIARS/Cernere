/**
 * 一般待受 (LISTEN_PORT) と workload 待受が bind するアドレス。
 * 未設定なら全インターフェース (従来どおり)。 本社のテスト用 Cernere は 127.0.0.1 を指定して
 * ループバックからの接続だけを受ける (spec/setup/hq-test-instance.md)。
 * 外部公開する本番はカンマ区切りで複数指定できる (例: `127.0.0.1,<拠点の tailnet IP>` で
 * 同居サービスと tailnet だけに開く。spec/setup/public-exposure.md)。
 */
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:]+$/;

function validListenHost(raw: string): string {
  if (raw === "localhost" || IPV4.test(raw) || (raw.includes(":") && IPV6.test(raw))) return raw;
  throw new Error("LISTEN_HOST must be IPv4/IPv6 addresses or localhost, separated by commas");
}

/** 未設定・空なら null (全インターフェース)。 1 つでも不正なら起動を止める。 */
export function readListenHosts(env: NodeJS.ProcessEnv): string[] | null {
  const raw = env.LISTEN_HOST?.trim();
  if (!raw) return null;
  const hosts = raw.split(",").map((s) => s.trim());
  if (hosts.some((h) => !h)) throw new Error("LISTEN_HOST must not contain empty entries");
  return [...new Set(hosts.map(validListenHost))];
}

/** ログ表示用の到達先。 全インターフェース待受では従来どおり localhost を示す。 */
export function displayHost(host: string | null): string {
  if (!host) return "localhost";
  return host.includes(":") ? `[${host}]` : host;
}
