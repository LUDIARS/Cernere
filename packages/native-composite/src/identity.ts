import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";

/** One opaque installation identity per OS user. It is never an authentication credential. */
export function defaultIdentityDirectory(): string {
  const home = homedir();
  if (!home || !isAbsolute(home)) throw new Error("A local user home is required");
  if (platform() === "win32") return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Cernere", "native-composite");
  if (platform() === "darwin") return join(home, "Library", "Application Support", "Cernere", "native-composite");
  return join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "cernere", "native-composite");
}

function parseIdentity(raw: string): string {
  const value = JSON.parse(raw) as { version?: unknown; id?: unknown } | null;
  if (value?.version !== 1 || typeof value.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)) {
    throw new Error("Invalid native-composite identity; restore the file instead of silently replacing it");
  }
  return value.id;
}

export async function localIdentity(directory = defaultIdentityDirectory()): Promise<string> {
  if (!isAbsolute(directory)) throw new Error("Identity directory must be absolute");
  const target = join(directory, "identity.json");
  try { return parseIdentity(await readFile(target, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID(), temporary = join(directory, ".identity-" + randomUUID());
  await writeFile(temporary, JSON.stringify({ version: 1, id }) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    // Publish a complete file without replacing an identity won by another process.
    try { await link(temporary, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return parseIdentity(await readFile(target, "utf8"));
  } finally { await unlink(temporary); }
}
