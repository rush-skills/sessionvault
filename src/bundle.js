// Build the archive bundles that go to the bucket.
//
// How a run works:
//   1. Scan every agent and list the files it owns.
//   2. Compare the list against the local state. Keep only the new files and
//      the changed ones.
//   3. Write the kept files into one or more tar.gz parts, each below the
//      size limit of the backend.
//   4. Optionally encrypt each part with AES-256-GCM.
//
// A part is self-contained: it holds a `_manifest.json` at its root, so an
// archive stays readable even if the index is lost.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { TarPack } from './tar.js';
import { copyDatabase } from './sqlite.js';

const ENCRYPTION_MAGIC = Buffer.from('SVAULT01');

/** Hash a file. Used to avoid uploading a file whose content did not change. */
export function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

/**
 * Decide what to send this run.
 * `files` comes from the scanner. `state.files` maps key -> record.
 */
export function selectChanged(files, state, config, now = Date.now()) {
  const selected = [];
  const skipped = { unchanged: 0, heavyWait: 0, tooBig: 0 };
  const maxFileBytes = (config.maxFileMB || 2048) * 1024 * 1024;
  const heavyWindow = (config.heavyIntervalHours ?? 24) * 3600 * 1000;

  for (const file of files) {
    const previous = state.files[file.key];

    if (file.size > maxFileBytes) {
      skipped.tooBig += 1;
      continue;
    }

    // A large file that changes on every run is sent on an interval.
    if (file.heavy && previous?.uploadedAt && now - previous.uploadedAt < heavyWindow) {
      skipped.heavyWait += 1;
      continue;
    }

    if (previous && previous.size === file.size && previous.mtimeMs === file.mtimeMs) {
      skipped.unchanged += 1;
      continue;
    }
    selected.push(file);
  }

  // A key that the state knows about but the scan no longer sees was removed
  // locally. The bucket keeps its copy; the manifest only records the fact.
  const presentKeys = new Set(files.map((file) => file.key));
  const removed = Object.keys(state.files).filter((key) => !presentKeys.has(key));

  return { selected, removed, skipped };
}

/** Prepare a file for the archive. A database is copied through SQLite. */
async function materialise(file, workDir) {
  if (!file.sqlite) return { source: file.absolute, extra: [] };

  const target = path.join(workDir, `db-${crypto.randomUUID()}`);
  const result = await copyDatabase(file.absolute, target);
  const extra = result.sidecars.map((suffix) => ({
    key: `${file.key}${suffix}`,
    source: `${target}${suffix}`,
  }));
  return { source: target, extra, method: result.method };
}

/**
 * Write the selected files into tar.gz parts.
 * Returns { parts: [{ path, name, bytes, files }], entries: [{key, size, hash}] }
 */
