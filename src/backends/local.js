// The local backend. It writes the same object layout to a folder.
//
// Use it for a test, for an external disk, or for a network share. The layout
// matches the R2 layout exactly, so you can copy a folder into a bucket later
// with `rclone copy` and every command still works.

import fs from 'node:fs';
import path from 'node:path';

export class LocalBackend {
  constructor(config) {
    this.root = path.resolve(config.localRoot || config.root);
    this.bucket = path.basename(this.root);
  }

  describe() {
    return `local folder (${this.root})`;
  }

  supportsList() {
    return true;
  }

  #resolve(key) {
    const target = path.join(this.root, key);
    const relative = path.relative(this.root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`the key escapes the archive root: ${key}`);
    }
    return target;
  }

  async ensureBucket() {
    const existed = fs.existsSync(this.root);
    fs.mkdirSync(this.root, { recursive: true });
    return { created: !existed };
  }

  async put(key, filePath) {
    const target = this.#resolve(key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(filePath, target);
    return true;
  }

  async putBuffer(key, buffer) {
    const target = this.#resolve(key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
    return true;
  }

  async get(key, destination) {
    const source = this.#resolve(key);
    if (!fs.existsSync(source)) return false;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    return true;
  }

  async getBuffer(key) {
    const source = this.#resolve(key);
    return fs.existsSync(source) ? fs.readFileSync(source) : null;
  }

  async delete(key) {
    fs.rmSync(this.#resolve(key), { force: true });
    return true;
  }

  async list(prefix = '') {
    const objects = [];
    const walk = (directory) => {
      let entries;
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const key = path.relative(this.root, full).split(path.sep).join('/');
          if (key.startsWith(prefix)) {
            objects.push({ key, size: fs.statSync(full).size });
          }
        }
      }
    };
    walk(this.root);
    return objects;
  }
}
