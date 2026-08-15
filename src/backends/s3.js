// The S3 backend, for R2's S3-compatible endpoint.
//
// It is faster than the Wrangler backend, it can list a bucket, and it can
// upload an object larger than the Wrangler limit. It needs an R2 access key
// pair. Create one in the Cloudflare dashboard under R2 > API > Manage API
// tokens, then run `sessionvault init --backend s3`.
//
// The AWS Signature Version 4 code below uses only node:crypto, so the tool
// keeps its promise of zero runtime dependencies.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SERVICE = 's3';
const UNSIGNED = 'UNSIGNED-PAYLOAD';

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function encodeKey(key) {
  // Each path segment is encoded, but the separators stay.
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) =>
      `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

export class S3Backend {
  constructor(config) {
    this.bucket = config.bucket;
    this.accountId = config.accountId;
    this.region = config.region || 'auto';
    this.accessKeyId = config.accessKeyId || process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
    this.secretAccessKey =
      config.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
    this.endpoint =
      config.endpoint ||
      process.env.R2_ENDPOINT ||
      (this.accountId ? `https://${this.accountId}.r2.cloudflarestorage.com` : null);

    if (!this.endpoint) throw new Error('the s3 backend needs an endpoint or an accountId');
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new Error(
        'the s3 backend needs an access key. Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, ' +
          'or put them in the SessionVault config.',
      );
    }
  }

  describe() {
    return `s3 (${new URL(this.endpoint).host}/${this.bucket})`;
  }

  supportsList() {
    return true;
  }

  #sign({ method, key, query = '', payloadHash = UNSIGNED, headers = {}, contentLength }) {
    const url = new URL(this.endpoint);
    const canonicalUri = `/${this.bucket}${key ? `/${encodeKey(key)}` : ''}`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    // Every header name is lowercased once, so the canonical form and the
    // request that goes out cannot drift apart.
    const allHeaders = {};
    const add = (name, value) => {
      if (value !== undefined && value !== null) allHeaders[name.toLowerCase()] = String(value);
    };
    add('host', url.host);
    add('x-amz-content-sha256', payloadHash);
    add('x-amz-date', amzDate);
    for (const [name, value] of Object.entries(headers)) add(name, value);
    if (contentLength !== undefined) add('content-length', contentLength);

    const sortedNames = Object.keys(allHeaders).sort();
    const canonicalHeaders = sortedNames
      .map((name) => `${name}:${allHeaders[name].trim()}\n`)
      .join('');
    const signedHeaders = sortedNames.join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      query,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.region}/${SERVICE}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    let signingKey = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    signingKey = hmac(signingKey, this.region);
    signingKey = hmac(signingKey, SERVICE);
    signingKey = hmac(signingKey, 'aws4_request');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    allHeaders.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      url: `${url.origin}${canonicalUri}${query ? `?${query}` : ''}`,
      headers: allHeaders,
    };
  }

  async put(key, filePath, options = {}) {
    const body = fs.readFileSync(filePath);
    return this.putBuffer(key, body, options);
  }

  async putBuffer(key, buffer, options = {}) {
    const payloadHash = sha256Hex(buffer);
    const { url, headers } = this.#sign({
      method: 'PUT',
      key,
      payloadHash,
      contentLength: buffer.length,
      headers: { 'content-type': options.contentType || 'application/octet-stream' },
    });
    const response = await fetch(url, { method: 'PUT', headers, body: buffer });
    if (!response.ok) {
      throw new Error(`upload failed for ${key}: ${response.status} ${await response.text()}`);
    }
    return true;
  }

  async get(key, destination) {
    const { url, headers } = this.#sign({ method: 'GET', key });
    const response = await fetch(url, { method: 'GET', headers });
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new Error(`download failed for ${key}: ${response.status} ${await response.text()}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
    return true;
  }

  async getBuffer(key) {
    const { url, headers } = this.#sign({ method: 'GET', key });
    const response = await fetch(url, { method: 'GET', headers });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`download failed for ${key}: ${response.status} ${await response.text()}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key) {
    const { url, headers } = this.#sign({ method: 'DELETE', key });
    const response = await fetch(url, { method: 'DELETE', headers });
    return response.ok || response.status === 404;
  }

  async list(prefix = '') {
    const objects = [];
    let token = null;

    do {
      const parameters = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
      if (token) parameters.set('continuation-token', token);
      // The query must be sorted for the signature to match.
      const query = [...parameters.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
        .join('&');

      const { url, headers } = this.#sign({ method: 'GET', key: '', query });
      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) {
        throw new Error(`list failed: ${response.status} ${await response.text()}`);
      }
      const xml = await response.text();
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const block = match[1];
        const key = (block.match(/<Key>([\s\S]*?)<\/Key>/) || [])[1];
        const size = Number((block.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0);
        const modified = (block.match(/<LastModified>([\s\S]*?)<\/LastModified>/) || [])[1];
        if (key) objects.push({ key: decodeXml(key), size, modified });
      }
      token = (xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1];
      if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) token = null;
    } while (token);

    return objects;
  }

  async ensureBucket() {
    // The S3 API cannot create an R2 bucket with these credentials in every
    // account setup. Report whether it is reachable instead.
    const { url, headers } = this.#sign({ method: 'GET', key: '', query: 'list-type=2&max-keys=1' });
    const response = await fetch(url, { method: 'GET', headers });
    if (response.status === 404) {
      throw new Error(
        `the bucket ${this.bucket} does not exist. Create it with ` +
          `\`wrangler r2 bucket create ${this.bucket}\` or in the dashboard.`,
      );
    }
    if (!response.ok) throw new Error(`cannot reach the bucket: ${response.status}`);
    return { created: false };
  }
}

function decodeXml(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
