import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatusReply, createLineMessenger } from '../src/line/messenger.js';

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

test('LINE status reply builds one actionable card per request status', () => {
  const message = buildStatusReply('liff-123', '未結案', {
    total: 5,
    items: [
      { requestId: 'RQ-1', status: '待確認', applicant: '小明', itemCount: 2, firstItem: '商品 A' },
      { requestId: 'RQ-2', status: '已下單', applicant: '小華', itemCount: 1, firstItem: '商品 B' },
      { requestId: 'RQ-3', status: '部分到貨', applicant: '小美', itemCount: 3, firstItem: '商品 C' },
      { requestId: 'RQ-4', status: '已完成', applicant: '老闆', itemCount: 4, firstItem: '商品 D' },
      { requestId: 'RQ-5', status: '取消', applicant: '小林', itemCount: 1, firstItem: '商品 E' }
    ]
  });

  assert.equal(message.type, 'flex');
  assert.equal(message.altText, '【未結案】共 5 筆補貨單');
  assert.equal(message.contents.type, 'carousel');
  assert.equal(message.contents.contents.length, 5);
  const actions = message.contents.contents.map((bubble) => bubble.footer.contents[0].action);
  assert.deepEqual(actions.map((action) => action.label), [
    '確認下單', '登記到貨', '繼續登記', '查看明細', '查看明細'
  ]);
  assert.deepEqual(actions.map((action) => new URL(action.uri).searchParams.get('mode')), [
    'order', 'receipt', 'receipt', 'detail', 'detail'
  ]);
  assert.deepEqual(actions.map((action) => new URL(action.uri).searchParams.get('requestId')), [
    'RQ-1', 'RQ-2', 'RQ-3', 'RQ-4', 'RQ-5'
  ]);
});

test('LINE status reply limits the carousel to ten cards and keeps the total', () => {
  const message = buildStatusReply('liff-123', '待確認', {
    total: 12,
    items: Array.from({ length: 12 }, (_, index) => ({
      requestId: `RQ-${index + 1}`,
      status: '待確認',
      applicant: '申請人',
      itemCount: 1,
      firstItem: '很長的商品名稱'.repeat(20)
    }))
  });

  assert.equal(message.altText, '【待確認】共 12 筆補貨單（顯示最近 10 筆）');
  assert.equal(message.contents.contents.length, 10);
  const productText = message.contents.contents[0].body.contents[3].text;
  assert.ok(productText.length < 90);
  assert.match(productText, /…$/);
});

test('LINE status reply uses a normal text message for an empty result', async () => {
  const calls = [];
  const messenger = createLineMessenger(
    { channelAccessToken: 'token', liffId: 'liff-123' },
    { client: { async replyMessage(input) { calls.push(input); } } }
  );

  await messenger.replyStatusCards('reply-empty', '部分到貨', { total: 0, items: [] });

  assert.deepEqual(calls, [{
    replyToken: 'reply-empty',
    messages: [{ type: 'text', text: '【部分到貨】目前沒有符合的補貨單。' }]
  }]);
});
