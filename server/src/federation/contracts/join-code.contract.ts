// C-35: only an exact 4-digit match approves; mismatches count up and lock at the attempt limit.
import { JOIN_CODE_MAX_ATTEMPTS, type JoinCodeCheck } from '../policy.js';

export default {
  post: (result: JoinCodeCheck, expected: string, actual: string, previousAttempts: number): true | string => {
    const match = /^\d{4}$/.test(expected) && expected === actual;
    if (match) return result === 'match' || 'an exact 4-digit code must match';
    if (result === 'match') return 'a different or malformed code must never match';
    return result === (previousAttempts + 1 >= JOIN_CODE_MAX_ATTEMPTS ? 'locked' : 'retry') || 'attempt limit must lock';
  },
};
