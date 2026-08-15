// The read-only commands: agents, status, machines, doctor.

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadState, machineInfo, remoteKeys } from '../config.js';
import { configPath } from '../paths.js';
import { createBackend } from '../backends/index.js';
import { AGENTS } from '../registry.js';
import { scanAll } from '../scan.js';
import { checkDatabase } from '../sqlite.js';
import { colour, formatBytes, formatTime, log, ok, step, table, warn } from '../ui.js';

/** `sessionvault agents` — what is installed, and what would be archived. */
export async function agents(options = {}) {
  const config = loadConfig(options.configOverrides);
  const scans = scanAll({ skip: config.skipAgents, includeConfig: config.includeConfig });
  const found = scans.filter((scan) => scan.found);
  const missing = scans.filter((scan) => !scan.found);

  log(colour.bold('Agents found on this machine'));
  log();
  log(
    table(
      found
        .sort((a, b) => b.bytes - a.bytes)
        .map((scan) => [scan.id, scan.name, String(scan.files.length), formatBytes(scan.bytes)]),
      ['id', 'name', 'files', 'size'],
    ),
  );
  log();
  log(
    colour.grey(
      `${found.length} of ${scans.length} known agents are present. ` +
        `${found.reduce((sum, scan) => sum + scan.files.length, 0)} files, ` +
        `${formatBytes(found.reduce((sum, scan) => sum + scan.bytes, 0))}.`,
    ),
  );

  if (options.all) {
    log();
    log(colour.bold('Not present'));
    log(colour.grey(missing.map((scan) => scan.id).join(', ')));
  }
  return { found, missing };
}

/** `sessionvault status` — local state and what the bucket holds. */
export async function status(options = {}) {
  const config = loadConfig(options.configOverrides);
  const state = loadState(config);
  const info = machineInfo(config);

  log(colour.bold('SessionVault status'));
  log();
  log(`  config     ${configPath()}${fs.existsSync(configPath()) ? '' : colour.yellow('  (not created yet — run `sessionvault init`)')}`);
  log(`  machine    ${info.id}  ${colour.grey(`(${info.label}, ${info.platform})`)}`);
  log(`  backend    ${config.backend}`);
  log(`  bucket     ${config.bucket}`);
  log(`  prefix     ${config.prefix}`);
  log(`  encryption ${config.encrypt ? colour.green('on') : colour.grey('off')}`);
  log(`  last run   ${formatTime(state.lastRunAt)}`);
  log(`  tracked    ${Object.keys(state.files).length} files`);

  if (options.remote === false) return { config, state };

  try {
    const backend = createBackend(config);
    const keys = remoteKeys(config);
    const buffer = await backend.getBuffer(keys.index);
    if (!buffer) {
      log();
      warn('The bucket holds no index for this machine yet.');
      return { config, state };
    }
    const index = JSON.parse(buffer.toString('utf8'));
    const bytes = index.runs.reduce((sum, run) => sum + (run.bytes || 0), 0);
    log();
    log(colour.bold('In the bucket'));
    log(`  runs       ${index.runs.length}`);
    log(`  stored     ${formatBytes(bytes)}`);
    log(`  newest     ${formatTime(index.runs.at(-1)?.at)}`);
    log();
    log(
      table(
        index.runs.slice(-8).reverse().map((run) => [
          run.runId,
          formatTime(run.at),
          String(run.files),
          formatBytes(run.bytes || 0),
        ]),
        ['run', 'when', 'files', 'size'],
      ),
    );
  } catch (error) {
    log();
    warn(`could not read the bucket: ${error.message}`);
  }
  return { config, state };
}

/** `sessionvault machines` — every machine that writes to this bucket. */
export async function machines(options = {}) {
  const config = loadConfig(options.configOverrides);
  const backend = createBackend(config);
  const keys = remoteKeys(config);

  const buffer = await backend.getBuffer(keys.registryIndex);
  if (!buffer) {
    warn('No machine registry was found. Run a backup first.');
    return [];
  }
  const registry = JSON.parse(buffer.toString('utf8'));
  const rows = Object.entries(registry.machines || {}).map(([id, entry]) => [
    id === config.machine ? `${id} ${colour.green('(this one)')}` : id,
    entry.label || '',
    entry.platform || '',
    String(entry.runs ?? ''),
    formatTime(entry.updatedAt),
  ]);

  log(colour.bold(`Machines in ${config.bucket}/${config.prefix}`));
  log();
  log(table(rows, ['machine', 'label', 'platform', 'runs', 'last backup']));
  return rows;
}

/** `sessionvault doctor` — check the setup before you trust it. */
export async function doctor(options = {}) {
  const config = loadConfig(options.configOverrides);
  const problems = [];

  log(colour.bold('SessionVault doctor'));
  log();

  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  const hasNodeSqlite = major > 22 || (major === 22 && minor >= 5);
  log(`  node             ${process.version} ${hasNodeSqlite ? colour.green('(sqlite built in)') : colour.yellow('(no node:sqlite — databases are copied with sidecars)')}`);

  log(`  config file      ${fs.existsSync(configPath()) ? colour.green('present') : colour.yellow('missing')}`);

  step('Checking the backend…');
  try {
    const backend = createBackend(config);
    log(`  backend          ${backend.describe()}`);
    const probeKey = `${config.prefix}/.sessionvault-probe-${Date.now()}`;
    await backend.putBuffer(probeKey, Buffer.from('ok'), { contentType: 'text/plain' });
    const back = await backend.getBuffer(probeKey);
    if (back?.toString() !== 'ok') problems.push('the object came back with different content');
    await backend.delete(probeKey);
    ok('write, read and delete all work');
  } catch (error) {
    problems.push(`backend: ${error.message}`);
    warn(error.message);
  }

  step('Checking the agent scan…');
  const scans = scanAll({ skip: config.skipAgents, includeConfig: config.includeConfig });
  const found = scans.filter((scan) => scan.found);
  log(`  agents present   ${found.length}`);
  const databases = found.flatMap((scan) => scan.files.filter((file) => file.sqlite)).slice(0, 5);
  for (const database of databases) {
    const verdict = await checkDatabase(database.absolute);
    const good = verdict === 'ok' || verdict.startsWith('skipped');
    log(`  db ${path.basename(database.absolute).padEnd(16)} ${good ? colour.green(verdict) : colour.red(verdict)}`);
    if (!good) problems.push(`${database.absolute}: ${verdict}`);
  }

  log();
  if (problems.length === 0) {
    ok('No problem was found.');
  } else {
    for (const problem of problems) warn(problem);
  }
  return problems;
}

/** `sessionvault list-agents` — the full registry, present or not. */
export function listKnownAgents() {
  log(colour.bold(`SessionVault knows ${AGENTS.length} agents`));
  log();
  log(
    table(
      AGENTS.map((agent) => [agent.id, agent.name, agent.vendor || '', agent.kind]),
      ['id', 'name', 'vendor', 'kind'],
    ),
  );
}
