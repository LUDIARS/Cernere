// C-26: a consent continuation only ever points at an allowed origin (no open redirect).
import type { ConsentContinuation } from '../continuation.js';

export default {
  post: (result: ConsentContinuation | null, _request: unknown, allowedOrigins: readonly string[]): true | string => {
    if (result === null) return true;
    const target = result.kind === 'redirect' ? result.url : result.origin;
    let origin: string;
    try { origin = new URL(target).origin; } catch { return 'continuation target is not a URL'; }
    if (result.kind === 'post_message' && origin !== result.origin) return 'post_message target must be a bare origin';
    return allowedOrigins.includes(origin) || `continuation escaped the allowed origins: ${origin}`;
  },
};
