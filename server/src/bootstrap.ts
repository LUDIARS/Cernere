/**
 * bootstrap entry — `.env` ファイル無し運用の起動口。
 *
 * 1. env-bootstrap で必要な env が揃ってることを検査 (必要なら Infisical から fetch)
 * 2. dynamic import で `./index.js` を読み込み (top-level import で config.ts が
 *    走るのを避ける、 順序的に必須)
 *
 * package.json / docker-compose の dev/start script はこのファイルを指す。
 */

import { ensureEnv } from './lib/env-bootstrap.js';

async function bootstrap(): Promise<void> {
  try {
    await ensureEnv();
  } catch (err) {
    console.error(`[bootstrap] failed: ${(err as Error).message}`);
    process.exit(1);
  }
  await import('./index.js');
}

void bootstrap();
