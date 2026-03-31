/**
 * @ludiars/env-cli — Programmatic API
 *
 * CLI 以外からも利用可能な公開 API。
 */

export type {
  EnvCliConfig,
  InfisicalBootstrap,
  RawSecret,
} from "./types.js";

export {
  authenticate,
  fetchSecrets,
  getSecretByKey,
  upsertSecret,
} from "./infisical.js";

export {
  parseEnvFile,
  loadBootstrap,
  saveBootstrap,
} from "./env-file.js";

export {
  buildDotenv,
  type EnvGeneratorResult,
} from "./env-generator.js";

export {
  createPrompt,
  type Prompt,
} from "./prompt.js";
