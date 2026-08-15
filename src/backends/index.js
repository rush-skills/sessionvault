import { WranglerBackend } from './wrangler.js';
import { S3Backend } from './s3.js';
import { LocalBackend } from './local.js';

export const BACKENDS = ['wrangler', 's3', 'local'];

export function createBackend(config) {
  const kind = config.backend || 'wrangler';
  if (kind === 'wrangler') return new WranglerBackend(config);
  if (kind === 's3') return new S3Backend(config);
  if (kind === 'local') return new LocalBackend(config);
  throw new Error(`unknown backend: ${kind}. Choose one of ${BACKENDS.join(', ')}.`);
}

export { WranglerBackend, S3Backend, LocalBackend };
