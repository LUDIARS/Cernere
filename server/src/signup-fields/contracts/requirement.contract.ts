// C-28: only unfilled required fields block; filled fields and fields in denied modules are never asked; an
// optional field is not shown again once the same declaration version has been shown. A field of another
// project is asked only while that project still grants the column (it appears in input.sources).
import type { SignupFieldsInput, SignupFieldsRequirement } from '../requirement.js';

export default {
  post: (result: SignupFieldsRequirement, input: SignupFieldsInput): true | string => {
    const byColumn = new Map(result.all.map((f) => [f.column, f]));
    for (const column of result.missingRequired) {
      const field = byColumn.get(column);
      if (!field || !field.required) return `missingRequired lists ${column}, which is not a required field`;
      if (field.visibleWhen && input.values[field.visibleWhen.column] !== field.visibleWhen.value) return `hidden field ${column} blocks registration`;
      const hasValidOption = !field.options || field.options.some((option) => option.value === field.value);
      const meetsMinimum = field.minimum === undefined || (typeof field.value === 'number' && field.value >= field.minimum);
      if (field.filled && hasValidOption && meetsMinimum) {
        return `missingRequired lists ${column}, which already has a valid value`;
      }
    }
    for (const column of result.optionalUnfilled) {
      const field = byColumn.get(column);
      if (!field || field.required || field.filled) return `optionalUnfilled lists ${column}, which is not an unfilled optional field`;
    }
    if (!result.all.some((f) => f.visibleWhen) && result.fields.some((f) => f.filled)) return 'a filled field is asked again';
    const denied = input.deniedModules;
    for (const field of result.all) {
      if (field.project !== null) {
        const columns = input.sources?.[field.project]?.columns ?? {};
        const column = Object.prototype.hasOwnProperty.call(columns, field.column) ? columns[field.column] : undefined;
        if (!column || column._deleted) return `field ${field.column} of ${field.project} is asked without a grant`;
        continue;
      }
      const module = input.columns[field.column]?.module;
      if (module && denied.has(module)) return `field ${field.column} of denied module ${module} is asked`;
    }
    if (input.declaration && input.seen.version !== null && input.seen.version >= input.declaration.version
      && result.optionalUnfilled.length > 0) return 'optional fields are shown again for the same version';
    return true;
  },
};
