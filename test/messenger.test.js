import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineMessenger } from '../src/line/messenger.js';

test('LINE messenger reads a member profile from the configured group', async () => {
  const calls = [];
  const client = {
    async getGroupMemberProfile(groupId, userId) {
      calls.push({ groupId, userId });
      return { displayName: '小明', userId };
    }
  };
  const messenger = createLineMessenger(
    { channelAccessToken: 'token', liffId: 'liff-123' },
    { client }
  );

  assert.deepEqual(await messenger.getGroupMemberProfile('COMPANY', 'TARGET'), {
    displayName: '小明', userId: 'TARGET'
  });
  assert.deepEqual(calls, [{ groupId: 'COMPANY', userId: 'TARGET' }]);
});
