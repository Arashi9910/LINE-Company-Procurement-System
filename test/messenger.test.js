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

test('LINE order confirmation includes purchase additions and omits cancelled items', async () => {
  const calls = [];
  const client = {
    async pushMessage(input) { calls.push(input); }
  };
  const messenger = createLineMessenger(
    { channelAccessToken: 'token', liffId: 'liff-123' },
    { client }
  );

  await messenger.pushOrderConfirmed('COMPANY', {
    requestId: 'RQ-1',
    items: [
      {
        sku: 'SKU-A', displayName: '原申請商品', requestedQuantity: 2,
        orderedQuantity: 2, unit: '件', expectedDate: '2026-07-20', status: '已下單'
      },
      {
        sku: 'SKU-B', displayName: '老闆追加規格', requestedQuantity: 0,
        orderedQuantity: 3, unit: '件', expectedDate: '2026-07-21', status: '已下單'
      },
      {
        sku: 'SKU-C', displayName: '不採購商品', requestedQuantity: 1,
        orderedQuantity: 0, unit: '件', expectedDate: '', status: '取消'
      }
    ]
  }, { displayName: '老闆' });

  const text = calls[0].messages[0].text;
  assert.match(text, /原申請商品 × 2 件/);
  assert.match(text, /老闆追加規格 × 3 件/);
  assert.doesNotMatch(text, /不採購商品 ×/);
});
