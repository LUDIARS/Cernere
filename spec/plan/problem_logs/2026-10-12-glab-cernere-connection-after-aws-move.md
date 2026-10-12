# GLAB cannot reach Cernere after the AWS site move

- Date: 2026-10-12
- Status: partially fixed (repo side); operational steps pending human approval
- Area: Excubitor topology / Cernere catalog `provides`
- Severity: blocks GLAB login (daily goal 1128981f90ee64f5d28aac2d)

## Summary

Cernere moved to the AWS site on 2026-10-11 (spec/plan/2026-10-11-aws-site-migration.md).
Cernere itself is healthy on AWS, but GLAB (also on AWS) is still given Cernere URLs that point to
the HQ desktop, where no Cernere runs. GLAB's composite login therefore fails with `fetch failed`.

## Evidence (read-only probes, 2026-10-12)

- `https://cr.ai-run-do.com/api/auth/composite/login` with `{}` → 400 `email and password are required`
  (Cernere backend reachable through the public frontend).
- `http://100.94.102.46:8086/health` → 200, `http://100.94.102.46:5173/` → 200 (AWS Cernere up).
- `https://glab.ai-run-do.com/auth/composite/login` with `{}` → 401 `{"error":"fetch failed"}`
  (GLAB server cannot reach its `CERNERE_BASE_URL`).
- `https://glab.ai-run-do.com/api/public-config` →
  `cernereFrontendUrl: "http://100.122.174.105:5173"`, `publicUrl: "http://localhost:5187"`.
- `tailscale status`: 100.122.174.105 = desktop-3hft33b (HQ), 100.94.102.46 = ip-172-31-8-250 (AWS).
  Nothing listens on 8080/8086/5173 at HQ.
- GLAB's `CERNERE_FRONTEND_URL` / `CERNERE_BASE_URL` come from Cernere's catalog `provides`
  (`http://${host}:${port}`), where `${host}` is taken from the spawning Excubitor's
  `EXCUBITOR_TOPOLOGY_HOSTS` (Excubitor src/process/topology.ts). The HQ address therefore comes
  from a `cernere=` / `cernere-frontend=` override on the AWS Excubitor.

## Cause

1. The AWS Excubitor still carries topology overrides that send `cernere` / `cernere-frontend`
   to HQ. Since Cernere now runs on the same host as GLAB, AWS needs no override (localhost).
   The migration plan only mentioned changing the HQ Excubitor's override.
2. `CERNERE_FRONTEND_URL` is consumed only by GLAB, as the URL the browser opens (passkey popup /
   redirect). A site-internal `http://<host>:5173` cannot work there even when the host is right:
   users' devices cannot reach it and the WebAuthn RP ID does not match.
3. GLAB reads these values only at spawn, so GLAB must be restarted after the fix.

## Fix

- Repo (this change): catalog `provides.CERNERE_FRONTEND_URL` = `https://cr.ai-run-do.com`.
- Operations (not done; outside the daily goal's permissions):
  1. On the AWS Excubitor, remove `cernere=` and `cernere-frontend=` from `EXCUBITOR_TOPOLOGY_HOSTS`
     and reload its catalog/topology.
  2. On the HQ Excubitor, point `cernere=` at the AWS Tailscale IP (100.94.102.46) as planned.
  3. After this change is merged and pulled on AWS, restart GLAB via Excubitor so it re-reads
     `CERNERE_BASE_URL` / `CERNERE_FRONTEND_URL`.
  4. Separately check GLAB's `CORPUS_PUBLIC_URL` (public-config reports `http://localhost:5187`);
     that value is GLAB-owned and not changed here.

## Verification

Not run (tests and service operations not permitted for this goal). After the operations above:
`https://glab.ai-run-do.com/auth/composite/login` with `{}` should return Cernere's 400 instead of
`fetch failed`, `/api/public-config` should report `cernereFrontendUrl: https://cr.ai-run-do.com`,
and a real login on glab.ai-run-do.com should succeed.
