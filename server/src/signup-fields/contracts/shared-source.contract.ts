// C-36: a source project's columns are writable for sign-up only through a readwrite data_sharing grant to the
// caller, and only the active columns inside that grant are returned.
import type { SignupColumns } from '../declaration.js';
import type { SharedProjectDefinition } from '../shared-source.js';

export default {
  post: (result: SignupColumns | null, source: SharedProjectDefinition, callerProjectKey: string): true | string => {
    const grant = source.dataSharing.find((s) => s.project_key === callerProjectKey && s.access === 'readwrite');
    if (!grant) return result === null || `returned columns without a readwrite grant to ${callerProjectKey}`;
    if (result === null) return `returned null although ${callerProjectKey} has a readwrite grant`;
    for (const name of Object.keys(result)) {
      const column = Object.prototype.hasOwnProperty.call(source.columns, name) ? source.columns[name] : undefined;
      if (!column || column._deleted) return `returned a missing or deleted column: ${name}`;
      if (grant.columns !== undefined && !grant.columns.includes(name)) return `returned ${name}, outside the grant columns`;
      if (grant.modules && grant.modules.length > 0 && (!column.module || !grant.modules.includes(column.module))) {
        return `returned ${name}, outside the grant modules`;
      }
    }
    return true;
  },
};
