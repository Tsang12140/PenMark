const assert = require('assert');
const { createS4Client } = require('../s4');

function check(name, fn) {
  try {
    fn();
    console.log('✓ ' + name);
  } catch (err) {
    console.error('✗ ' + name + ': ' + err.message);
    process.exitCode = 1;
  }
}

const config = {
  PENMARK_S4_ENABLED: '1',
  PENMARK_S4_BUCKET: 'penmark-images',
  PENMARK_S4_ACCESS_KEY: 'AKIDEXAMPLE',
  PENMARK_S4_SECRET_KEY: 'test-secret-not-a-real-key',
  PENMARK_S4_REGION: 'cn-east-1',
  PENMARK_S4_SIGNED_GET_TTL: '600'
};

check('S4 signs a private Bitiful object URL', () => {
  const client = createS4Client(config);
  const url = new URL(client.signGet('penmark/admin/image name.png', new Date('2026-07-29T00:00:00Z')));
  assert.equal(client.enabled, true);
  assert.equal(url.host, 'penmark-images.s3.bitiful.net');
  assert.equal(url.pathname, '/penmark/admin/image%20name.png');
  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '600');
  assert.equal(url.searchParams.get('X-Amz-Credential'), 'AKIDEXAMPLE/20260729/cn-east-1/s3/aws4_request');
  assert.match(url.searchParams.get('X-Amz-Signature') || '', /^[a-f0-9]{64}$/);
});

check('S4 remains disabled without explicit enablement and keys', () => {
  const client = createS4Client({ PENMARK_S4_ENABLED: '0' });
  assert.equal(client.enabled, false);
  assert.equal(client.signGet('penmark/admin/example.png'), null);
});

if (process.exitCode) process.exit(process.exitCode);
