/**
 * managed project secret 再発行 CLI。
 *
 * seed migration が作った project や secret を紛失した project に対して、
 * client_secret を再発行する。平文は標準出力に一度だけ表示し、DB には
 * bcrypt hash だけを保存する。
 *
 * 使い方（server/ で実行。DATABASE_URL が対象DBを指すこと）:
 *   npx tsx scripts/rotate-project-secret.ts --project glab
 */

import { rotateProjectSecret } from "../src/project/service.js";

function projectFromArgs(argv: string[]): string {
  const index = argv.indexOf("--project");
  return index >= 0 ? (argv[index + 1] ?? "").trim() : "";
}

async function main(): Promise<void> {
  const project = projectFromArgs(process.argv.slice(2));
  if (!project) {
    console.error("usage: tsx scripts/rotate-project-secret.ts --project <key>");
    process.exit(1);
  }

  const result = await rotateProjectSecret(project);
  const envPrefix = project.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  console.log(`\n${result.message}:\n`);
  console.log(`  key            : ${result.key}`);
  console.log(`  client_id      : ${result.clientId}`);
  console.log(`  client_secret  : ${result.clientSecret}   <-- shown ONCE, store it now`);
  console.log("\nSuggested Cernere Infisical keys for an Excubitor launcher:");
  console.log(`  ${envPrefix}_CERNERE_CLIENT_ID`);
  console.log(`  ${envPrefix}_CERNERE_CLIENT_SECRET`);
  console.log("\nThe previous secret is invalid immediately. Store the new value in the consuming service's secret manager.\n");
  process.exit(0);
}

main().catch((error) => {
  console.error("rotation failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
