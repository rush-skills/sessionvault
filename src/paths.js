// Platform paths and a small glob matcher.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();
export const PLATFORM = process.platform; // 'darwin' | 'linux' | 'win32'

function firstEnv(...names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return null;
}

/** The roots that a registry path template can refer to. */
export function roots() {
  if (PLATFORM === 'darwin') {
    const appSupport = path.join(HOME, 'Library', 'Application Support');
    return {
      home: HOME,
      config: firstEnv('XDG_CONFIG_HOME') || path.join(HOME, '.config'),
      data: firstEnv('XDG_DATA_HOME') || path.join(HOME, '.local', 'share'),
      appSupport,
      cache: path.join(HOME, 'Library', 'Caches'),
      // macOS apps usually use Application Support for both config and data.
      appConfig: appSupport,
      appData: appSupport,
    };
  }
  if (PLATFORM === 'win32') {
    const appData = firstEnv('APPDATA') || path.join(HOME, 'AppData', 'Roaming');
    const localAppData = firstEnv('LOCALAPPDATA') || path.join(HOME, 'AppData', 'Local');
    return {
      home: HOME,
      config: appData,
      data: localAppData,
      appSupport: appData,
      cache: path.join(localAppData, 'Temp'),
      appConfig: appData,
      appData: localAppData,
    };
  }
  return {
    home: HOME,
    config: firstEnv('XDG_CONFIG_HOME') || path.join(HOME, '.config'),
    data: firstEnv('XDG_DATA_HOME') || path.join(HOME, '.local', 'share'),
    appSupport: firstEnv('XDG_CONFIG_HOME') || path.join(HOME, '.config'),
    cache: firstEnv('XDG_CACHE_HOME') || path.join(HOME, '.cache'),
    appConfig: firstEnv('XDG_CONFIG_HOME') || path.join(HOME, '.config'),
    appData: firstEnv('XDG_DATA_HOME') || path.join(HOME, '.local', 'share'),
  };
}

/**
 * Turn a registry template into an absolute path.
 * On macOS a `{config}` template also tries Application Support, because
 * some tools follow XDG there and others do not.
 */
export function expandTemplate(template) {
  const r = roots();
  const candidates = new Set();
  const replace = (text) =>
    text
      .replace(/^~(?=[/\\]|$)/, r.home)
      .replace('{home}', r.home)
      .replace('{config}', r.config)
      .replace('{data}', r.data)
      .replace('{appSupport}', r.appSupport)
      .replace('{cache}', r.cache);

  candidates.add(path.normalize(replace(template)));

  if (PLATFORM === 'darwin') {
    // Try the Apple location too, so `{config}/goose` also finds
    // ~/Library/Application Support/goose.
    if (template.includes('{config}') || template.includes('{data}')) {
      candidates.add(
        path.normalize(
          template
            .replace(/^~(?=[/\\]|$)/, r.home)
            .replace('{config}', r.appSupport)
            .replace('{data}', r.appSupport)
            .replace('{appSupport}', r.appSupport)
            .replace('{cache}', r.cache),
        ),
      );
    }
  }
  return [...candidates];
}

/** Convert a glob to a regular expression. Supports `*`, `**` and `?`. */
export function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches any number of directories, including none.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(relativePath, patterns) {
  if (!patterns || patterns.length === 0) return false;
  const subject = relativePath.split(path.sep).join('/');
  return patterns.some((pattern) => globToRegExp(pattern).test(subject));
}

/**
 * Expand a path that contains glob segments into the real paths that exist.
 * Only the segments with `*` are searched, so this stays cheap.
 */
export function expandGlobPath(absolutePath) {
  if (!absolutePath.includes('*')) {
    return fs.existsSync(absolutePath) ? [absolutePath] : [];
  }
  const parts = absolutePath.split(path.sep);
  let results = [parts[0] === '' ? path.sep : parts[0]];

  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part.includes('*')) {
      results = results.map((base) => path.join(base, part));
      continue;
    }
    const matcher = globToRegExp(part);
    const next = [];
    for (const base of results) {
      let entries;
      try {
        entries = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (matcher.test(entry.name)) next.push(path.join(base, entry.name));
      }
    }
    results = next;
    if (results.length === 0) return [];
  }
  return results.filter((candidate) => fs.existsSync(candidate));
}

/** Where SessionVault keeps its own files. */
export function stateDir() {
  if (process.env.SESSIONVAULT_HOME) return process.env.SESSIONVAULT_HOME;
  const r = roots();
  return path.join(r.config, 'sessionvault');
}

export function configPath() {
  return path.join(stateDir(), 'config.json');
}
