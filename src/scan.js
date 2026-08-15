// Find the files that belong to each agent and describe them.

import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, GLOBAL_DENY, getAgent } from './registry.js';
import { expandTemplate, expandGlobPath, matchesAny } from './paths.js';

const MAX_WALK_ENTRIES = 400_000; // a guard against a pathological folder

/** Walk a directory and return every file inside it. */
function walk(root, { include, exclude, budget }) {
  const files = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // no permission, or it vanished during the walk
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');

      if (matchesAny(relative, GLOBAL_DENY) || matchesAny(entry.name, GLOBAL_DENY)) continue;
      if (exclude && matchesAny(relative, exclude)) continue;

      if (entry.isSymbolicLink()) continue; // never follow links out of the tree
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (include && !matchesAny(relative, include)) continue;

      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      files.push({ absolute: full, relative, size: stat.size, mtimeMs: stat.mtimeMs });
      budget.count += 1;
      if (budget.count > MAX_WALK_ENTRIES) return files;
    }
  }
  return files;
}

/**
 * Scan one agent.
 * Returns { id, name, found, files: [{ absolute, key, size, mtimeMs, sqlite, heavy }] }
 */
export function scanAgent(agentId, options = {}) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`unknown agent: ${agentId}`);

  const includeConfig = options.includeConfig !== false;
  const files = [];
  const seen = new Set();
  const budget = { count: 0 };

  for (const source of agent.sources) {
    if (source.config && !includeConfig) continue;

    for (const template of expandTemplate(source.path)) {
      for (const resolved of expandGlobPath(template)) {
        let stat;
        try {
          stat = fs.statSync(resolved);
        } catch {
          continue;
        }

        // The archive key keeps the shape of the original path, so an
        // archive stays readable and a restore can rebuild the tree.
        const keyBase = `${agent.id}/${keyForPath(resolved)}`;

        if (stat.isFile()) {
          if (seen.has(resolved)) continue;
          seen.add(resolved);
          files.push({
            absolute: resolved,
            key: keyBase,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            sqlite: Boolean(source.sqlite),
            heavy: Boolean(source.heavy),
            config: Boolean(source.config),
          });
          continue;
        }

        if (!stat.isDirectory()) continue;
        for (const file of walk(resolved, {
          include: source.include,
          exclude: source.exclude,
          budget,
        })) {
          if (seen.has(file.absolute)) continue;
          seen.add(file.absolute);
          const isDatabase = /\.(sqlite3?|db|vscdb)$/i.test(file.absolute);
          files.push({
            absolute: file.absolute,
            key: `${keyBase}/${file.relative}`,
            size: file.size,
            mtimeMs: file.mtimeMs,
            sqlite: Boolean(source.sqlite) || isDatabase,
            heavy: Boolean(source.heavy),
            config: Boolean(source.config),
          });
        }
      }
    }
  }

  return {
    id: agent.id,
    name: agent.name,
    vendor: agent.vendor,
    found: files.length > 0,
    files,
    bytes: files.reduce((total, file) => total + file.size, 0),
  };
}

/**
 * Turn an absolute path into a stable, portable archive key.
 *   /Users/me/.claude/projects      -> home/.claude/projects
 *   C:\Users\me\AppData\Roaming\..  -> home/AppData/Roaming/..
 */
export function keyForPath(absolutePath) {
  const home = homeDir();
  let text = absolutePath;
  if (text.toLowerCase().startsWith(home.toLowerCase())) {
    text = `home${text.slice(home.length)}`;
  }
  return text
    .split(path.sep)
    .join('/')
    .replace(/^\/+/, 'root/')
    .replace(/^([A-Za-z]):\//, 'drive-$1/')
    .replace(/\/+/g, '/');
}

function homeDir() {
  // Read at call time, so a test can change HOME between runs.
  return process.env.SESSIONVAULT_FAKE_HOME || process.env.HOME || process.env.USERPROFILE || '';
}

/** Scan every agent, or the subset named in `only`. */
export function scanAll(options = {}) {
  const only = options.only && options.only.length > 0 ? new Set(options.only) : null;
  const skip = new Set(options.skip || []);
  const results = [];

  for (const agent of AGENTS) {
    if (only && !only.has(agent.id)) continue;
    if (skip.has(agent.id)) continue;
    try {
      results.push(scanAgent(agent.id, options));
    } catch (error) {
      results.push({ id: agent.id, name: agent.name, found: false, files: [], bytes: 0, error: String(error) });
    }
  }
  return results;
}
