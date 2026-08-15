// `sessionvault restore` — rebuild an archive on disk.
//
// Runs are applied oldest first, so a file that changed many times ends up
// with its newest copy. Nothing is written back into a live agent folder:
// the target is a plain directory that you choose.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { loadConfig, remoteKeys } from '../config.js';
import { createBackend } from '../backends/index.js';
import { tarEntries } from '../tar.js';
import { decryptFile, isEncrypted } from '../bundle.js';
import { colour, formatBytes, log, ok, step, warn } from '../ui.js';

export async function restore(options = {}) {
  const config = loadConfig(options.configOverrides);
  const machine = options.machine || config.machine;
  const target = path.resolve(options.to || path.join(process.cwd(), `sessionvault-restore-${machine}`));
  const keys = remoteKeys({ ...config, machine });
  const backend = createBackend(config);

  log(colour.bold(`SessionVault restore`));
  log(colour.grey(`machine ${machine} → ${target}`));
  log();

  const indexBuffer = await backend.getBuffer(keys.index);
  if (!indexBuffer) {
    throw new Error(
      `no index was found for the machine "${machine}". ` +
        'Run `sessionvault machines` to see what the bucket holds.',
    );
  }
  const index = JSON.parse(indexBuffer.toString('utf8'));

  let runs = [...index.runs].sort((a, b) => (a.at < b.at ? -1 : 1));
  if (options.at) {
    runs = runs.filter((run) => run.at <= options.at || run.runId === options.at);
  }
  if (options.runId) {
    runs = runs.filter((run) => run.runId === options.runId);
  }
  if (runs.length === 0) throw new Error('no run matched the request');

  step(`Applying ${runs.length} run${runs.length === 1 ? '' : 's'}…`);
  fs.mkdirSync(target, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionvault-restore-'));

  let written = 0;
  let bytes = 0;
  try {
    for (const run of runs) {
      for (const key of run.parts) {
        const local = path.join(workDir, path.basename(key));
        const found = await backend.get(key, local);
        if (!found) {
          warn(`missing object: ${key}`);
          continue;
        }

        let readable = local;
        if (isEncrypted(local)) {
          const passphrase = process.env[config.passphraseEnv || 'SESSIONVAULT_PASSPHRASE'];
          if (!passphrase) {
            throw new Error(
              `${key} is encrypted. Set ${config.passphraseEnv} to the passphrase and try again.`,
            );
          }
          readable = `${local}.plain`;
          await decryptFile(local, readable, passphrase);
        }

        const source = fs.createReadStream(readable).pipe(zlib.createGunzip());
        for await (const entry of tarEntries(source)) {
          if (entry.name === '_manifest.json') continue;
          const destination = safeJoin(target, entry.name);
          if (!destination) {
            warn(`skipped an unsafe path: ${entry.name}`);
            continue;
          }
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, entry.data);
          written += 1;
          bytes += entry.data.length;
        }

        fs.rmSync(local, { force: true });
        if (readable !== local) fs.rmSync(readable, { force: true });
      }
      log(colour.grey(`  ${run.runId}  ${run.files} files`));
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  ok(`Restored ${written} files (${formatBytes(bytes)}) into ${target}`);
  return { target, files: written, bytes };
}

/** Refuse any archive path that would escape the target folder. */
function safeJoin(root, entryName) {
  const cleaned = entryName.replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.split('/').includes('..')) return null;
  const full = path.resolve(root, cleaned);
  const relative = path.relative(root, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return full;
}
