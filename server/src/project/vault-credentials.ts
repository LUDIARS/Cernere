import type { ProjectCredentials } from "./credential-delivery.js";
import { mergeVaultBindingNames, readVaultBindingNames } from "./vault-bindings.js";
import { resolveVaultEndpoint } from "./vault-endpoint.js";

export interface VaultTarget {
  service: string;
  project?: string;
  prefix?: string;
}

export function projectCredentialNames(key: string, prefix?: string): [string, string] {
  // Aedilis has historically consumed the Excubitor launcher credentials.
  const resolved = prefix ?? (key.toLowerCase() === "aedilis" ? "EXCUBITOR" : key.toUpperCase().replace(/[^A-Z0-9]/g, "_"));
  if (!/^[A-Z_][A-Z0-9_]*$/.test(resolved)) throw new Error("Invalid Vault credential prefix");
  return [`${resolved}_CERNERE_CLIENT_ID`, `${resolved}_CERNERE_CLIENT_SECRET`];
}

async function vaultRequest(url: string, body?: unknown): Promise<Response> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "PUT",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Vault request failed");
  }
  if (body !== undefined) await response.body?.cancel();
  return response;
}

/** No DB writes and no logging here. The caller commits its hash only after this resolves. */
export async function saveProjectCredentials(credentials: ProjectCredentials, target: VaultTarget): Promise<void> {
  try {
    if (!target.service.trim() || (target.project !== undefined && !target.project.trim())) throw new Error();
    const base = resolveVaultEndpoint();
    const [idName, secretName] = projectCredentialNames(credentials.key, target.prefix);
    const query = target.project === undefined ? "" : `?${new URLSearchParams({ project: target.project })}`;
    const status = await (await vaultRequest(`${base}/api/v1/vault`)).json();
    const existing = readVaultBindingNames(status, target.service, target.project);
    const names = mergeVaultBindingNames(existing, [idName, secretName]);

    // Bind first, then write ID, then secret last. A binding failure cannot invalidate an old secret.
    if (names.some((name) => !existing.includes(name))) {
      await vaultRequest(`${base}/api/v1/vault/bindings/${encodeURIComponent(target.service)}${query}`, { names });
    }
    await vaultRequest(`${base}/api/v1/vault/entries/${idName}${query}`, { value: credentials.clientId });
    await vaultRequest(`${base}/api/v1/vault/entries/${secretName}${query}`, { value: credentials.clientSecret });
  } catch {
    // Neither remote response bodies nor nested causes are safe to publish.
    throw new Error("Vault credential save failed; Cernere DB was not updated");
  }
}
