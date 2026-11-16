# Workload admin UI validation — 2026-10-29

## Implementation

Authenticated system administrators can register workload public keys, grant one-way monitor permission, and revoke principals/keys/grants through the existing guarded WebSocket module. No server authorization, schema, cryptography, or transport fallback changed. `/admin/workloads` is inside the existing authenticated layout and is linked only for administrators.

Commands are serialized; pending requests and unacknowledged receipts block further mutations. A timeout or rejection is treated as potentially committed and does not retry. Delayed success can still deliver the one-time receipt. Credentials live only in component state; navigation, account changes, and explicit dismissal discard them. Registration/grant IDs must be retained by the operator; the existing authority has no list action.

## Validation

- `git diff --check`: passed.
- Targeted TypeScript 5.9.3 check of `WorkloadAuthorityPage.tsx` and its dependency graph: passed using the already installed main checkout frontend typings and Vite client declarations, with a temporary config removed after verification. No dependencies were installed or linked into the worktree.
- Full frontend typecheck using existing main dependencies: blocked by missing `jsqr` and unavailable worktree module/type resolution. This is not a full build success.
- Added `server/tests/frontend/workload-admin.test.ts`: admin/disconnection guards, narrow monitor grant, cancellation, duplicate submission, timeout/no retry, raw error suppression, private-key rejection, receipt dismissal/account-change cleanup. Tests were not executed by this session; Revisor validation remains required.
- No live registration, secrets, grant changes, deployment, migration, restart, or network connectivity tests were performed for this UI change.

## Dependencies

No manifest/lockfile changes and no new direct or transitive dependencies. Forms, timeout and lifecycle handling use React and browser APIs; the existing WS client handles authenticated transport. TanStack Query is intentionally not used for mutation receipts so one-time credentials do not enter shared query caches. Crypto/authentication remain in the existing server implementation rather than being reimplemented.

The existing lockfile declares install hooks for esbuild 0.28.2 and optional fsevents 2.3.3 (MIT). An attempted offline `npm ci --ignore-scripts --no-audit --no-fund` was blocked before execution because a complete external-import review was unavailable. Those flags would disable install hooks and registry audit/funding traffic, but are not a substitute for the required seven-day history/artifact review. No dependency installation approval or full upstream/transitive security review is claimed. Existing React/router packages are reused; no duplicate package was introduced. Unrelated dependency removals were not made.

## Rollout

PR3527 initial leakage gate identified the static private-key framing in the rejection fixture, not deployed credentials. The fixture now uses Node's standard Ed25519 generator at test runtime and exports ephemeral PKCS8 solely as the rejected input. The no-transmission assertion is unchanged; no scanner exclusion was added. Function-level spec links were added for the enrollment/receipt/command boundaries. This follow-up has not executed tests locally; re-review is required.

After review/merge, build and deploy the frontend through the production owner. Verify the admin navigation and ordinary-user denial. The UI alone does not configure workload TLS, per-site keys/Vault bindings, or establish Ex mesh connectivity. These remain separate formal-auth rollout requirements. A completed older authority task must not stand in for completion of this follow-up.

## Follow-up 2026-11-16 — operation / hq-config / vault / bundle grants

`/admin/workloads` gained a third form (`ServiceGrantForm`) for non-monitor grants (Actio `actio:2a8fab9d-51e1-4b31-a011-b14d2f3a751b`). Actions come from a fixed list; the resource prefix is fixed per action and only the service code / `owner/name` is typed. Vault keys are entered one per line and checked for env-name shape, duplicates and the 500-key limit; keys are sent only for vault. Input building lives in the pure module `grant-input.ts`; submission reuses `useWorkloadCommand` unchanged (confirmation, serialization, 30 s uncertain stop, no retry). Cc event grants (`ai-spawn` / `ai-inject`) stay out of the UI.

Server `parseWorkloadGrant` already enforced the per-action resource shape and vault-only keys; the only change is the key limit (128 → 500) to match the Excubitor `GrantSchema` / mesh spec. Duplicate keys sent directly over WS are still deduplicated server-side.

Tests added (`server/tests/frontend/workload-service-grant.test.ts`, `server/tests/workload/input.test.ts`, `server/tests/workload/admin.test.ts`) were not executed in this session (not requested). No grants were registered, no migration applied, no restart or deployment.
