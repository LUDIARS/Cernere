// Composite 埋め込みの frame-ancestors (SPEC-EMBEDDED-COMPOSITE-001)。
// vite の compositeFramePolicy と同じく取得できなければ fail-closed。 毎リクエスト backend を
// 叩かないよう、 取得できた値を短時間だけ使い回す。
import { frameAncestorsPolicy } from "../frame-ancestors.ts";

export function createFramePolicySource(fetchOrigins, { ttlMs = 60_000, now = Date.now } = {}) {
  let cached = null;
  return async function currentPolicy() {
    if (cached && now() - cached.at < ttlMs) return cached.policy;
    const policy = frameAncestorsPolicy(await fetchOrigins());
    cached = { policy, at: now() };
    return policy;
  };
}

export function fetchAllowedOrigins(backendUrl) {
  return async () => {
    const response = await fetch(new URL("/api/auth/composite/allowed-origins", backendUrl), {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Embedding policy unavailable");
    const body = await response.json();
    return body.origins;
  };
}
