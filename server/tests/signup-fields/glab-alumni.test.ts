import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateSignupFieldsDeclaration } from '../../src/signup-fields/declaration.js';
import { readSignupFieldsDeclaration } from '../../src/signup-fields/declaration-schema.js';
import { evaluateSignupFields } from '../../src/signup-fields/requirement.js';
import { validateSignupFieldValues } from '../../src/signup-fields/values.js';
import { initialSignupValues, requiredFilled } from '../../../frontend/src/lib/signup-fields-form.js';

const schema = JSON.parse(readFileSync(new URL('../../service/glab/schema.json', import.meta.url), 'utf8'));
function requirement(values: Record<string, unknown> = {}) {
  return evaluateSignupFields({ declaration: readSignupFieldsDeclaration(schema.signup_fields),
    columns: schema.user_data.columns, consent: null, values, deniedModules: new Set(),
    seen: { version: 2, columns: ['name', 'role_title', 'department_name'] } });
}
const common = { name: 'Name', role_title: 'Member' };

describe('GLab membership registration', () => {
  it('accepts the declaration and keeps the migration declaration synchronized', () => {
    expect(validateSignupFieldsDeclaration(schema.signup_fields, schema.user_data.columns, null, 2).ok).toBe(true);
    const sql = readFileSync(new URL('../../../migrations/079_glab_alumni_registration.sql', import.meta.url), 'utf8');
    const match = sql.match(/definition, '\{signup_fields\}', '([\s\S]*?)'::jsonb/);
    expect(JSON.parse(match![1])).toEqual(schema.signup_fields);
  });

  it('requires student department and grade, accepts alumni without them or optional fields', () => {
    const fields = requirement().fields;
    expect(validateSignupFieldValues(fields, { ...common, member_type: 'student' })).toEqual({
      ok: false, errors: { department_name: '入力してください', grade: '入力してください' },
    });
    expect(validateSignupFieldValues(fields, { ...common, member_type: 'student', department_name: 'Games', grade: '2' }).ok).toBe(true);
    expect(validateSignupFieldValues(fields, { ...common, member_type: 'alumni' }).ok).toBe(true);
    for (const member_type of ['student', 'alumni']) {
      expect(validateSignupFieldValues(fields, { member_type, department_name: 'Games', grade: 2 }).ok).toBe(false);
    }
  });

  it('rejects unknown selectors, whitespace bypasses and invalid grades', () => {
    const fields = requirement().fields;
    expect(validateSignupFieldValues(fields, { ...common, member_type: 'unknown' }).ok).toBe(false);
    expect(validateSignupFieldValues(fields, { ...common, member_type: ' student ' }).ok).toBe(false);
    for (const grade of [0, -1, 1.5, 2147483648]) {
      expect(validateSignupFieldValues(fields, { ...common, member_type: 'student', department_name: 'Games', grade }).ok).toBe(false);
    }
  });

  it('validates a changed tab against saved values and ignores hidden submitted fields', () => {
    const fields = requirement({ ...common, member_type: 'alumni' }).fields;
    expect(validateSignupFieldValues(fields, { member_type: 'student' }).ok).toBe(false);
    expect(validateSignupFieldValues(fields, { member_type: 'alumni', grade: 'invalid', company: '' }))
      .toEqual({ ok: true, values: { member_type: 'alumni', company: null } });
    expect(requirement({ ...common, member_type: 'alumni' }).missingRequired).toEqual([]);
    expect(requirement({ ...common, department_name: 'Games' }).missingRequired).toEqual(['member_type']);
  });

  it('enables the form for alumni without hidden student fields and retains drafts across switches', () => {
    const fields = requirement().fields;
    const values = { ...initialSignupValues(fields), ...common, member_type: 'alumni' };
    expect(requiredFilled(fields, values)).toBe(true);
    expect(requiredFilled(fields, { ...values, member_type: 'student' })).toBe(false);
    expect(requiredFilled(fields, { ...values, member_type: 'student', department_name: 'Games', grade: '1e3' })).toBe(false);
    expect(requiredFilled(fields, { ...values, member_type: 'student', department_name: 'Games', grade: 2 })).toBe(true);
  });

  it('rejects invalid conditional references', () => {
    const declaration = structuredClone(schema.signup_fields);
    declaration.fields[4].visible_when.column = 'name';
    expect(validateSignupFieldsDeclaration(declaration, schema.user_data.columns, null, 2).ok).toBe(false);
  });

  it('does not ask completed alumni for hidden student fields or seen optional values again', () => {
    const result = evaluateSignupFields({ declaration: readSignupFieldsDeclaration(schema.signup_fields),
      columns: schema.user_data.columns, consent: null, values: { ...common, member_type: 'alumni' },
      deniedModules: new Set(), seen: { version: 3, columns: [] } });
    expect(result.missingRequired).toEqual([]);
    expect(result.fields).toEqual([]);
  });
});
