// Minimal S3 Signature V4 client for PenMark's private Bitiful S4 bucket.
// Credentials always stay on the server; browsers only receive short-lived GET URLs.
require('./env');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');

function envEnabled(value) {
  return /^(1|true|yes)$/i.test(String(value || ''));
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function rfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
}

function objectPath(key) {
  return '/' + String(key || '').split('/').filter(Boolean).map(rfc3986).join('/');
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function amzDateParts(date) {
  const pad = value => String(value).padStart(2, '0');
  const shortDate = date.getUTCFullYear() + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate());
  return {
    shortDate,
    longDate: shortDate + 'T' + pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()) + 'Z'
  };
}

function canonicalQuery(params) {
  return [...params]
    .map(([key, value]) => [rfc3986(key), rfc3986(value)])
    .sort((a, b) => a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]))
    .map(([key, value]) => key + '=' + value)
    .join('&');
}

function makeSigningKey(secret, shortDate, region) {
  const dateKey = hmac('AWS4' + secret, shortDate);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

function normalizeEndpoint(bucket, rawEndpoint, pathStyle) {
  const source = String(rawEndpoint || 'https://' + bucket + '.s3.bitiful.net').trim();
  const endpoint = new URL(/^https?:\/\//i.test(source) ? source : 'https://' + source);
  if (!pathStyle && endpoint.hostname.includes('{bucket}')) {
    endpoint.hostname = endpoint.hostname.replace('{bucket}', bucket);
  } else if (!pathStyle && endpoint.hostname === 's3.bitiful.net') {
    endpoint.hostname = bucket + '.' + endpoint.hostname;
  }
  return endpoint;
}

function createS4Client(overrides) {
  const config = Object.assign({}, process.env, overrides || {});
  const bucket = String(config.PENMARK_S4_BUCKET || '').trim();
  const accessKey = String(config.PENMARK_S4_ACCESS_KEY || '').trim();
  const secretKey = String(config.PENMARK_S4_SECRET_KEY || '').trim();
  const pathStyle = envEnabled(config.PENMARK_S4_PATH_STYLE);
  const enabled = process.env.PENMARK_DESKTOP !== '1' && envEnabled(config.PENMARK_S4_ENABLED) && !!(bucket && accessKey && secretKey);
  const region = String(config.PENMARK_S4_REGION || 'cn-east-1').trim();
  const ttlSeconds = boundedInt(config.PENMARK_S4_SIGNED_GET_TTL, 600, 60, 3600);
  const timeoutMs = boundedInt(config.PENMARK_S4_REQUEST_TIMEOUT_MS, 30000, 5000, 120000);
  const endpoint = enabled ? normalizeEndpoint(bucket, config.PENMARK_S4_ENDPOINT, pathStyle) : null;

  function remotePath(key) {
    const encoded = objectPath(key);
    return pathStyle ? '/' + rfc3986(bucket) + encoded : encoded;
  }

  function makeUrl(key) {
    if (!endpoint) return null;
    const target = new URL(endpoint.toString());
    target.pathname = remotePath(key);
    target.search = '';
    return target;
  }

  function signGet(key, now) {
    if (!enabled) return null;
    const target = makeUrl(key);
    const date = now instanceof Date ? now : new Date();
    const dates = amzDateParts(date);
    const credentialScope = dates.shortDate + '/' + region + '/s3/aws4_request';
    const params = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', accessKey + '/' + credentialScope],
      ['X-Amz-Date', dates.longDate],
      ['X-Amz-Expires', String(ttlSeconds)],
      ['X-Amz-SignedHeaders', 'host']
    ];
    const query = canonicalQuery(params);
    const canonicalHeaders = 'host:' + target.host + '\n';
    const canonicalRequest = 'GET\n' + target.pathname + '\n' + query + '\n' + canonicalHeaders + '\nhost\nUNSIGNED-PAYLOAD';
    const stringToSign = 'AWS4-HMAC-SHA256\n' + dates.longDate + '\n' + credentialScope + '\n' + hash(canonicalRequest);
    const signature = hmac(makeSigningKey(secretKey, dates.shortDate, region), stringToSign, 'hex');
    target.search = '?' + query + '&X-Amz-Signature=' + signature;
    return target.toString();
  }

  async function putFile(key, filePath, mimeType) {
    if (!enabled) throw new Error('S4 is not configured');
    const payload = await fs.promises.readFile(filePath);
    const target = makeUrl(key);
    const date = new Date();
    const dates = amzDateParts(date);
    const payloadHash = hash(payload);
    const headers = {
      'content-length': String(payload.length),
      'content-type': String(mimeType || 'application/octet-stream'),
      'host': target.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': dates.longDate
    };
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map(name => name + ':' + String(headers[name]).trim().replace(/\s+/g, ' ') + '\n').join('');
    const signedHeaders = signedHeaderNames.join(';');
    const credentialScope = dates.shortDate + '/' + region + '/s3/aws4_request';
    const canonicalRequest = 'PUT\n' + target.pathname + '\n\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + payloadHash;
    const stringToSign = 'AWS4-HMAC-SHA256\n' + dates.longDate + '\n' + credentialScope + '\n' + hash(canonicalRequest);
    headers.authorization = 'AWS4-HMAC-SHA256 Credential=' + accessKey + '/' + credentialScope + ', SignedHeaders=' + signedHeaders + ', Signature=' + hmac(makeSigningKey(secretKey, dates.shortDate, region), stringToSign, 'hex');

    const transport = target.protocol === 'http:' ? http : https;
    await new Promise((resolve, reject) => {
      const request = transport.request(target, { method: 'PUT', headers, timeout: timeoutMs }, response => {
        const chunks = [];
        response.on('data', chunk => { if (Buffer.concat(chunks).length < 4096) chunks.push(chunk); });
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) return resolve();
          const detail = Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').slice(0, 300);
          reject(new Error('S4 upload failed with HTTP ' + response.statusCode + (detail ? ': ' + detail : '')));
        });
      });
      request.on('timeout', () => request.destroy(new Error('S4 upload timed out')));
      request.on('error', reject);
      request.end(payload);
    });
  }

  return { enabled, bucket, region, ttlSeconds, signGet, putFile };
}

module.exports = { createS4Client };
