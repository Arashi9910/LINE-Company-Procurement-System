import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroupContext, verifyGroupContext } from '../src/line/context.js';
import { createLineIdentityVerifier } from '../src/line/identity.js';

test('group context round-trips and rejects tampering or expiry', () => {
  const secret = 'test-secret';
  const token = createGroupContext({ groupId: 'C123' }, secret, { now: 1_000, ttlMs: 500 });
  assert.deepEqual(verifyGroupContext(token, secret, { now: 1_200 }), { groupId: 'C123' });
  assert.throws(() => verifyGroupContext(`${token}x`, secret, { now: 1_200 }), /簽章/);
  assert.throws(() => verifyGroupContext(token, secret, { now: 2_000 }), /過期/);
});

test('LINE identity verifier trusts only the configured audience', async () => {
  const verifier = createLineIdentityVerifier({
    channelId: 'channel-123',
    fetchImpl: async (_url, options) => {
      assert.match(String(options.body), /client_id=channel-123/);
      return new Response(JSON.stringify({
        sub: 'U123',
        aud: 'channel-123',
        name: '小明'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  assert.deepEqual(await verifier.verify('valid-token'), {
    userId: 'U123',
    displayName: '小明',
    pictureUrl: ''
  });
});

test('LINE identity verifier rejects errors and a forged audience', async () => {
  const rejected = createLineIdentityVerifier({
    channelId: 'channel-123',
    fetchImpl: async () => new Response('{}', { status: 400 })
  });
  await assert.rejects(rejected.verify('bad-token'), /驗證失敗/);

  const forged = createLineIdentityVerifier({
    channelId: 'channel-123',
    fetchImpl: async () => new Response(JSON.stringify({ sub: 'U123', aud: 'other-channel' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  });
  await assert.rejects(forged.verify('forged-token'), /驗證失敗/);
});
