// C-31: unfederated accounts keep their own id, federated accounts get the fixed federation subject,
// and a founder detached from its federation is flagged so services are refused.
import type { FederationMembership, ServiceSubject } from '../policy.js';

export default {
  post: (result: ServiceSubject, userId: string, membership: FederationMembership | null, ownsForeignSubject: boolean): true | string => {
    if (membership) {
      if (result.subject !== membership.subjectId) return 'a federated account must use the federation subject';
      if (result.primaryUserId !== membership.primaryUserId) return 'profile must come from the federation primary';
      return !result.detachedFounder || 'a member is never a detached founder';
    }
    if (result.subject !== userId || result.primaryUserId !== userId) return 'an unfederated account must use its own id';
    return result.detachedFounder === ownsForeignSubject || 'detached founder flag must follow subject ownership';
  },
};
