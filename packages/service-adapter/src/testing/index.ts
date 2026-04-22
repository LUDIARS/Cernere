/**
 * Testing helpers — 他 LUDIARS サービスが PeerAdapter を取り込むときに、
 * 本物の Cernere を立てずに integration test を書けるよう公開する。
 *
 * Usage:
 *
 * ```typescript
 * import { FakeCernere } from "@ludiars/cernere-service-adapter/testing";
 * ```
 */

export { FakeCernere } from "./fake-cernere.js";
export type { FakeCernereOptions } from "./fake-cernere.js";
