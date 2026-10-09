import type { WorkloadListenerConfig } from '../workload-listener-config.js';

export default {
  post: (result: WorkloadListenerConfig | null, _env: unknown, listenPort: number): true | string =>
    result === null
    || (!!result.tls.cert_file_name && !!result.tls.key_file_name
      && Number.isInteger(result.port) && result.port >= 1 && result.port <= 65535
      && result.port !== listenPort)
    || 'workload TLS listener must have cert, key and a port distinct from the general listener',
};
