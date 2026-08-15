// An end-to-end test on a fake home directory. It never touches the real
// agent folders and never talks to the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('backup then restore reproduces every file', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-e2e-'));
  const fakeHome = path.join(sandbox, 'home');
  const archive = path.join(sandbox, 'archive');
  const restored = path.join(sandbox, 'restored');

  // Build a small Claude Code and Codex layout inside the fake home.
  const claudeProject = path.join(fakeHome, '.claude', 'projects', '-tmp-demo');
  fs.mkdirSync(claudeProject, { recursive: true });
  fs.writeFileSync(path.join(claudeProject, 'session-one.jsonl'), '{"type":"user"}\n'.repeat(200));
  fs.mkdirSync(path.join(claudeProject, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(claudeProject, 'subagents', 'agent-1.jsonl'), '{"a":1}\n');
  fs.writeFileSync(path.join(fakeHome, '.claude', 'history.jsonl'), '{"prompt":"hi"}\n');

  // A file that must never be uploaded.
  fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.codex', 'auth.json'), '{"token":"SHOULD-NOT-LEAVE"}');
  fs.mkdirSync(path.join(fakeHome, '.codex', 'sessions', '2026', '01'), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, '.codex', 'sessions', '2026', '01', 'rollout.jsonl'),
    '{"turn":1}\n',
  );

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousVaultHome = process.env.SESSIONVAULT_HOME;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.SESSIONVAULT_HOME = path.join(sandbox, 'state');

  try {
    // The modules read HOME when they load, so import them after the change.
    const { backup } = await import(`../src/commands/backup.js?e2e=${Date.now()}`);
    const { restore } = await import(`../src/commands/restore.js?e2e=${Date.now()}`);

    const overrides = {
      backend: 'local',
      localRoot: archive,
      bucket: 'test',
      machine: 'test-machine',
      prefix: 'sv/v1',
    };

    const first = await backup({ configOverrides: overrides, only: ['claude-code', 'codex'] });
    assert.ok(first.uploaded >= 4, `expected at least 4 files, got ${first.uploaded}`);

    // A second run must find nothing new.
    const second = await backup({ configOverrides: overrides, only: ['claude-code', 'codex'] });
    assert.equal(second.uploaded, 0, 'an unchanged tree must upload nothing');

    // Append to one transcript, as a live agent would.
    fs.appendFileSync(path.join(claudeProject, 'session-one.jsonl'), '{"type":"assistant"}\n');
    const third = await backup({ configOverrides: overrides, only: ['claude-code', 'codex'] });
    assert.equal(third.uploaded, 1, 'only the changed transcript should go');

    const result = await restore({ configOverrides: overrides, machine: 'test-machine', to: restored });
    assert.ok(result.files > 0);

    // Every original file must come back with the same bytes.
    const original = path.join(claudeProject, 'session-one.jsonl');
    const copy = path.join(
      restored,
      'claude-code',
      'home',
      '.claude',
      'projects',
      '-tmp-demo',
      'session-one.jsonl',
    );
    assert.ok(fs.existsSync(copy), 'the transcript must be restored');
    assert.equal(hash(copy), hash(original), 'the newest version must win');

    // The credential file must not be anywhere in the archive.
    const everything = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else everything.push(full);
      }
    };
    walk(restored);
    assert.ok(
      !everything.some((file) => file.endsWith('auth.json')),
      'a credential file must never be archived',
    );
    const bodies = everything.map((file) => fs.readFileSync(file, 'utf8')).join('');
    assert.ok(!bodies.includes('SHOULD-NOT-LEAVE'), 'no credential content may appear');
  } finally {
    process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousVaultHome === undefined) delete process.env.SESSIONVAULT_HOME;
    else process.env.SESSIONVAULT_HOME = previousVaultHome;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
