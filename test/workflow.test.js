import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmOrder, confirmReceipt, getRequestDetails } from '../src/services/workflow.js';

function repository(role) {
  const calls = [];
  return {
    calls,
    async getAuthorization() { return { role, enabled: true }; },
    async getRequest(id) { return { requestId: id, items: [] }; },
    async confirmOrder(input) { calls.push(input); return { requestId: input.requestId }; },
    async confirmReceipt(input) { calls.push(input); return { requestId: input.requestId }; }
  };
}

test('getRequestDetails includes the current actor role', async () => {
  const repo = repository('採購確認');
  const result = await getRequestDetails({ actor: { userId: 'U1' }, requestId: 'RQ-1' }, repo);
  assert.equal(result.actorRole, '採購確認');
});

test('request images match effective SKU without changing quantities or requiring an available catalog item', async () => {
  const repo = repository('到貨確認');
  repo.getRequest = async () => ({ requestId: 'RQ-1', items: [
    { sku: 'corrected', originalSku: 'old', outstandingQuantity: 3 },
    { sku: 'missing', outstandingQuantity: 1 }
  ] });
  repo.listProductImages = async () => [
    { sku: 'old', variantImageUrl: 'https://example.com/wrong.jpg' },
    { sku: 'corrected', variantImageUrl: 'https://example.com/right.jpg', mainImageUrl: 'https://example.com/main.jpg' }
  ];
  const result = await getRequestDetails({ actor: { userId: 'U1' }, requestId: 'RQ-1' }, repo);
  assert.equal(result.items[0].variantImageUrl, 'https://example.com/right.jpg');
  assert.equal(result.items[0].outstandingQuantity, 3);
  assert.equal(result.items[1].variantImageUrl, '');
  repo.listProductImages = async () => { throw new Error('image sheet unavailable'); };
  const fallback = await getRequestDetails({ actor: { userId: 'U1' }, requestId: 'RQ-1' }, repo);
  assert.equal(fallback.items[0].outstandingQuantity, 3);
  assert.equal(fallback.items[0].variantImageUrl, '');
});

test('confirmOrder enforces role, quantity, date and normalizes items', async () => {
  const denied = repository('申請人');
  await assert.rejects(confirmOrder({
    actor: { userId: 'U1' }, requestId: 'RQ-1', items: [{ sku: 'A', orderedQuantity: 1, expectedDate: '2026-07-15' }], idempotencyKey: 'abcdefghijklmnop'
  }, denied), /權限/);

  const allowed = repository('採購確認');
  await confirmOrder({
    actor: { userId: 'U1' }, requestId: 'RQ-1', items: [
      { sku: ' A ', orderedQuantity: 2, expectedDate: '2026-07-15' },
      { sku: 'B', orderedQuantity: 0, expectedDate: 'not-used' }
    ], idempotencyKey: 'abcdefghijklmnop'
  }, allowed);
  assert.deepEqual(allowed.calls[0].items, [
    { sku: 'A', orderedQuantity: 2, expectedDate: '2026-07-15' },
    { sku: 'B', orderedQuantity: 0, expectedDate: '' }
  ]);

  await assert.rejects(confirmOrder({
    actor: { userId: 'U1' },
    requestId: 'RQ-1',
    items: Array.from({ length: 51 }, (_, index) => ({
      sku: `SKU-${index}`,
      orderedQuantity: 1,
      expectedDate: '2026-07-15'
    })),
    idempotencyKey: 'order-too-many-1234'
  }, allowed), /最多可下單 50 個品項/);

  await assert.rejects(confirmOrder({
    actor: { userId: 'U1' },
    requestId: 'RQ-1',
    items: [{ sku: 'A', orderedQuantity: 1000000, expectedDate: '2026-07-15' }],
    idempotencyKey: 'order-too-large-123'
  }, allowed), /不可超過 999999/);
});

test('confirmReceipt skips zero quantities and requires at least one received item', async () => {
  const allowed = repository('到貨確認');
  await confirmReceipt({
    actor: { userId: 'U1' }, requestId: 'RQ-1', items: [
      { sku: 'A', receivedQuantity: 3 },
      { sku: 'B', receivedQuantity: 0 }
    ], idempotencyKey: 'abcdefghijklmnop'
  }, allowed);
  assert.deepEqual(allowed.calls[0].items, [{ sku: 'A', receivedQuantity: 3 }]);

  await assert.rejects(confirmReceipt({
    actor: { userId: 'U1' }, requestId: 'RQ-1', items: [{ sku: 'A', receivedQuantity: 0 }], idempotencyKey: 'abcdefghijklmnop'
  }, allowed), /至少需要一個本次到貨量大於 0/);

  await assert.rejects(confirmReceipt({
    actor: { userId: 'U1' }, requestId: 'RQ-1', items: [{ sku: 'A', receivedQuantity: -1 }], idempotencyKey: 'abcdefghijklmnop'
  }, allowed), /0 或正整數/);
});
