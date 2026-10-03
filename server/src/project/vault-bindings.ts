import { z } from "zod";

const bindingsSchema = z.record(z.string(), z.array(z.object({ name: z.string(), present: z.boolean() })));
const statusSchema = z.object({
  bindings: bindingsSchema,
  projects: z.array(z.object({ id: z.string(), bindings: bindingsSchema })),
});

/** Reject unknown/malformed scopes rather than replacing their bindings with an empty list. */
export function readVaultBindingNames(status: unknown, service: string, project?: string): string[] {
  const parsed = statusSchema.parse(status);
  const scope = project === undefined ? parsed : parsed.projects.find((entry) => entry.id === project);
  if (!scope) throw new Error("Unknown project Vault");
  return (scope.bindings[service] ?? []).map((entry) => entry.name);
}

export function mergeVaultBindingNames(existing: string[], added: string[]): string[] {
  return [...new Set([...existing, ...added])];
}
