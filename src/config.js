// Configuration, machine identity and the local state file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateDir, configPath } from './paths.js';

export const DEFAULT_CONFIG = {
  version: 1,
  backend: 'wrangler', // wrangler | s3 | local
  bucket: 'ai-sessions',
  prefix: 'sessionvault/v1',
  machine: null, // filled in by init
  machineLabel: null,
  agents: null, // null means every agent that is present
  skipAgents: [],
  includeConfig: true,
  maxBundleMB: 240, // stay under the single-object limit of wrangler
  heavyIntervalHours: 24, // how often a large, always-changing file is sent
  maxFileMB: 2048,
  encrypt: false,
  passphraseEnv: 'SESSIONVAULT_PASSPHRASE',
  accountId: null,
  endpoint: null,
  accessKeyId: null,
  secretAccessKey: null,
  localRoot: null,
};

export function loadConfig(overrides = {}) {
  let stored = {};
  const file = configPath();
  if (fs.existsSync(file)) {
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`the config file is not valid JSON: ${file}\n${error.message}`);
    }
  }

  const fromEnvironment = {};
  if (process.env.SESSIONVAULT_BUCKET) fromEnvironment.bucket = process.env.SESSIONVAULT_BUCKET;
  if (process.env.SESSIONVAULT_PREFIX) fromEnvironment.prefix = process.env.SESSIONVAULT_PREFIX;
  if (process.env.SESSIONVAULT_BACKEND) fromEnvironment.backend = process.env.SESSIONVAULT_BACKEND;
  if (process.env.SESSIONVAULT_MACHINE) fromEnvironment.machine = process.env.SESSIONVAULT_MACHINE;
  if (process.env.CLOUDFLARE_ACCOUNT_ID) fromEnvironment.accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  const config = { ...DEFAULT_CONFIG, ...stored, ...fromEnvironment, ...overrides };
  if (!config.machine) config.machine = defaultMachineId();
  return config;
}

export function saveConfig(config) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const toStore = { ...config };
  // Never write an empty secret into the file.
  for (const key of ['accessKeyId', 'secretAccessKey']) {
    if (!toStore[key]) delete toStore[key];
  }
  fs.writeFileSync(file, `${JSON.stringify(toStore, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function configExists() {
  return fs.existsSync(configPath());
}

/**
 * A stable, readable machine name: the hostname, cleaned up, plus a short
 * hash of the hostname and the user name. Two machines that share a hostname
 * still get different ids, and the id never changes on one machine.
 */
export function defaultMachineId() {
  const host = os.hostname().replace(/\.local$/i, '');
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'machine';
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${os.hostname()}|${os.userInfo().username}|${os.platform()}`)
    .digest('hex')
    .slice(0, 6);
  return `${slug}-${fingerprint}`;
}

export function machineInfo(config) {
  return {
    id: config.machine,
    label: config.machineLabel || os.hostname(),
    hostname: os.hostname(),
    platform: process.platform,
    release: os.release(),
    arch: os.arch(),
    user: os.userInfo().username,
    node: process.version,
  };
}

// ------------------------------------------------------------------ state

export function statePath(config) {
  return path.join(stateDir(), 'state', `${config.machine}.json`);
}

export function loadState(config) {
  const file = statePath(config);
  if (!fs.existsSync(file)) return { version: 1, files: {}, runs: [], lastRunAt: null };
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.files ||= {};
    state.runs ||= [];
    return state;
  } catch {
    return { version: 1, files: {}, runs: [], lastRunAt: null };
  }
}

export function saveState(config, state) {
  const file = statePath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state));
  fs.renameSync(temporary, file); // an atomic replace, so a crash cannot truncate it
  return file;
}

export function remoteKeys(config) {
  const base = `${config.prefix}/machines/${config.machine}`;
  return {
    base,
    index: `${base}/index.json`,
    machine: `${base}/machine.json`,
    manifest: (runId) => `${base}/manifests/${runId}.json`,
    bundle: (runId, part) => `${base}/bundles/${runId}.part${String(part).padStart(3, '0')}.tar.gz`,
    registryIndex: `${config.prefix}/machines.json`,
  };
}
