import type uWS from 'uWebSockets.js';
import { contract } from '@ludiars/log-weaver';
import listenerConfigContract from './contracts/workload-listener-config.contract.js';

export interface WorkloadListenerConfig {
  tls: uWS.AppOptions;
  port: number;
}

const KEYS = ['CERNERE_TLS_CERT_FILE', 'CERNERE_TLS_KEY_FILE', 'CERNERE_WORKLOAD_TLS_PORT'] as const;

/**
 * workload 専用 TLS 待受の構成。 一般認証の待受 (LISTEN_PORT) は常に平文のまま。
 * 証明書・鍵・ポートの 3 つが揃ったときだけ有効、 全て未設定なら無効、
 * それ以外 (片側設定・不正ポート・一般待受と同一ポート) は起動構成エラー。
 */
function readWorkloadListenerConfig(env: NodeJS.ProcessEnv, listenPort: number): WorkloadListenerConfig | null {
  const [cert, key, rawPort] = KEYS.map((name) => env[name]?.trim() || undefined);
  if (!cert && !key && !rawPort) return null;
  if (!cert || !key || !rawPort) {
    const missing = KEYS.filter((name) => !env[name]?.trim());
    throw new Error(`Workload TLS listener requires ${KEYS.join(', ')} together (missing: ${missing.join(', ')})`);
  }
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CERNERE_WORKLOAD_TLS_PORT must be an integer port between 1 and 65535');
  }
  if (port === listenPort) {
    throw new Error('CERNERE_WORKLOAD_TLS_PORT must differ from LISTEN_PORT (the general listener stays plain HTTP)');
  }
  return { tls: { cert_file_name: cert, key_file_name: key }, port };
}

export const workloadListenerConfig = contract(readWorkloadListenerConfig, {
  ...listenerConfigContract, contractId: 'C-17', mode: 'observe', sample: 1,
  where: 'server/src/http/workload-listener-config.ts', rule: 'contract-wrap', id: 'workload-listener-config',
});
