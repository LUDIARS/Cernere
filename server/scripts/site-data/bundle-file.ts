import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { BundleHeader } from "./bundle-header.js";
import { SiteDataError } from "./site-data-error.js";

/**
 * Bundle layout: `CERNERE-DATA-BUNDLE\n` + one-line header JSON + `\n` + pg_dump custom-format bytes.
 * The header is readable without pg tools; the dump starts at `dumpOffset`.
 */
export const BUNDLE_MAGIC = "CERNERE-DATA-BUNDLE";
const MAX_PREAMBLE_BYTES = 1024 * 1024;

export interface ByteRange {
  path: string;
  start: number;
}

export interface FileDigest {
  sha256: string;
  bytes: number;
}

export interface BundlePreamble {
  header: unknown;
  dumpOffset: number;
}

/** Fails when anything (file, directory, link) already occupies the path. */
export async function assertPathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new SiteDataError("output_exists", "output path is not accessible");
  }
  throw new SiteDataError("output_exists");
}

export async function assertRegularFile(path: string): Promise<void> {
  let isFile = false;
  try {
    isFile = (await lstat(path)).isFile();
  } catch {
    // Path details stay out of diagnostics.
  }
  if (!isFile) throw new SiteDataError("input_invalid", "input must be an existing regular file");
}

export async function digestFile(path: string, start = 0): Promise<FileDigest> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { start })) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

export async function readBundlePreamble(path: string): Promise<BundlePreamble> {
  const handle = await open(path, "r");
  let text: string;
  try {
    const buffer = Buffer.alloc(MAX_PREAMBLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    text = buffer.subarray(0, bytesRead).toString("latin1");
  } finally {
    await handle.close();
  }
  const magicEnd = text.indexOf("\n");
  const headerEnd = magicEnd < 0 ? -1 : text.indexOf("\n", magicEnd + 1);
  if (magicEnd < 0 || text.slice(0, magicEnd) !== BUNDLE_MAGIC || headerEnd < 0) {
    throw new SiteDataError("bundle_invalid", "not a Cernere data bundle");
  }
  const headerBytes = Buffer.from(text.slice(magicEnd + 1, headerEnd), "latin1");
  let header: unknown;
  try {
    header = JSON.parse(headerBytes.toString("utf8"));
  } catch {
    throw new SiteDataError("bundle_invalid", "header is not JSON");
  }
  return { header, dumpOffset: headerEnd + 1 };
}

/** Creates `output` exclusively; a partially written bundle is removed so a retry can reuse the name. */
export async function writeBundle(output: string, header: BundleHeader, dumpPath: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(output, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SiteDataError("output_exists");
    throw error;
  }
  try {
    await handle.write(`${BUNDLE_MAGIC}\n${JSON.stringify(header)}\n`);
    // The write stream owns the handle from here and closes it when the pipeline ends.
    await pipeline(createReadStream(dumpPath), handle.createWriteStream());
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(output).catch(() => undefined);
    throw error;
  }
}
