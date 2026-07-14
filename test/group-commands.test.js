import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatStatusReply,
  parseGroupCommand,
  summarizeRequests
} from '../src/services/group-commands.js';

test('parseGroupCommand recognizes every status query and help', () => {
  const cases = [
    ['查未結案', { type: 'status', status: '未結案' }],
    ['查待確認', { type: 'status', status: '待確認' }],
    ['查已下單', { type: 'status', status: '已下單' }],
    ['查部分到貨', { type: 'status', status: '部分到貨' }],
    ['查已完成', { type: 'status', status: '已完成' }],
    ['查取消', { type: 'status', status: '取消' }],
    ['補貨指令', { type: 'help' }]
  ];

  for (const [text, expected] of cases) {
    assert.deepEqual(parseGroupCommand({ type: 'text', text: ` ${text} ` }), expected);
  }
  assert.equal(parseGroupCommand({ type: 'image' }), null);
  assert.equal(parseGroupCommand({ type: 'text', text: '今天要補貨嗎' }), null);
});

test('summarizeRequests aggregates SKU rows and applies request status precedence', () => {
  const rows = [
    { requestId: 'RQ-1', requestedAt: 10, applicant: '小明', displayName: '紅色水壺', status: '已完成' },
    { requestId: 'RQ-1', requestedAt: 10, applicant: '小明', displayName: '藍色水壺', status: '已下單' },
    { requestId: 'RQ-2', requestedAt: 20, applicant: '小華', displayName: '收納盒', status: '取消' },
    { requestId: 'RQ-2', requestedAt: 20, applicant: '小華', displayName: '收納盒替換蓋', status: '取消' },
    { requestId: 'RQ-3', requestedAt: 30, applicant: '老闆', displayName: '掛勾', status: '取消' },
    { requestId: 'RQ-3', requestedAt: 30, applicant: '老闆', displayName: '掛架', status: '已完成' },
    { requestId: 'RQ-4', requestedAt: 40, applicant: '小美', displayName: '桌墊', status: '待確認' }
  ];

  const all = summarizeRequests(rows, '未結案');
  assert.equal(all.total, 2);
  assert.deepEqual(all.items.map(({ requestId, status, itemCount }) => ({ requestId, status, itemCount })), [
    { requestId: 'RQ-4', status: '待確認', itemCount: 1 },
    { requestId: 'RQ-1', status: '部分到貨', itemCount: 2 }
  ]);
  assert.equal(summarizeRequests(rows, '取消').items[0].requestId, 'RQ-2');
  assert.equal(summarizeRequests(rows, '已完成').items[0].requestId, 'RQ-3');
});

test('summarizeRequests returns the newest ten requests and keeps the total count', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    requestId: `RQ-${index + 1}`,
    requestedAt: index + 1,
    applicant: '申請人',
    displayName: `商品 ${index + 1}`,
    status: '待確認'
  }));

  const result = summarizeRequests(rows, '待確認');
  assert.equal(result.total, 12);
  assert.equal(result.items.length, 10);
  assert.equal(result.items[0].requestId, 'RQ-12');
  assert.equal(result.items[9].requestId, 'RQ-3');
});

test('formatStatusReply gives a compact request-level list', () => {
  const text = formatStatusReply('未結案', {
    total: 12,
    items: [{
      requestId: 'RQ-20260714-120000-abcd',
      applicant: '小明',
      itemCount: 3,
      firstItem: '很長很長的商品名稱與規格文字用來測試自動縮短顯示',
      status: '待確認'
    }]
  });

  assert.match(text, /【未結案】共 12 筆（顯示最近 10 筆）/);
  assert.match(text, /RQ-20260714-120000-abcd｜待確認｜小明｜3 項/);
  assert.match(text, /…等/);
});

test('formatStatusReply clearly reports an empty result', () => {
  assert.equal(formatStatusReply('部分到貨', { total: 0, items: [] }), '【部分到貨】目前沒有符合的補貨單。');
});
