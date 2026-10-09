export default {
  post: (result: { action: string; resource: string; keys?: string[] }): true | string =>
    (result.action === 'vault'
      ? !!result.keys?.length && new Set(result.keys).size === result.keys.length && result.resource.startsWith('service:')
      : result.keys === undefined) || 'invalid workload secret-key allowlist',
};
