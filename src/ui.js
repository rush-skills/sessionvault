// Terminal output helpers. No colour library, no dependencies.

const useColour =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (code) => (text) => (useColour ? `[${code}m${text}[0m` : String(text));

export const colour = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  cyan: wrap(36),
  grey: wrap(90),
};

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)}${units[unit]}`;
}

export function formatDuration(milliseconds) {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function formatTime(value) {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

export function table(rows, headers) {
  if (rows.length === 0) return '';
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length)),
  );
  const line = (cells, pad = ' ') =>
    cells.map((cell, index) => String(cell ?? '').padEnd(widths[index], pad)).join('  ');
  const out = [colour.bold(line(headers)), colour.grey(line(widths.map(() => ''), '─'))];
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}

export function log(message = '') {
  process.stdout.write(`${message}\n`);
}

export function step(message) {
  log(`${colour.cyan('›')} ${message}`);
}

export function ok(message) {
  log(`${colour.green('✓')} ${message}`);
}

export function warn(message) {
  log(`${colour.yellow('!')} ${message}`);
}

export function fail(message) {
  process.stderr.write(`${colour.red('✗')} ${message}\n`);
}

/** A single-line progress display that stays quiet when output is a pipe. */
export function progress() {
  let last = 0;
  return {
    update(text) {
      if (!process.stdout.isTTY) return;
      const now = Date.now();
      if (now - last < 80) return;
      last = now;
      const width = Math.max(20, (process.stdout.columns || 80) - 1);
      process.stdout.write(`\r${text.slice(0, width).padEnd(width)}`);
    },
    clear() {
      if (!process.stdout.isTTY) return;
      const width = Math.max(20, (process.stdout.columns || 80) - 1);
      process.stdout.write(`\r${' '.repeat(width)}\r`);
    },
  };
}
