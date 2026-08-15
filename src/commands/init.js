// `sessionvault init` — the one-command setup.
//
// It asks a few questions when a terminal is attached, and takes every answer
// from a flag when one is not. It then creates the bucket, writes the config,
// runs the first backup and offers to schedule the next ones.

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  loadConfig,
  saveConfig,
  configExists,
  defaultMachineId,
  machineInfo,
} from '../config.js';
import { configPath } from '../paths.js';
import { createBackend, BACKENDS } from '../backends/index.js';
import { scanAll } from '../scan.js';
import { installSchedule } from '../schedule.js';
import { backup } from './backup.js';
import { colour, formatBytes, log, ok, step, warn } from '../ui.js';

async function ask(rl, question, fallback) {
  if (!rl) return fallback;
  const answer = (await rl.question(`${question} ${colour.grey(`[${fallback}]`)} `)).trim();
  return answer === '' ? fallback : answer;
}

async function confirm(rl, question, fallback = true) {
  if (!rl) return fallback;
  const hint = fallback ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`${question} ${colour.grey(`[${hint}]`)} `)).trim().toLowerCase();
  if (answer === '') return fallback;
  return answer.startsWith('y');
}

export async function init(options = {}) {
  const interactive = stdin.isTTY && !options.yes;
  const rl = interactive ? readline.createInterface({ input: stdin, output: stdout }) : null;

  try {
    log(colour.bold('SessionVault setup'));
    log(colour.grey('Back up the session history of every AI agent on this machine.'));
    log();

    if (configExists() && !options.force) {
      warn(`A config already exists at ${configPath()}`);
      const overwrite = await confirm(rl, 'Change it?', false);
      if (!overwrite) {
        log('Nothing was changed.');
        return { changed: false };
      }
    }

    // ------------------------------------------------------ what is here
    step('Looking for agents…');
    const scans = scanAll({});
    const found = scans.filter((scan) => scan.found);
    for (const scan of found.sort((a, b) => b.bytes - a.bytes)) {
      log(
        `  ${colour.green('•')} ${scan.name.padEnd(28)} ${String(scan.files.length).padStart(6)} files  ${formatBytes(scan.bytes).padStart(8)}`,
      );
    }
    const totalBytes = found.reduce((sum, scan) => sum + scan.bytes, 0);
    log(colour.grey(`  ${found.length} agents, ${formatBytes(totalBytes)} on disk`));
    log();

    // --------------------------------------------------------- questions
    const current = loadConfig();
    const backend = options.backend || (await ask(rl, `Backend (${BACKENDS.join('/')})?`, current.backend));
    const bucket = options.bucket || (await ask(rl, 'R2 bucket name?', current.bucket));
    const prefix = options.prefix || (await ask(rl, 'Prefix inside the bucket?', current.prefix));
    const machine = options.machine || (await ask(rl, 'Name for this machine?', current.machine || defaultMachineId()));

    let encrypt = options.encrypt ?? current.encrypt;
    if (options.encrypt === undefined && rl) {
      log();
      log(
        colour.grey(
          '  A transcript can hold a secret that you pasted into a chat.\n' +
            '  Client-side encryption protects the archive if the bucket leaks.\n' +
            '  You must keep the passphrase. Without it the archive is lost.',
        ),
      );
      encrypt = await confirm(rl, 'Encrypt every bundle before upload?', false);
    }

    const config = {
      ...current,
      backend,
      bucket,
      prefix,
      machine,
      encrypt: Boolean(encrypt),
      machineLabel: current.machineLabel || machineInfo(current).label,
    };

    if (backend === 's3') {
      config.accountId = options.accountId || (await ask(rl, 'Cloudflare account id?', current.accountId || ''));
      config.accessKeyId = options.accessKeyId || (await ask(rl, 'R2 access key id (blank to use R2_ACCESS_KEY_ID)?', ''));
      config.secretAccessKey =
        options.secretAccessKey || (await ask(rl, 'R2 secret access key (blank to use the env var)?', ''));
    }
    if (backend === 'local') {
      config.localRoot = options.localRoot || (await ask(rl, 'Folder for the archive?', current.localRoot || ''));
    }

    if (config.encrypt && !process.env[config.passphraseEnv]) {
      warn(
        `Encryption is on. Set ${config.passphraseEnv} in your shell profile before the next backup.`,
      );
    }

    // ---------------------------------------------------------- the work
    log();
    step('Preparing the bucket…');
    const target = createBackend(config);
    const result = await target.ensureBucket();
    ok(result.created ? `Created ${target.describe()}` : `Using ${target.describe()}`);

    const file = saveConfig(config);
    ok(`Wrote ${file}`);

    const runNow = options.backup ?? (await confirm(rl, 'Run the first backup now?', true));
    if (runNow) {
      log();
      await backup({});
    }

    const schedule = options.schedule ?? (await confirm(rl, 'Repeat the backup automatically?', true));
    if (schedule) {
      const minutes = Number(options.intervalMinutes || (await ask(rl, 'How many minutes between runs?', '120')));
      await installSchedule({ intervalMinutes: Number.isFinite(minutes) ? minutes : 120 });
    }

    log();
    ok('SessionVault is ready.');
    log();
    log(colour.bold('On another machine'));
    log('  npm install -g sessionvault');
    log('  wrangler login');
    log(`  sessionvault init --bucket ${config.bucket} --prefix ${config.prefix} --yes`);
    log(colour.grey('  The machine gets its own name, so the archives never collide.'));
    return { changed: true, config };
  } finally {
    rl?.close();
  }
}
