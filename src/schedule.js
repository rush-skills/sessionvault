// Install a repeating backup on macOS, Linux and Windows.
//
//   macOS    a launchd user agent            ~/Library/LaunchAgents
//   Linux    a systemd user service + timer  ~/.config/systemd/user
//   Windows  a Scheduled Task                schtasks
//
// Every platform runs the same command: the SessionVault binary with the
// `backup` argument.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './proc.js';
import { stateDir } from './paths.js';
import { colour, log, ok, warn } from './ui.js';

const LABEL = 'dev.sessionvault.backup';

function entryPoint() {
  // The path to bin/sessionvault.js inside this package.
  return path.resolve(fileURLToPath(new URL('../bin/sessionvault.js', import.meta.url)));
}

function logDir() {
  const directory = path.join(stateDir(), 'logs');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

// ------------------------------------------------------------------ macOS

function launchAgentPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function launchAgentPlist(intervalMinutes) {
  const logs = logDir();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${entryPoint()}</string>
        <string>backup</string>
        <string>--quiet</string>
    </array>
    <key>StartInterval</key><integer>${intervalMinutes * 60}</integer>
    <key>RunAtLoad</key><true/>
    <key>LowPriorityIO</key><true/>
    <key>Nice</key><integer>5</integer>
    <key>StandardOutPath</key><string>${path.join(logs, 'backup.out.log')}</string>
    <key>StandardErrorPath</key><string>${path.join(logs, 'backup.err.log')}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>${process.env.PATH || '/usr/bin:/bin:/usr/local/bin'}</string>
    </dict>
</dict>
</plist>
`;
}

async function installLaunchd(intervalMinutes) {
  const target = launchAgentPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, launchAgentPlist(intervalMinutes));

  const uid = process.getuid();
  await run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]); // ignore a failure
  const result = await run('launchctl', ['bootstrap', `gui/${uid}`, target]);
  if (!result.ok) throw new Error(`launchctl bootstrap failed: ${result.stderr.trim()}`);
  return target;
}

async function removeLaunchd() {
  const uid = process.getuid();
  await run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
  fs.rmSync(launchAgentPath(), { force: true });
}

// ------------------------------------------------------------------ Linux

function systemdDir() {
  return path.join(os.homedir(), '.config', 'systemd', 'user');
}

async function installSystemd(intervalMinutes) {
  const directory = systemdDir();
  fs.mkdirSync(directory, { recursive: true });
  const logs = logDir();

  fs.writeFileSync(
    path.join(directory, 'sessionvault.service'),
    `[Unit]
Description=SessionVault backup of AI agent history

[Service]
Type=oneshot
Nice=5
IOSchedulingClass=idle
ExecStart=${process.execPath} ${entryPoint()} backup --quiet
StandardOutput=append:${path.join(logs, 'backup.out.log')}
StandardError=append:${path.join(logs, 'backup.err.log')}
`,
  );

  fs.writeFileSync(
    path.join(directory, 'sessionvault.timer'),
    `[Unit]
Description=Run SessionVault every ${intervalMinutes} minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=${intervalMinutes}min
Persistent=true

[Install]
WantedBy=timers.target
`,
  );

  await run('systemctl', ['--user', 'daemon-reload']);
  const enable = await run('systemctl', ['--user', 'enable', '--now', 'sessionvault.timer']);
  if (!enable.ok) throw new Error(`systemctl failed: ${enable.stderr.trim()}`);

  // Without lingering, a user timer stops when the user logs out.
  const linger = await run('loginctl', ['enable-linger', os.userInfo().username]);
  if (!linger.ok) {
    warn('Could not enable lingering. The timer runs only while you are logged in.');
  }
  return path.join(directory, 'sessionvault.timer');
}

async function removeSystemd() {
  await run('systemctl', ['--user', 'disable', '--now', 'sessionvault.timer']);
  fs.rmSync(path.join(systemdDir(), 'sessionvault.timer'), { force: true });
  fs.rmSync(path.join(systemdDir(), 'sessionvault.service'), { force: true });
  await run('systemctl', ['--user', 'daemon-reload']);
}

// ---------------------------------------------------------------- Windows

async function installSchtasks(intervalMinutes) {
  const result = await run('schtasks', [
    '/Create',
    '/F',
    '/SC',
    'MINUTE',
    '/MO',
    String(intervalMinutes),
    '/TN',
    'SessionVault Backup',
    '/TR',
    `"${process.execPath}" "${entryPoint()}" backup --quiet`,
  ]);
  if (!result.ok) throw new Error(`schtasks failed: ${result.stderr.trim()}`);
  return 'SessionVault Backup';
}

async function removeSchtasks() {
  await run('schtasks', ['/Delete', '/F', '/TN', 'SessionVault Backup']);
}

// ------------------------------------------------------------------- API

export async function installSchedule({ intervalMinutes = 120 } = {}) {
  if (process.platform === 'darwin') {
    const target = await installLaunchd(intervalMinutes);
    ok(`Scheduled with launchd every ${intervalMinutes} minutes.`);
    log(colour.grey(`  ${target}`));
    return target;
  }
  if (process.platform === 'linux') {
    const target = await installSystemd(intervalMinutes);
    ok(`Scheduled with a systemd user timer every ${intervalMinutes} minutes.`);
    log(colour.grey(`  ${target}`));
    return target;
  }
  if (process.platform === 'win32') {
    const target = await installSchtasks(intervalMinutes);
    ok(`Scheduled as the task "${target}" every ${intervalMinutes} minutes.`);
    return target;
  }
  throw new Error(`no scheduler is known for ${process.platform}`);
}

export async function removeSchedule() {
  if (process.platform === 'darwin') await removeLaunchd();
  else if (process.platform === 'linux') await removeSystemd();
  else if (process.platform === 'win32') await removeSchtasks();
  else throw new Error(`no scheduler is known for ${process.platform}`);
  ok('The schedule was removed.');
}

export async function scheduleStatus() {
  if (process.platform === 'darwin') {
    const result = await run('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]);
    return result.ok ? 'installed' : 'not installed';
  }
  if (process.platform === 'linux') {
    const result = await run('systemctl', ['--user', 'is-enabled', 'sessionvault.timer']);
    return result.ok ? result.stdout.trim() : 'not installed';
  }
  if (process.platform === 'win32') {
    const result = await run('schtasks', ['/Query', '/TN', 'SessionVault Backup']);
    return result.ok ? 'installed' : 'not installed';
  }
  return 'unknown';
}
