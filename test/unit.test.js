import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

import { TarPack, tarEntries } from '../src/tar.js';
import { globToRegExp, matchesAny, expandGlobPath } from '../src/paths.js';
import { selectChanged, encryptFile, decryptFile, isEncrypted, hashFile } from '../src/bundle.js';
import { parseArgs } from '../src/cli.js';
import { AGENTS } from '../src/registry.js';
import { LocalBackend } from '../src/backends/local.js';
import { defaultMachineId } from '../src/config.js';

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sv-test-${name}-`));
}

test('glob patterns match the way the registry expects', () => {
  assert.ok(globToRegExp('*.jsonl').test('a.jsonl'));
  assert.ok(!globToRegExp('*.jsonl').test('a/b.jsonl'));
  assert.ok(globToRegExp('**/*.jsonl').test('a/b/c.jsonl'));
  assert.ok(globToRegExp('**/*.jsonl').test('c.jsonl'), '**/ must also match zero directories');
  assert.ok(globToRegExp('**/image-cache/**').test('x/image-cache/y.png'));
  assert.ok(matchesAny('a/node_modules/b.js', ['**/node_modules/**']));
  assert.ok(!matchesAny('a/b.js', ['**/node_modules/**']));
});

test('a tar round trip keeps content and long paths', async () => {
  const directory = tempDir('tar');
  const archive = path.join(directory, 'test.tar');
  const longName = `agent/${'deep-directory-name/'.repeat(9)}file.jsonl`;
  assert.ok(longName.length > 100, 'the test needs a name over the 100-byte tar limit');

  const source = path.join(directory, 'source.txt');
  const body = Buffer.from('hello '.repeat(5000));
  fs.writeFileSync(source, body);

  const output = fs.createWriteStream(archive);
  const pack = new TarPack(output);
  await pack.addBuffer('_sessionvault.json', Buffer.from('{"tool":"sessionvault"}'));
  await pack.addFile(longName, source, fs.statSync(source));
  await pack.finish();
  output.end();
  await new Promise((resolve) => output.on('close', resolve));

  const found = [];
  for await (const entry of tarEntries(fs.createReadStream(archive))) {
    found.push(entry);
  }
  assert.equal(found.length, 2);
  assert.equal(found[0].name, '_sessionvault.json');
  assert.equal(found[1].name, longName, 'a long name must survive the GNU long-link record');
  assert.equal(found[1].data.length, body.length);
  assert.ok(found[1].data.equals(body));
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a gzipped tar reads back through the same reader', async () => {
  const directory = tempDir('targz');
  const archive = path.join(directory, 'test.tar.gz');
  const gzip = zlib.createGzip();
  const output = fs.createWriteStream(archive);
  gzip.pipe(output);
  const pack = new TarPack(gzip);
  await pack.addBuffer('a.txt', Buffer.from('one'));
  await pack.addBuffer('b/c.txt', Buffer.from('two'));
  await pack.finish();
  gzip.end();
  await new Promise((resolve) => output.on('close', resolve));

  const names = [];
  const stream = fs.createReadStream(archive).pipe(zlib.createGunzip());
  for await (const entry of tarEntries(stream)) names.push(entry.name);
  assert.deepEqual(names, ['a.txt', 'b/c.txt']);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('selectChanged sends new and changed files only', () => {
  const config = { heavyIntervalHours: 24, maxFileMB: 10 };
  const files = [
    { key: 'a', size: 10, mtimeMs: 100 },
    { key: 'b', size: 20, mtimeMs: 200 },
    { key: 'c', size: 30, mtimeMs: 300 },
  ];
  const state = {
    files: {
      a: { size: 10, mtimeMs: 100, uploadedAt: 1 }, // unchanged
      b: { size: 19, mtimeMs: 200, uploadedAt: 1 }, // grew
      gone: { size: 1, mtimeMs: 1, uploadedAt: 1 }, // removed from disk
    },
  };
  const result = selectChanged(files, state, config);
  assert.deepEqual(result.selected.map((file) => file.key), ['b', 'c']);
  assert.deepEqual(result.removed, ['gone']);
  assert.equal(result.skipped.unchanged, 1);
});

test('a heavy file waits for its interval, then goes', () => {
  const config = { heavyIntervalHours: 24, maxFileMB: 10 };
  const files = [{ key: 'db', size: 10, mtimeMs: 999, heavy: true }];
  const now = 1_000_000_000;

  const recent = { files: { db: { size: 5, mtimeMs: 1, uploadedAt: now - 3600 * 1000 } } };
  assert.equal(selectChanged(files, recent, config, now).selected.length, 0);

  const old = { files: { db: { size: 5, mtimeMs: 1, uploadedAt: now - 25 * 3600 * 1000 } } };
  assert.equal(selectChanged(files, old, config, now).selected.length, 1);
});

test('a file over the size limit is skipped, not half sent', () => {
  const config = { maxFileMB: 1 };
  const files = [{ key: 'huge', size: 5 * 1024 * 1024, mtimeMs: 1 }];
  const result = selectChanged(files, { files: {} }, config);
  assert.equal(result.selected.length, 0);
  assert.equal(result.skipped.tooBig, 1);
});

test('encryption is reversible and detectable', async () => {
  const directory = tempDir('crypt');
  const plain = path.join(directory, 'plain.bin');
  const body = Buffer.from('secret transcript '.repeat(1000));
  fs.writeFileSync(plain, body);
  const originalHash = hashFile(plain);

  assert.equal(isEncrypted(plain), false);
  await encryptFile(plain, 'a passphrase');
  assert.equal(isEncrypted(plain), true);
  assert.ok(!fs.readFileSync(plain).includes('secret transcript'), 'the body must not be readable');

  const back = path.join(directory, 'back.bin');
  await decryptFile(plain, back, 'a passphrase');
  assert.equal(hashFile(back), originalHash);

  await assert.rejects(() => decryptFile(plain, `${back}.bad`, 'the wrong passphrase'));
  fs.rmSync(directory, { recursive: true, force: true });
});

test('the local backend stores, reads, lists and deletes', async () => {
  const directory = tempDir('backend');
  const backend = new LocalBackend({ localRoot: directory });
  await backend.ensureBucket();

  await backend.putBuffer('a/b/c.json', Buffer.from('{"x":1}'));
  assert.equal((await backend.getBuffer('a/b/c.json')).toString(), '{"x":1}');
  assert.equal(await backend.getBuffer('missing'), null);

  const listed = await backend.list('a/');
  assert.deepEqual(listed.map((object) => object.key), ['a/b/c.json']);

  await backend.delete('a/b/c.json');
  assert.equal(await backend.getBuffer('a/b/c.json'), null);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('the local backend refuses a key that escapes its root', async () => {
  const directory = tempDir('escape');
  const backend = new LocalBackend({ localRoot: directory });
  await assert.rejects(() => backend.putBuffer('../escaped.json', Buffer.from('x')));
  fs.rmSync(directory, { recursive: true, force: true });
});

test('every agent id is unique and every source has a path', () => {
  const ids = AGENTS.map((agent) => agent.id);
  assert.equal(new Set(ids).size, ids.length, 'two agents share an id');
  for (const agent of AGENTS) {
    assert.ok(agent.name, `${agent.id} has no name`);
    assert.ok(agent.sources.length > 0, `${agent.id} has no source`);
    for (const source of agent.sources) {
      assert.equal(typeof source.path, 'string', `${agent.id} has a source without a path`);
    }
  }
});

test('the argument parser understands the shapes the CLI uses', () => {
  const args = parseArgs(['backup', '--only', 'a,b', '--dry-run', '--bucket=x', '-v']);
  assert.deepEqual(args._, ['backup']);
  assert.equal(args.flags.only, 'a,b');
  assert.equal(args.flags.dryRun, true);
  assert.equal(args.flags.bucket, 'x');
  assert.equal(args.flags.v, true);
});

test('the machine id is stable across calls', () => {
  assert.equal(defaultMachineId(), defaultMachineId());
  assert.match(defaultMachineId(), /^[a-z0-9-]+-[0-9a-f]{6}$/);
});

test('glob path expansion finds real directories only', () => {
  const directory = tempDir('glob');
  fs.mkdirSync(path.join(directory, 'ws-one'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'ws-two'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'ws-one', 'state.db'), 'x');
  fs.writeFileSync(path.join(directory, 'ws-two', 'state.db'), 'y');

  const found = expandGlobPath(path.join(directory, '*', 'state.db'));
  assert.equal(found.length, 2);
  assert.equal(expandGlobPath(path.join(directory, '*', 'absent.db')).length, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});
