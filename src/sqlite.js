// Copy a live SQLite database safely.
//
// Cursor, Zed, Warp and the VS Code family keep chat history in SQLite. A
// plain file copy of a database that uses a write-ahead log can produce a
// file that is missing the newest data, because that data still sits in the
// -wal sidecar.
//
// Order of preference:
//   1. node:sqlite — built into Node 22.5 and later. `VACUUM INTO` writes a
//      consistent single file while the application keeps running.
//   2. a plain copy of the database together with its -wal and -shm
//      sidecars. SQLite replays the log when it next opens the file, so the
//      copy stays restorable.

import fs from 'node:fs';

let nodeSqlite = null;
let nodeSqliteChecked = false;

async function loadNodeSqlite() {
  if (nodeSqliteChecked) return nodeSqlite;
  nodeSqliteChecked = true;
  try {
    nodeSqlite = await import('node:sqlite');
  } catch {
    nodeSqlite = null; // Node 18 and 20 do not have it
  }
  return nodeSqlite;
}

function quoteForSql(text) {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Write a consistent copy of `source` to `destination`.
 * Returns { method, sidecars }.
 */
export async function copyDatabase(source, destination) {
  fs.rmSync(destination, { force: true });

  const sqlite = await loadNodeSqlite();
  if (sqlite?.DatabaseSync) {
    try {
      const database = new sqlite.DatabaseSync(source, { readOnly: true });
      try {
        database.exec(`VACUUM INTO ${quoteForSql(destination)}`);
        if (fs.existsSync(destination) && fs.statSync(destination).size > 0) {
          return { method: 'vacuum', sidecars: [] };
        }
      } finally {
        database.close();
      }
    } catch {
      fs.rmSync(destination, { force: true });
    }
  }

  // Fallback. Copy the database and whatever sidecars exist beside it.
  fs.copyFileSync(source, destination);
  const sidecars = [];
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(source + suffix)) {
      try {
        fs.copyFileSync(source + suffix, destination + suffix);
        sidecars.push(suffix);
      } catch {
        // The sidecar can vanish between the check and the copy. Ignore it.
      }
    }
  }
  return { method: 'copy', sidecars };
}

/** Report whether a file starts with the SQLite magic string. */
export function isDatabase(filePath) {
  try {
    const handle = fs.openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(16);
      fs.readSync(handle, header, 0, 16, 0);
      return header.toString('utf8', 0, 15) === 'SQLite format 3';
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return false;
  }
}

/** Run an integrity check. `sessionvault doctor` uses this. */
export async function checkDatabase(filePath) {
  const sqlite = await loadNodeSqlite();
  if (!sqlite?.DatabaseSync) return 'skipped (needs Node 22.5+)';
  try {
    const database = new sqlite.DatabaseSync(filePath, { readOnly: true });
    try {
      const row = database.prepare('pragma integrity_check').get();
      return String(Object.values(row)[0]);
    } finally {
      database.close();
    }
  } catch (error) {
    return `error: ${error.message}`;
  }
}
