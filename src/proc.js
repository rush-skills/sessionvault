// The single place where SessionVault starts another program.
//
// Every call passes the arguments as an array and never uses a shell, so a
// path or a bucket name that contains a space or a quote cannot turn into
// extra shell words.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Run a program and wait for it.
 * Returns { ok, code, stdout, stderr } and never throws for a non-zero exit.
 */
export async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeout ?? 15 * 60 * 1000,
      env: { ...process.env, ...(options.env || {}) },
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
    });
    return { ok: true, code: 0, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error.message ?? error),
    };
  }
}

/** Report whether a program can be started at all. */
export async function exists(command, args = ['--version']) {
  const result = await run(command, args, { timeout: 60_000 });
  return result.ok;
}
