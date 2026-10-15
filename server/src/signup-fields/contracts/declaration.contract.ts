// C-27: a signup_fields declaration is accepted only when every field names an active user_data column whose
// type fits the input, and no required field belongs to a module the consent declaration marks recommended.
import type { ConsentDeclaration } from '../../consent/declaration-schema.js';
import type { SignupColumns, SignupFieldsCheck } from '../declaration.js';

const TYPES: Record<string, readonly string[]> = {
  text: ['text'], textarea: ['text'], select: ['text'], boolean: ['boolean'], number: ['integer', 'bigint'],
};

export default {
  post: (
    result: SignupFieldsCheck,
    _raw: unknown,
    columns: SignupColumns,
    consent: ConsentDeclaration | null,
  ): true | string => {
    if (!result.ok) return result.errors.length > 0 || 'a rejection must say why';
    const recommended = new Set((consent?.permissions ?? [])
      .filter((p) => p.level === 'recommended' && p.key.startsWith('user_data.module:'))
      .map((p) => p.key.slice('user_data.module:'.length)));
    for (const field of result.declaration.fields) {
      const column = Object.prototype.hasOwnProperty.call(columns, field.column) ? columns[field.column] : undefined;
      if (!column || column._deleted) return `accepted a field for a missing or deleted column: ${field.column}`;
      if (!TYPES[field.input].includes(column.type)) return `accepted ${field.input} for a ${column.type} column`;
      if (field.required && column.module && recommended.has(column.module)) return `accepted a required field in recommended module ${column.module}`;
    }
    return true;
  },
};
