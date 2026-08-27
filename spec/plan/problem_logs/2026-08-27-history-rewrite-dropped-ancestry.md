# History Rewrite Dropped Published Ancestry

- Date: 2026-08-27
- Status: unresolved
- Area: repository history / release governance
- Severity: high — published commit identity and ancestry were replaced

## Summary

Cernere's repository was not deleted and recreated, but its published `main` history was regenerated and force-updated. This is a regression against the requirement that repository reorganization preserve history. A reorganization should normally be expressed as ordinary moves and follow-up commits so existing commit identities and ancestry remain reachable.

## Evidence

- GitHub reports repository ID `1196237588` with `created_at=2026-03-30T14:00:38Z`; the repository object itself was retained.
- The local reflog records `refs/remotes/origin/main` as a `forced-update` on 2026-07-28 13:13 JST, from `b645053594f4b9e438aadef0a3c27d8468e605c1` to `b13cabdeaf8aac1cab68caa1a95636f3c0db3e6a`.
- Both endpoints contain 185 commits and identify the same final change (`fix(spec): purge_user と FK 制約の矛盾を解消 (#160)`) with the same author timestamp, but every rewritten commit has a different object ID.
- `git merge-base 883dbd216faac06ca63649e8b48c602eada7c739 main` finds no common ancestor. The pre-rewrite root `5d6cc7f785c943fc4697863a805a92a2864814a9` and current root `f91d872cf092bcc65a8d0e410ff2ca4a959614e4` share the same initial-commit metadata but are different Git objects.
- The old and rewritten tips differ in 14 files (58 insertions and 58 deletions), primarily identifier redaction and renaming, rather than a new repository implementation.
- A later recovery incident found that four local-only commits had fallen out of `main` and had to be recovered from `preserve/local-main-20260806`.

## Regression Context

The intended operation was history-preserving repository reorganization. Recreating every commit and force-updating `main` instead invalidated existing SHAs, detached local-only work, and made historical review artifacts harder to map to current code. This is a governance regression even though the GitHub repository, Issues, and creation date survived.

## Cause

The immediate cause was a bulk history rewrite followed by a force-update of `main`. The old and new tips have equal commit counts and near-equivalent trees, which is consistent with replaying the full history to redact or rename identifiers. The exact tool and operator command have not yet been identified.

## Fix Requirements

- Treat published ancestry and commit object IDs as data that must be preserved during future reorganizations.
- Express directory, project-key, and naming reorganization through ordinary commits (`git mv` plus focused edits), without rewriting unaffected ancestors.
- Inventory all still-available pre-rewrite refs, stashes, downstream worktrees, submodule pins, review artifacts, and local-only commits before choosing a repair operation.
- Do not restore the old graph blindly: the rewrite appears to have removed or renamed identifiers, so reconnecting old objects may make intentionally redacted history reachable again.
- Choose an explicit recovery policy for the privacy/history conflict. Candidate approaches include a restricted archival bundle, a protected non-public recovery ref, or a content-neutral ancestry bridge only when making the old objects reachable is approved.
- Do not force-push another replacement history without explicit authorization, a downstream migration plan, and verified recovery refs.
- Add a repository-governance guard that rejects non-fast-forward updates to the protected default branch except through a separately approved incident procedure.

## Verification

- No unit, integration, launch, or service test is required for this documentation-only incident record, and none was run.
- Before any repair, record `git fsck --full`, all root commits, relevant reflogs, and pre/post rewrite tip trees without modifying refs.
- A proposed recovery must demonstrate that required historical commits remain reachable, current `main` content is unchanged unless separately reviewed, no local-only commits are lost, and intentionally redacted data is not republished without approval.
- Validate downstream submodule pins and stored review SHAs against an explicit old-to-new mapping.

## Follow-up

- Identify the original rewrite command and the complete redaction scope.
- Decide whether history preservation or historical redaction takes precedence for each affected object; this is a human governance and privacy decision.
- Prepare a non-destructive recovery plan for review before changing `main` or any remote ref.
