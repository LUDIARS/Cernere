// C-23: an accepted consent declaration stays inside the administrator caps, never lowers its
// version, and keeps identity.basic required. Rejections always carry a reason.
import { isWithinCaps, parsePermissionKey, type ConsentCaps } from '../permission-keys.js';
import type { ConsentDeclaration } from '../declaration-schema.js';

type Result = { readonly ok: true; readonly declaration: ConsentDeclaration } | { readonly ok: false; readonly errors: readonly string[] };

export default {
  post: (result: Result, _raw: unknown, caps: ConsentCaps, previousVersion: number | null,
    _previous: ConsentDeclaration | null): true | string => {
    if (!result.ok) return result.errors.length > 0 || 'a rejected declaration must explain why';
    const { declaration } = result;
    if (previousVersion !== null && declaration.version < previousVersion) return 'declaration version went down';
    const keys = declaration.permissions.map((p) => p.key);
    if (new Set(keys).size !== keys.length) return 'duplicate permission keys were accepted';
    for (const permission of declaration.permissions) {
      const parsed = parsePermissionKey(permission.key);
      if (!parsed) return `unknown permission key was accepted: ${permission.key}`;
      if (!isWithinCaps(parsed, caps)) return `permission outside the caps was accepted: ${permission.key}`;
      if (parsed.kind === 'identity' && permission.level !== 'required') return 'identity.basic must stay required';
    }
    return true;
  },
};
