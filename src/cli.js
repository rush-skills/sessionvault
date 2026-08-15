// Argument parsing and the command table.

import { backup } from './commands/backup.js';
import { restore } from './commands/restore.js';
import { init } from './commands/init.js';
import { agents, status, machines, doctor, listKnownAgents } from './commands/info.js';
import { installSchedule, removeSchedule, scheduleStatus } from './schedule.js';
import { loadConfig, saveConfig } from './config.js';
import { configPath } from './paths.js';
import { AGENTS } from './registry.js';
import { colour, log, fail, ok } from './ui.js';

const VERSION = '0.1.0';

const HELP = `${colour.bold('sessionvault')} — back up the history of every AI agent on your machine

${colour.bold('USAGE')}
  sessionvault <command> [options]

${colour.bold('COMMANDS')}
  init              Set everything up: bucket, config, first backup, schedule
  backup            Send new and changed history to the bucket
  status            Show the local state and what the bucket holds
  agents            List the agents found on this machine
  known             List every agent SessionVault can find
  machines          List every machine that writes to this bucket
  restore           Rebuild an archive into a folder
  schedule          Manage the repeating backup
  doctor            Check that the setup works
  config            Show or change the config

${colour.bold('COMMON OPTIONS')}
  --bucket <name>       R2 bucket to use
  --prefix <path>       Prefix inside the bucket
  --backend <kind>      wrangler | s3 | local
  --machine <id>        Name for this machine
  --only <id,id>        Limit the run to these agents
  --dry-run             Show what would be sent, send nothing
  --full                Ignore the local state and send everything again
  --yes                 Never ask a question
  --quiet               Print less
  --json                Print machine-readable output where it applies
  -h, --help            Show this help
  -v, --version         Show the version

${colour.bold('EXAMPLES')}
  sessionvault init                       ${colour.grey('# guided setup')}
  sessionvault backup                     ${colour.grey('# send what changed')}
  sessionvault backup --only claude-code  ${colour.grey('# one agent')}
  sessionvault restore --to ./archive     ${colour.grey('# rebuild this machine')}
  sessionvault restore --machine laptop-a1b2c3 --to ./other
  sessionvault schedule install --every 60
`;

export function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=');
      const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (inline !== undefined) {
        args.flags[key] = inline;
      } else if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        args.flags[key] = argv[i + 1];
        i += 1;
      } else {
        args.flags[key] = true;
      }
    } else if (token.startsWith('-') && token.length > 1) {
      for (const letter of token.slice(1)) args.flags[letter] = true;
    } else {
      args._.push(token);
    }
  }
  return args;
}

/**
 * Read a flag as a boolean.
 * Understands `--flag`, `--flag=false`, `--flag no` and `--no-flag`.
 * Returns undefined when the user did not mention the flag at all.
 */
function bool(flags, name) {
  const negative = `no${name[0].toUpperCase()}${name.slice(1)}`;
  if (flags[negative] !== undefined) return false;
  const value = flags[name];
  if (value === undefined) return undefined;
  if (value === true) return true;
  return !['false', 'no', '0', 'off'].includes(String(value).toLowerCase());
}

function listOf(value) {
  if (!value || value === true) return undefined;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function overridesFrom(flags) {
  const overrides = {};
  if (flags.bucket && flags.bucket !== true) overrides.bucket = String(flags.bucket);
  if (flags.prefix && flags.prefix !== true) overrides.prefix = String(flags.prefix);
  if (flags.backend && flags.backend !== true) overrides.backend = String(flags.backend);
  if (flags.machine && flags.machine !== true) overrides.machine = String(flags.machine);
  if (flags.localRoot && flags.localRoot !== true) overrides.localRoot = String(flags.localRoot);
  return overrides;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  const flags = args.flags;

  if (flags.v || flags.version) {
    log(VERSION);
    return 0;
  }
  if (!command || flags.h || flags.help || command === 'help') {
    log(HELP);
    return 0;
  }

  const configOverrides = overridesFrom(flags);
  const unknownAgents = (listOf(flags.only) || []).filter(
    (id) => !AGENTS.some((agent) => agent.id === id),
  );
  if (unknownAgents.length > 0) {
    fail(`unknown agent id: ${unknownAgents.join(', ')}`);
    log(colour.grey('Run `sessionvault known` to see every id.'));
    return 2;
  }

  switch (command) {
    case 'init':
      await init({
        configOverrides,
        yes: Boolean(bool(flags, 'yes')),
        force: Boolean(bool(flags, 'force')),
        bucket: flags.bucket !== true ? flags.bucket : undefined,
        prefix: flags.prefix !== true ? flags.prefix : undefined,
        backend: flags.backend !== true ? flags.backend : undefined,
        machine: flags.machine !== true ? flags.machine : undefined,
        localRoot: flags.localRoot !== true ? flags.localRoot : undefined,
        accountId: flags.accountId !== true ? flags.accountId : undefined,
        encrypt: bool(flags, 'encrypt'),
        backup: bool(flags, 'backup'),
        schedule: bool(flags, 'schedule'),
        intervalMinutes: flags.every !== true ? flags.every : undefined,
      });
      return 0;

    case 'backup':
      await backup({
        configOverrides,
        only: listOf(flags.only),
        dryRun: Boolean(bool(flags, 'dryRun') || flags.n),
        full: Boolean(bool(flags, 'full')),
        quiet: Boolean(bool(flags, 'quiet')),
      });
      return 0;

    case 'restore':
      await restore({
        configOverrides,
        machine: flags.machine !== true ? flags.machine : undefined,
        to: flags.to !== true ? flags.to : undefined,
        at: flags.at !== true ? flags.at : undefined,
        runId: flags.run !== true ? flags.run : undefined,
      });
      return 0;

    case 'status':
      await status({ configOverrides, remote: flags.local ? false : true });
      return 0;

    case 'agents':
      await agents({ configOverrides, all: Boolean(flags.all) });
      return 0;

    case 'known':
      listKnownAgents();
      return 0;

    case 'machines':
      await machines({ configOverrides });
      return 0;

    case 'doctor':
      return (await doctor({ configOverrides })).length === 0 ? 0 : 1;

    case 'schedule': {
      const action = args._[1] || 'status';
      if (action === 'install') {
        await installSchedule({ intervalMinutes: Number(flags.every) || 120 });
      } else if (action === 'remove' || action === 'uninstall') {
        await removeSchedule();
      } else {
        log(`schedule: ${await scheduleStatus()}`);
      }
      return 0;
    }

    case 'config': {
      const config = loadConfig(configOverrides);
      if (args._[1] === 'set') {
        const [key, ...rest] = args._.slice(2);
        const value = rest.join(' ');
        if (!key) {
          fail('usage: sessionvault config set <key> <value>');
          return 2;
        }
        config[key] = value === 'true' ? true : value === 'false' ? false : /^\d+$/.test(value) ? Number(value) : value;
        saveConfig(config);
        ok(`${key} = ${config[key]}`);
        return 0;
      }
      if (args._[1] === 'path') {
        log(configPath());
        return 0;
      }
      const shown = { ...config };
      if (shown.secretAccessKey) shown.secretAccessKey = '***';
      log(JSON.stringify(shown, null, 2));
      return 0;
    }

    default:
      fail(`unknown command: ${command}`);
      log(HELP);
      return 2;
  }
}
