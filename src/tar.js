// A minimal USTAR reader and writer.
//
// SessionVault has no runtime dependencies, so it carries its own tar code.
// The output is a normal tar archive. You can open it with `tar -xzf` on any
// system. Long paths use the GNU "L" record, which GNU tar and bsdtar read.

import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';

const BLOCK = 512;
const ZEROS = Buffer.alloc(BLOCK);

function octal(value, length) {
  // A tar number field holds octal digits, then one NUL.
  const text = Math.floor(value).toString(8);
  return text.padStart(length - 1, '0').slice(-(length - 1)) + '\0';
}

function writeString(buffer, text, offset, length) {
  buffer.write(text.slice(0, length), offset, length, 'utf8');
}

function buildHeader({ name, size, mtime, mode = 0o644, type = '0' }) {
  const header = Buffer.alloc(BLOCK);
  writeString(header, name, 0, 100);
  writeString(header, octal(mode, 8), 100, 8);
  writeString(header, octal(0, 8), 108, 8); // uid
  writeString(header, octal(0, 8), 116, 8); // gid
  writeString(header, octal(size, 12), 124, 12);
  writeString(header, octal(Math.floor(mtime / 1000), 12), 136, 12);
  header.write('        ', 148, 8, 'utf8'); // checksum placeholder: 8 spaces
  header.write(type, 156, 1, 'utf8');
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');

  let sum = 0;
  for (const byte of header) sum += byte;
  writeString(header, octal(sum, 8), 148, 8);
  header.write(' ', 155, 1, 'utf8');
  return header;
}

function padding(size) {
  const remainder = size % BLOCK;
  return remainder === 0 ? 0 : BLOCK - remainder;
}

/**
 * Streams entries into a tar file.
 *
 *   const pack = new TarPack(writableStream)
 *   await pack.addFile('a/b.txt', '/abs/path/b.txt', stat)
 *   await pack.addBuffer('manifest.json', Buffer.from('...'))
 *   await pack.finish()
 */
export class TarPack {
  constructor(destination) {
    this.out = destination;
    this.bytes = 0;
  }

  async #write(chunk) {
    this.bytes += chunk.length;
    if (!this.out.write(chunk)) {
      await new Promise((resolve) => this.out.once('drain', resolve));
    }
  }

  async #header(entry) {
    // A name over 100 bytes needs a GNU long-name record before the real one.
    const nameBytes = Buffer.byteLength(entry.name);
    if (nameBytes > 100) {
      const nameBuffer = Buffer.from(entry.name + '\0');
      await this.#write(
        buildHeader({ name: '././@LongLink', size: nameBuffer.length, mtime: 0, type: 'L' }),
      );
      await this.#write(nameBuffer);
      const pad = padding(nameBuffer.length);
      if (pad) await this.#write(ZEROS.subarray(0, pad));
      // The real header keeps a truncated copy of the name.
      await this.#write(buildHeader({ ...entry, name: entry.name.slice(-100) }));
    } else {
      await this.#write(buildHeader(entry));
    }
  }

  async addBuffer(name, buffer, mtime = Date.now()) {
    await this.#header({ name, size: buffer.length, mtime });
    await this.#write(buffer);
    const pad = padding(buffer.length);
    if (pad) await this.#write(ZEROS.subarray(0, pad));
  }

  async addFile(name, absolutePath, stat) {
    const size = stat.size;
    await this.#header({ name, size, mtime: stat.mtimeMs, mode: stat.mode & 0o7777 });

    let written = 0;
    const stream = createReadStream(absolutePath);
    for await (const chunk of stream) {
      // The file may grow while we read it. Never write more than the header says.
      let piece = chunk;
      if (written + piece.length > size) piece = piece.subarray(0, size - written);
      if (piece.length === 0) break;
      await this.#write(piece);
      written += piece.length;
    }
    // The file may also shrink. Pad the difference so the archive stays valid.
    if (written < size) {
      let missing = size - written;
      while (missing > 0) {
        const piece = Math.min(missing, BLOCK);
        await this.#write(ZEROS.subarray(0, piece));
        missing -= piece;
      }
    }
    const pad = padding(size);
    if (pad) await this.#write(ZEROS.subarray(0, pad));
  }

  async finish() {
    // Two empty blocks mark the end of the archive.
    await this.#write(ZEROS);
    await this.#write(ZEROS);
  }
}

function parseOctal(buffer) {
  const text = buffer.toString('utf8').replace(/\0.*$/, '').trim();
  if (text === '') return 0;
  return parseInt(text, 8) || 0;
}

/**
 * Reads a tar stream and yields { name, size, type, stream }.
 * You must consume (or ignore) each entry before the next one arrives.
 */
export async function* tarEntries(source) {
  const reader = Readable.from(source);
  const iterator = reader[Symbol.asyncIterator]();
  let pendingLongName = null;

  // Chunks wait in a list. One concat at the end keeps this linear, not
  // quadratic: a repeated Buffer.concat on a 300 MB entry copies gigabytes.
  let queue = [];
  let queued = 0;

  async function take(length) {
    while (queued < length) {
      const { value, done } = await iterator.next();
      if (done) break;
      queue.push(value);
      queued += value.length;
    }
    if (queued < length) return null;

    const parts = [];
    let taken = 0;
    while (taken < length) {
      const head = queue[0];
      const need = length - taken;
      if (head.length <= need) {
        parts.push(head);
        queue.shift();
        taken += head.length;
      } else {
        parts.push(head.subarray(0, need));
        queue[0] = head.subarray(need);
        taken += need;
      }
    }
    queued -= length;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
  }

  while (true) {
    const header = await take(BLOCK);
    if (!header) break;
    if (header.every((byte) => byte === 0)) continue; // end-of-archive block

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseOctal(header.subarray(124, 136));
    const type = header.subarray(156, 157).toString('utf8') || '0';
    const name = pendingLongName ?? rawName;
    pendingLongName = null;

    const body = size > 0 ? await take(size) : Buffer.alloc(0);
    const pad = padding(size);
    if (pad) await take(pad);

    if (type === 'L') {
      pendingLongName = body.toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    if (type === 'x' || type === 'g') continue; // PAX metadata: ignore
    if (type !== '0' && type !== '\0') continue; // only plain files

    yield { name, size, data: body };
  }
}

export function createTarWriteStream(path) {
  return createWriteStream(path);
}
