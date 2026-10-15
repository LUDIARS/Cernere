// C-32: joining is refused for self, already federated accounts, accounts owning another federation's subject,
// and anything beyond 10 accounts; a new federation always uses the approver's id as its subject.
import { FEDERATION_MAX_ACCOUNTS, type JoinDecision, type JoinInput } from '../policy.js';

export default {
  post: (result: JoinDecision, input: JoinInput): true | string => {
    const mustRefuse = input.approverUserId === input.joinerUserId || input.joinerFederated || input.joinerOwnsSubject
      || (input.approverMembership ? input.memberCount : 1) + 1 > FEDERATION_MAX_ACCOUNTS;
    if (mustRefuse) return !result.ok || 'join must be refused';
    if (!result.ok) return `join must be allowed (${result.reason})`;
    if (result.memberCountAfter > FEDERATION_MAX_ACCOUNTS) return 'a federation must not exceed 10 accounts';
    const expectedSubject = input.approverMembership?.subjectId ?? input.approverUserId;
    return result.subjectId === expectedSubject || 'the subject must be the existing subject or the approver id';
  },
};
