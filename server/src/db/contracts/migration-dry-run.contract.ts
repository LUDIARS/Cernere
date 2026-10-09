import type { MigrationDryRunResult } from '../migration-dry-run.js';

export default {
  post: (result: MigrationDryRunResult): true | string =>
    (result.committed === false
      && (result.outcome === 'blocked' ? result.blocked.length > 0 && result.checked.length === 0 : result.rolledBack)
      && (result.outcome === 'failed') === (result.failure !== undefined))
    || 'migration dry-run must never commit and must roll back every opened transaction',
};
