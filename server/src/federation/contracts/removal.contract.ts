// C-34: removal is self-leave or removal by the primary; a leaving primary hands over to a remaining member;
// the federation closes when one or fewer accounts remain.
import type { RemovalDecision, RemovalInput } from '../policy.js';

export default {
  post: (result: RemovalDecision, input: RemovalInput): true | string => {
    if (!result.ok) return true;
    const leaving = input.actorUserId === input.targetUserId;
    if (!leaving && input.actorUserId !== input.primaryUserId) return 'only the primary may remove another account';
    if (input.revision !== input.expectedRevision) return 'a stale revision must be refused';
    const remaining = input.memberUserIds.filter((id) => id !== input.targetUserId);
    if (result.closes !== (remaining.length <= 1)) return 'close exactly when one or fewer accounts remain';
    if (!result.closes && input.targetUserId === input.primaryUserId) {
      return (result.nextPrimaryUserId !== null && remaining.includes(result.nextPrimaryUserId)) || 'a remaining member must become primary';
    }
    return result.nextPrimaryUserId === null || 'primary must not change unless the primary leaves';
  },
};
