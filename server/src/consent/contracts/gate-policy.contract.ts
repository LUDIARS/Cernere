// C-25: consent_mode off never blocks, warn never blocks, enforce blocks exactly when consent is unsatisfied.
import type { ConsentMode } from '../declaration-schema.js';

export default {
  post: (result: 'pass' | 'warn' | 'block', mode: ConsentMode, satisfied: boolean): true | string => {
    if (mode === 'off') return result === 'pass' || 'off must not evaluate consent';
    if (satisfied) return result === 'pass' || 'satisfied consent must pass';
    if (mode === 'warn') return result === 'warn' || 'warn must let the login through and record it';
    return result === 'block' || 'enforce must stop an unsatisfied login';
  },
};
