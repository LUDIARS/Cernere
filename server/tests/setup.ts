import { beforeAll } from "vitest";
import { initOidcKeys } from "../src/auth/oidc-keys.js";
import type { OidcKeyRepository } from "../src/auth/oidc-key-repository.js";

beforeAll(async () => {
  const repository: OidcKeyRepository = {
    async findCurrent() { return null; },
    async findRetiredSince() { return []; },
    async insertCurrent() {},
  };
  await initOidcKeys(repository);
});
