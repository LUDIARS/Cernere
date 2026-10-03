/** tsx scripts/rotate-project-secret.ts --project key --service code [--vault-project id] [--env-prefix PREFIX] */
import { credentialCli } from "./project-credential-cli.js";
await credentialCli("rotate");
