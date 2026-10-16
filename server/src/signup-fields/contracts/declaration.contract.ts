// C-27: a signup_fields declaration is accepted only when every field names an active user_data column whose
// type fits the input, and no required field belongs to a module the consent declaration marks recommended.
// A field of another project is accepted only when that project grants this one readwrite on the column.
import type { ConsentDeclaration } from '../../consent/declaration-schema.js';
import type { SignupColumns, SignupFieldsCheck, SignupSharing } from '../declaration.js';

const TYPES: Record<string, readonly string[]> = {
  text: ['text'], textarea: ['text'], select: ['text'], boolean: ['boolean'], number: ['integer', 'bigint'],
};

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export default {
  post: (
    result: SignupFieldsCheck,
    _raw: unknown,
    columns: SignupColumns,
    consent: ConsentDeclaration | null,
    _previousVersion: number | null,
    sharing?: SignupSharing,
  ): true | string => {
    if (!result.ok) return result.errors.length > 0 || 'a rejection must say why';
    const recommended = new Set((consent?.permissions ?? [])
      .filter((p) => p.level === 'recommended' && p.key.startsWith('user_data.module:'))
      .map((p) => p.key.slice('user_data.module:'.length)));
    for (const field of result.declaration.fields) {
      const shared = field.project !== undefined && field.project !== sharing?.ownKey;
      let column = own(columns, field.column);
      if (shared) {
        const source = sharing ? own(sharing.sources, field.project!) : undefined;
        const grant = source?.dataSharing.find((s) => s.project_key === sharing?.ownKey && s.access === 'readwrite');
        if (!source || !grant) return `accepted a field of ${field.project} without a readwrite grant`;
        if (grant.columns !== undefined && !grant.columns.includes(field.column)) return `accepted ${field.column} outside the grant`;
        column = own(source.columns, field.column);
        if (column && grant.modules && grant.modules.length > 0 && (!column.module || !grant.modules.includes(column.module))) {
          return `accepted ${field.column} outside the grant modules`;
        }
      }
      if (!column || column._deleted) return `accepted a field for a missing or deleted column: ${field.column}`;
      if (!TYPES[field.input].includes(column.type)) return `accepted ${field.input} for a ${column.type} column`;
      if (!shared && field.required && column.module && recommended.has(column.module)) return `accepted a required field in recommended module ${column.module}`;
    }
    return true;
  },
};
