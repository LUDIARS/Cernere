// C-28: only unfilled required fields block; filled fields and fields in denied modules are never asked; an
// optional field is not shown again once the same declaration version has been shown.
import type { SignupFieldsInput, SignupFieldsRequirement } from '../requirement.js';

export default {
  post: (result: SignupFieldsRequirement, input: SignupFieldsInput): true | string => {
    const byColumn = new Map(result.all.map((f) => [f.column, f]));
    for (const column of result.missingRequired) {
      const field = byColumn.get(column);
      if (!field || !field.required || field.filled) return `missingRequired lists ${column}, which is not an unfilled required field`;
    }
    for (const column of result.optionalUnfilled) {
      const field = byColumn.get(column);
      if (!field || field.required || field.filled) return `optionalUnfilled lists ${column}, which is not an unfilled optional field`;
    }
    if (result.fields.some((f) => f.filled)) return 'a filled field is asked again';
    const denied = input.deniedModules;
    for (const field of result.all) {
      const module = input.columns[field.column]?.module;
      if (module && denied.has(module)) return `field ${field.column} of denied module ${module} is asked`;
    }
    if (input.declaration && input.seen.version !== null && input.seen.version >= input.declaration.version
      && result.optionalUnfilled.length > 0) return 'optional fields are shown again for the same version';
    return true;
  },
};
