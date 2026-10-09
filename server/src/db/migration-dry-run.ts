/**
 * migration dry-run — 配備前に未適用 migration を検査する。
 *
 * 未適用分を 1 トランザクション内で起動時と同じ規則 (ステートメント分割・冪等
 * スキップ) で実行し、 結果に関わらず必ず ROLLBACK する。 COMMIT は発行しない。
 * トランザクション内で実行できない文 (CONCURRENTLY 等) を含む場合は、
 * 何も実行せずに停止する。
 */

import { contract } from '@ludiars/log-weaver';
import dryRunContract from './contracts/migration-dry-run.contract.js';
import { isIgnorableMigrationError } from './migration-files.js';

/** 1 本の専用接続上で SQL 文字列を実行する口。 */
export interface DryRunConnection {
  unsafe(statement: string): Promise<unknown>;
}

export interface PendingMigration {
  version: string;
  statements: string[];
}

export interface BlockedStatement {
  version: string;
  statement: string;
  reason: string;
}

export interface MigrationDryRunResult {
  outcome: 'ok' | 'failed' | 'blocked';
  /** 全文の実行 (またはスキップ) まで到達した migration。 */
  checked: string[];
  skipped: Array<{ version: string; code: string; statement: string }>;
  blocked: BlockedStatement[];
  failure?: { version: string; code?: string; message: string; statement: string };
  rolledBack: boolean;
  committed: false;
}

const NON_TRANSACTIONAL: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(BEGIN|COMMIT|ROLLBACK|END|START\s+TRANSACTION|SAVEPOINT|RELEASE)\b/i, 'transaction control'],
  [/^(CREATE\s+(UNIQUE\s+)?INDEX|DROP\s+INDEX)\s+CONCURRENTLY\b/i, 'CONCURRENTLY'],
  [/^REINDEX\b[\s\S]*\bCONCURRENTLY\b/i, 'CONCURRENTLY'],
  [/^(CREATE|DROP|ALTER)\s+DATABASE\b/i, 'database-level DDL'],
  [/^(CREATE|DROP)\s+TABLESPACE\b/i, 'tablespace DDL'],
  [/^(VACUUM|ALTER\s+SYSTEM|CREATE\s+SUBSCRIPTION|DROP\s+SUBSCRIPTION)\b/i, 'non-transactional command'],
  [/^ALTER\s+TYPE\b[\s\S]*\bADD\s+VALUE\b/i, 'enum value is unusable before commit'],
];

/** トランザクション内で実行できない (または巻き戻し検査が成立しない) 文を列挙する。 */
export function findNonTransactional(pending: readonly PendingMigration[]): BlockedStatement[] {
  const blocked: BlockedStatement[] = [];
  for (const { version, statements } of pending) {
    for (const statement of statements) {
      const hit = NON_TRANSACTIONAL.find(([pattern]) => pattern.test(statement.trim()));
      if (hit) blocked.push({ version, statement: statement.slice(0, 120), reason: hit[1] });
    }
  }
  return blocked;
}

const SAVEPOINT = 'cernere_migration_dry_run';

export async function dryRunMigrations(
  db: DryRunConnection,
  pending: readonly PendingMigration[],
  lockTimeoutMs = 5000,
): Promise<MigrationDryRunResult> {
  const result: MigrationDryRunResult = {
    outcome: 'ok', checked: [], skipped: [], blocked: findNonTransactional(pending),
    rolledBack: false, committed: false,
  };
  if (result.blocked.length > 0) {
    result.outcome = 'blocked';
    return concludeMigrationDryRun(result);
  }

  await db.unsafe('BEGIN');
  try {
    // 稼働中 DB への確認でも長時間ロックを握らない。
    await db.unsafe(`SET LOCAL lock_timeout = '${Math.max(1, Math.trunc(lockTimeoutMs))}ms'`);
    for (const { version, statements } of pending) {
      for (const statement of statements) {
        await db.unsafe(`SAVEPOINT ${SAVEPOINT}`);
        try {
          await db.unsafe(statement);
          await db.unsafe(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        } catch (err) {
          const code = (err as { code?: string }).code;
          await db.unsafe(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
          if (isIgnorableMigrationError(code)) {
            result.skipped.push({ version, code: code!, statement: statement.slice(0, 120) });
            continue;
          }
          result.outcome = 'failed';
          result.failure = { version, code, message: (err as Error).message, statement: statement.slice(0, 120) };
          break;
        }
      }
      if (result.failure) break;
      result.checked.push(version);
    }
  } finally {
    await db.unsafe('ROLLBACK');
    result.rolledBack = true;
  }
  return concludeMigrationDryRun(result);
}

/** dry-run 結果の確定点 (契約 C-18 の観測点)。 */
function finalizeDryRun(result: MigrationDryRunResult): MigrationDryRunResult {
  return result;
}

export const concludeMigrationDryRun = contract(finalizeDryRun, {
  ...dryRunContract, contractId: 'C-18', mode: 'observe', sample: 1,
  where: 'server/src/db/migration-dry-run.ts', rule: 'contract-wrap', id: 'migration-dry-run',
});
