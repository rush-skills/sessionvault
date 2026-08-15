// The Wrangler backend.
//
// It reuses the Cloudflare login that Wrangler already holds, so a second
// machine needs no keys at all: run `wrangler login` once and back up.
//
// Wrangler can put, get and delete a single R2 object. It cannot list a
// bucket. SessionVault therefore keeps its own index object per machine,
// which also makes a restore cheaper.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../proc.js';

const WRANGLER_PACKAGE = 'wrangler@4';

export class WranglerBackend {
  constructor(config) {
    this.bucket = config.bucket;
    this.remoteFlag = config.wranglerRemoteFlag !== false;
    this.command = null;
    this.jurisdiction = config.jurisdiction || null;
  }

  describe() {
    return `wrangler r2 (bucket ${this.bucket})`;
  }

  /** Find a runnable Wrangler: an explicit path, one on PATH, or npx. */
  async resolve() {
    if (this.command) return this.command;

    const candidates = [];
    if (process.env.SESSIONVAULT_WRANGLER) {
      candidates.push({ command: process.env.SESSIONVAULT_WRANGLER, prefix: [] });
    }
    candidates.push({ command: 'wrangler', prefix: [] });
    candidates.push({ command: 'npx', prefix: ['--yes', WRANGLER_PACKAGE] });

    for (const candidate of candidates) {
      const result = await run(candidate.command, [...candidate.prefix, '--version'], {
        timeout: 180_000,
      });
      if (result.ok) {
        this.command = candidate;
        return candidate;
      }
    }
    throw new Error(
      'Wrangler was not found. Install it with `npm install -g wrangler`, ' +
        'or set SESSIONVAULT_WRANGLER to its path.',
    );
  }

  async #r2(args, options = {}) {
    const { command, prefix } = await this.resolve();
    const full = [...prefix, 'r2', 'object', ...args];
    if (this.remoteFlag) full.push('--remote');
    if (this.jurisdiction) full.push('--jurisdiction', this.jurisdiction);
    return run(command, full, options);
  }

  async whoami() {
    const { command, prefix } = await this.resolve();
    const result = await run(command, [...prefix, 'whoami'], { timeout: 180_000 });
    return result.stdout || result.stderr;
  }

  async ensureBucket() {
    const { command, prefix } = await this.resolve();
    const list = await run(command, [...prefix, 'r2', 'bucket', 'list'], { timeout: 180_000 });
    if (list.ok && new RegExp(`name:\\s+${escapeRegExp(this.bucket)}\\b`).test(list.stdout)) {
      return { created: false };
    }
    const create = await run(command, [...prefix, 'r2', 'bucket', 'create', this.bucket], {
      timeout: 180_000,
    });
    if (!create.ok && !/already (exists|owned)/i.test(create.stderr)) {
      throw new Error(`could not create the bucket ${this.bucket}: ${create.stderr.trim()}`);
    }
    return { created: true };
  }

  async put(key, filePath, options = {}) {
    const result = await this.#r2([
      'put',
      `${this.bucket}/${key}`,
      '--file',
      filePath,
      '--content-type',
      options.contentType || 'application/octet-stream',
      '--force',
    ]);
    if (!result.ok) throw new Error(`upload failed for ${key}: ${tail(result.stderr)}`);
    return true;
  }

  async putBuffer(key, buffer, options = {}) {
    const temporary = path.join(os.tmpdir(), `sv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(temporary, buffer);
    try {
      return await this.put(key, temporary, options);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  async get(key, destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const result = await this.#r2(['get', `${this.bucket}/${key}`, '--file', destination]);
    if (!result.ok) {
      fs.rmSync(destination, { force: true });
      if (/not found|does not exist|404/i.test(result.stderr)) return false;
      throw new Error(`download failed for ${key}: ${tail(result.stderr)}`);
    }
    return fs.existsSync(destination);
  }

  async getBuffer(key) {
    const temporary = path.join(os.tmpdir(), `sv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ok = await this.get(key, temporary);
      return ok ? fs.readFileSync(temporary) : null;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  async delete(key) {
    const result = await this.#r2(['delete', `${this.bucket}/${key}`], {});
    return result.ok;
  }

  // Wrangler has no list command. SessionVault reads its own index instead.
  supportsList() {
    return false;
  }

  async list() {
    throw new Error(
      'The wrangler backend cannot list a bucket. ' +
        'Use the index, or switch to the s3 backend for a full listing.',
    );
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tail(text, lines = 4) {
  return String(text || '')
    .trim()
    .split('\n')
    .slice(-lines)
    .join('\n');
}
