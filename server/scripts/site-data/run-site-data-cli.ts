import { killActiveTools } from "./process-runner.js";
import { siteDataFailureMessage } from "./site-data-error.js";

/** Shared entry wrapper: exit 0 only on success, classified message only, no child left behind. */
export function runSiteDataCli(label: string, main: () => Promise<string>): void {
  const interrupt = () => {
    killActiveTools();
    console.error(`[${label}] interrupted`);
    process.exit(1);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  main().then(
    (summary) => {
      console.log(`[${label}] ${summary}`);
      process.exit(0);
    },
    (error: unknown) => {
      killActiveTools();
      console.error(`[${label}] ${siteDataFailureMessage(error)}`);
      process.exit(1);
    },
  );
}