export async function buildParts({ files, runId, config, workDir, header, onProgress }) {
  fs.mkdirSync(workDir, { recursive: true });
  const limit = (config.maxBundleMB || 240) * 1024 * 1024;

  const parts = [];
  const entries = [];
  let part = null;
  let index = 0;

  const openPart = async () => {
    index += 1;
    const partPath = path.join(workDir, `${runId}.part${String(index).padStart(3, '0')}.tar.gz`);
    const output = fs.createWriteStream(partPath);
    const gzip = zlib.createGzip({ level: 6 });
    const done = pipeline(gzip, output);
    part = { index, path: partPath, gzip, done, pack: new TarPack(gzip), files: 0, raw: 0 };

    // Every part starts with a small header entry, so a bundle found on its
    // own still says which machine and which run produced it. Standard tar
    // lists it first.
    if (header) {
      await part.pack.addBuffer(
        '_sessionvault.json',
        Buffer.from(JSON.stringify({ ...header, part: index }, null, 2)),
      );
    }
  };

  const closePart = async () => {
    if (!part) return;
    await part.pack.finish();
    part.gzip.end();
    await part.done;
    const { size } = fs.statSync(part.path);
    parts.push({
      index: part.index,
      path: part.path,
      bytes: size,
      rawBytes: part.raw,
      files: part.files,
    });
    part = null;
  };

  for (const file of files) {
    if (!part) await openPart();

    let prepared;
    try {
      prepared = await materialise(file, workDir);
    } catch (error) {
      onProgress?.({ type: 'error', key: file.key, message: String(error.message || error) });
      continue;
    }

    try {
      const stat = fs.statSync(prepared.source);
      await part.pack.addFile(file.key, prepared.source, stat);
      entries.push({
        key: file.key,
        size: stat.size,
        mtimeMs: file.mtimeMs,
        sourceSize: file.size,
        hash: hashFile(prepared.source),
        sqlite: Boolean(file.sqlite),
      });
      part.files += 1;
      part.raw += stat.size;

      for (const sidecar of prepared.extra) {
        if (!fs.existsSync(sidecar.source)) continue;
        const sidecarStat = fs.statSync(sidecar.source);
        await part.pack.addFile(sidecar.key, sidecar.source, sidecarStat);
        entries.push({ key: sidecar.key, size: sidecarStat.size, hash: hashFile(sidecar.source) });
        part.files += 1;
        part.raw += sidecarStat.size;
      }

      onProgress?.({ type: 'file', key: file.key, size: stat.size });
    } catch (error) {
      onProgress?.({ type: 'error', key: file.key, message: String(error.message || error) });
    } finally {
      // Remove any temporary database copy at once. These are large.
      if (prepared.source !== file.absolute) {
        fs.rmSync(prepared.source, { force: true });
        for (const sidecar of prepared.extra) fs.rmSync(sidecar.source, { force: true });
      }
    }

    // gzip buffers internally, so the file on disk lags behind. Use the raw
    // total as the trigger and accept parts a little under the limit.
    if (part.raw >= limit) await closePart();
  }

  await closePart();
  return { parts, entries };
}

// --------------------------------------------------------------- encryption

// scrypt with N=2^15, r=8 needs 128 * N * r bytes = 32 MB. That is exactly
// the default ceiling in Node, so maxmem must be raised or the call fails.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

export function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, SCRYPT);
}

/**
 * Encrypt a file in place with AES-256-GCM.
 * Layout: magic(8) | salt(16) | iv(12) | tag(16) | ciphertext
 */
export async function encryptFile(filePath, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const temporary = `${filePath}.enc`;
  const output = fs.createWriteStream(temporary);
  // Reserve the header. The tag is only known at the end.
  output.write(Buffer.concat([ENCRYPTION_MAGIC, salt, iv, Buffer.alloc(16)]));
  await pipeline(fs.createReadStream(filePath), cipher, output);

  const tag = cipher.getAuthTag();
  const handle = fs.openSync(temporary, 'r+');
  try {
    fs.writeSync(handle, tag, 0, 16, ENCRYPTION_MAGIC.length + 16 + 12);
  } finally {
    fs.closeSync(handle);
  }
  fs.rmSync(filePath, { force: true });
  fs.renameSync(temporary, filePath);
  return filePath;
}

export async function decryptFile(filePath, destination, passphrase) {
  const handle = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(8 + 16 + 12 + 16);
  try {
    fs.readSync(handle, header, 0, header.length, 0);
  } finally {
    fs.closeSync(handle);
  }
  if (!header.subarray(0, 8).equals(ENCRYPTION_MAGIC)) {
    throw new Error('this part is not encrypted, or it is not a SessionVault part');
  }
  const salt = header.subarray(8, 24);
  const iv = header.subarray(24, 36);
  const tag = header.subarray(36, 52);
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  await pipeline(
    fs.createReadStream(filePath, { start: header.length }),
    decipher,
    fs.createWriteStream(destination),
  );
  return destination;
}

export function isEncrypted(filePath) {
  try {
    const handle = fs.openSync(filePath, 'r');
    try {
      const magic = Buffer.alloc(8);
      fs.readSync(handle, magic, 0, 8, 0);
      return magic.equals(ENCRYPTION_MAGIC);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return false;
  }
}

export function workDirFor(runId) {
  return path.join(os.tmpdir(), `sessionvault-${runId}`);
}
