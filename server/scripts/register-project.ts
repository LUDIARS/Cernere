/** tsx scripts/register-project.ts --file definition.json --service code [--vault-project id] [--env-prefix PREFIX] */
import { credentialCli } from "./project-credential-cli.js";
await credentialCli("register");
