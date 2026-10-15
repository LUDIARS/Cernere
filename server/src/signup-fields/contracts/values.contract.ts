// C-29: values are accepted only for asked fields; an empty required field or a value of the wrong kind becomes a
// per-field error, and any error means no value is returned.
import type { SignupFieldView } from '../requirement.js';
import type { SignupValuesCheck } from '../values.js';

export default {
  post: (result: SignupValuesCheck, fields: readonly SignupFieldView[], input: Readonly<Record<string, unknown>>): true | string => {
    const asked = new Map(fields.map((f) => [f.column, f]));
    if (!result.ok) {
      const columns = Object.keys(result.errors);
      if (columns.length === 0) return 'a rejection must name at least one field';
      return columns.every((c) => asked.has(c)) || 'an error names a field that was not asked';
    }
    for (const [column, value] of Object.entries(result.values)) {
      const field = asked.get(column);
      if (!field) return `a value for an unasked column was kept: ${column}`;
      if (!Object.prototype.hasOwnProperty.call(input, column)) return `a value was invented for ${column}`;
      if (field.required && value === null) return `required field ${column} was accepted empty`;
      if (field.input === 'select' && value !== null && !field.options?.some((o) => o.value === value)) return `select ${column} accepted a value outside its options`;
    }
    for (const field of fields) {
      if (field.required && !field.filled && !(field.column in result.values)) return `required field ${field.column} was left unfilled`;
    }
    return true;
  },
};
