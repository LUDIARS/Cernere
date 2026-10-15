// C-24: consent is satisfied exactly when no required permission is ungranted and no recommended
// permission is undecided; identity.basic is always shown as required.
import type { ConsentRequirement } from '../requirement.js';

export default {
  post: (result: ConsentRequirement): true | string => {
    const required = new Set(result.view.required.map((p) => p.key));
    if (!required.has('identity.basic')) return 'identity.basic must always be listed as required';
    if (result.missingRequired.some((key) => !required.has(key))) return 'missingRequired lists a non-required permission';
    const recommended = new Set(result.view.recommended.map((p) => p.key));
    if (result.pendingRecommended.some((key) => !recommended.has(key))) return 'pendingRecommended lists a non-recommended permission';
    const expected = result.missingRequired.length === 0 && result.pendingRecommended.length === 0;
    return result.satisfied === expected || 'satisfied disagrees with the missing / pending permissions';
  },
};
