// C-33: only the current primary can switch the primary, to a member, and only at the expected revision.
import type { SetPrimaryDecision, SetPrimaryInput } from '../policy.js';

export default {
  post: (result: SetPrimaryDecision, input: SetPrimaryInput): true | string => {
    if (!result.ok) return true;
    if (input.actorUserId !== input.primaryUserId) return 'only the primary may switch the primary';
    if (!input.memberUserIds.includes(input.candidateUserId)) return 'the new primary must be a member';
    if (input.revision !== input.expectedRevision) return 'a stale revision must be refused';
    return result.nextRevision === input.revision + 1 || 'revision must advance by one';
  },
};
