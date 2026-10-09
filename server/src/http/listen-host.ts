/**
 * 一般待受 (LISTEN_PORT) と workload 待受が bind するアドレス。
 * 未設定なら全インターフェース (従来どおり)。 本社のテスト用 Cernere は 127.0.0.1 を指定して
 * ループバックからの接続だけを受ける (spec/setup/hq-test-instance.md)。
 */
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:]+$/;

export function readListenHost(env: NodeJS.ProcessEnv): string | null {
  const raw = env.LISTEN_HOST?.trim();
  if (!raw) return null;
  if (raw === "localhost" || IPV4.test(raw) || (raw.includes(":") && IPV6.test(raw))) return raw;
  throw new Error("LISTEN_HOST must be an IPv4/IPv6 address or localhost");
}

/** ログ表示用の到達先。 全インターフェース待受では従来どおり localhost を示す。 */
export function displayHost(host: string | null): string {
  if (!host) return "localhost";
  return host.includes(":") ? `[${host}]` : host;
}
