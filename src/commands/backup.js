// `sessionvault backup` — the command that does the work.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, loadState, saveState, machineInfo, remoteKeys } from '../config.js';
import { createBackend } from '../backends/index.js';
import { scanAll } from '../scan.js';
import { selectChanged, buildParts, encryptFile, workDirFor } from '../bundle.js';
import { colour, formatBytes, formatDuration, log, ok, step, warn, fail, progress } from '../ui.js';

function runId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function passphraseFor(config) {
  const value = process.env[config.passphraseEnv || 'SESSIONVAULT_PASSPHRASE'];
  if (!value) {
    throw new Error(
      `encryption is on, but ${config.passphraseEnv} is empty. ` +
        'Set it, or turn encryption off in the config.',
    );
  }
  return value;
}

export async function backup(options = {}) {
  const started = Date.now();
  const config = loadConfig(options.configOverrides);
  const state = options.full ? { version: 1, files: {}, runs: [], lastRunAt: null } : loadState(config);
  const id = runId();
  const keys = remoteKeys(config);

  log(colour.bold(`SessionVault backup  ${colour.grey(`run ${id}`)}`));
  log(colour.grey(`machine ${config.machine}   backend ${config.backend}   bucket ${config.bucket}`));
  log();

  // ------------------------------------------------------------- 1. scan
  step('Scanning for agent history…');
  const scans = scanAll({
    only: options.only,
    skip: config.skipAgents,
    includeConfig: config.includeConfig,
  });
  const present = scans.filter((scan) => scan.found);
  const allFiles = present.flatMap((scan) => scan.files);
  const totalBytes = allFiles.reduce((sum, file) => sum + file.size, 0);

  for (const scan of present) {
    log(
      `  ${colour.green('•')} ${scan.name.padEnd(28)} ${String(scan.files.length).padStart(6)} files  ${formatBytes(scan.bytes).padStart(8)}`,
    );
  }
  if (present.length === 0) {
    warn('No agent history was found on this machine.');
    return { uploaded: 0, id };
  }
  log(
    colour.grey(
      `  ${present.length} agents, ${allFiles.length} files, ${formatBytes(totalBytes)} on disk`,
    ),
  );
  log();

  // ---------------------------------------------------------- 2. changes
  const { selected, removed, skipped } = selectChanged(allFiles, state, config);
  log(
    `${colour.cyan('›')} ${selected.length} new or changed, ` +
      `${skipped.unchanged} unchanged, ${skipped.heavyWait} large files waiting, ` +
      `${removed.length} gone from disk`,
  );

  if (selected.length === 0) {
    ok('Everything is already in the bucket. Nothing to send.');
    state.lastRunAt = new Date().toISOString();
    saveState(config, state);
    return { uploaded: 0, id };
  }

  if (options.dryRun) {
    log();
    for (const file of selected.slice(0, 40)) {
      log(colour.grey(`  would send  ${file.key}  ${formatBytes(file.size)}`));
    }
    if (selected.length > 40) log(colour.grey(`  … and ${selected.length - 40} more`));
    ok(`Dry run. ${selected.length} files, ${formatBytes(selected.reduce((s, f) => s + f.size, 0))}.`);
    return { uploaded: 0, id, dryRun: true };
  }

  // ----------------------------------------------------------- 3. bundle
  const workDir = workDirFor(id);
  const bar = progress();
  let packed = 0;
  step('Packing…');
  const { parts, entries } = await buildParts({
    files: selected,
    runId: id,
    config,
    workDir,
    header: {
      tool: 'sessionvault',
      runId: id,
      machine: machineInfo(config),
      startedAt: new Date(started).toISOString(),
      encrypted: Boolean(config.encrypt),
    },
    onProgress: (event) => {
      if (event.type === 'file') {
        packed += 1;
        bar.update(`  packing ${packed}/${selected.length}  ${event.key.slice(-60)}`);
      } else if (event.type === 'error') {
        bar.clear();
        warn(`skipped ${event.key}: ${event.message}`);
      }
    },
  });
  bar.clear();

  if (parts.length === 0) {
    warn('Nothing could be packed.');
    return { uploaded: 0, id };
  }

  const manifest = {
    version: 1,
    runId: id,
    machine: machineInfo(config),
    startedAt: new Date(started).toISOString(),
    agents: present.map((scan) => ({ id: scan.id, name: scan.name, files: scan.files.length })),
    fileCount: entries.length,
    rawBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    removed,
    encrypted: Boolean(config.encrypt),
    parts: [],
    files: entries,
  };

  if (config.encrypt) {
    const passphrase = passphraseFor(config);
    step('Encrypting…');
    for (const part of parts) {
      await encryptFile(part.path, passphrase);
      part.bytes = fs.statSync(part.path).size;
    }
  }

  for (const part of parts) {
    manifest.parts.push({
      index: part.index,
      key: keys.bundle(id, part.index),
      bytes: part.bytes,
      rawBytes: part.rawBytes,
      files: part.files,
      sha256: null,
    });
  }

  const packedBytes = parts.reduce((sum, part) => sum + part.bytes, 0);
  const rawBytes = parts.reduce((sum, part) => sum + part.rawBytes, 0);
  ok(
    `Packed ${entries.length} files into ${parts.length} part${parts.length === 1 ? '' : 's'}: ` +
      `${formatBytes(rawBytes)} → ${formatBytes(packedBytes)}`,
  );

  // ----------------------------------------------------------- 4. upload
  const backend = createBackend(config);
  step(`Uploading to ${backend.describe()}…`);
  try {
    let uploaded = 0;
    for (const part of parts) {
      const key = keys.bundle(id, part.index);
      bar.update(`  uploading part ${part.index}/${parts.length}  ${formatBytes(part.bytes)}`);
      await backend.put(key, part.path, { contentType: 'application/gzip' });
      uploaded += part.bytes;
    }
    bar.clear();

    await backend.putBuffer(keys.manifest(id), Buffer.from(JSON.stringify(manifest)), {
      contentType: 'application/json',
    });
    await backend.putBuffer(
      keys.machine,
      Buffer.from(JSON.stringify({ ...machineInfo(config), updatedAt: new Date().toISOString() }, null, 2)),
      { contentType: 'application/json' },
    );

    // The index lets a restore work without a bucket listing.
    const index = (await readJson(backend, keys.index)) || {
      version: 1,
      machine: config.machine,
      runs: [],
    };
    index.machine = config.machine;
    index.label = machineInfo(config).label;
    index.platform = process.platform;
    index.updatedAt = new Date().toISOString();
    index.runs.push({
      runId: id,
      at: new Date().toISOString(),
      files: entries.length,
      bytes: packedBytes,
      rawBytes,
      parts: manifest.parts.map((part) => part.key),
      encrypted: Boolean(config.encrypt),
    });
    await backend.putBuffer(keys.index, Buffer.from(JSON.stringify(index, null, 2)), {
      contentType: 'application/json',
    });

    // A small registry of every machine that writes to this bucket.
    await updateMachineRegistry(backend, config, keys, index);

    ok(`Uploaded ${formatBytes(uploaded)} in ${parts.length} object${parts.length === 1 ? '' : 's'}.`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  // ------------------------------------------------------------ 5. state
  const now = Date.now();
  for (const file of selected) {
    state.files[file.key] = {
      size: file.size,
      mtimeMs: file.mtimeMs,
      uploadedAt: now,
      runId: id,
    };
  }
  state.runs.push({ runId: id, at: new Date().toISOString(), files: entries.length, bytes: packedBytes });
  state.runs = state.runs.slice(-200);
  state.lastRunAt = new Date().toISOString();
  saveState(config, state);

  log();
  ok(`Backup finished in ${formatDuration(Date.now() - started)}.`);
  return { uploaded: entries.length, id, parts: parts.length, bytes: packedBytes };
}

async function readJson(backend, key) {
  try {
    const buffer = await backend.getBuffer(key);
    return buffer ? JSON.parse(buffer.toString('utf8')) : null;
  } catch {
    return null;
  }
}

async function updateMachineRegistry(backend, config, keys, index) {
  try {
    const registry = (await readJson(backend, keys.registryIndex)) || { version: 1, machines: {} };
    registry.machines[config.machine] = {
      label: index.label,
      platform: index.platform,
      updatedAt: index.updatedAt,
      runs: index.runs.length,
    };
    registry.updatedAt = new Date().toISOString();
    await backend.putBuffer(keys.registryIndex, Buffer.from(JSON.stringify(registry, null, 2)), {
      contentType: 'application/json',
    });
  } catch (error) {
    // The registry is a convenience. A failure here must not fail a backup.
    warn(`could not update the machine registry: ${error.message}`);
  }
}
