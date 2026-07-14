import test from 'node:test';
import assert from 'node:assert/strict';
import { listSearchableSkus, submitRequest } from '../src/services/requests.js';

test('listSearchableSkus adds open request counts', async () => {
  const repository = {
    async listAvailableSkus() {
      return [{ sku: 'A', displayName: '商品 A' }, { sku: 'B', displayName: '商品 B' }];
    },
    async listOpenRequests() {
      return [{ sku: 'A' }, { sku: 'A' }, { sku: 'UNKNOWN' }];
    },
    async listProductImages() {
      return [{
        sku: 'A',
        productId: 'P1',
        productCode: 'SALE-1',
        productName: '商品 A 新名稱',
        variantName: '紅色',
        mainImageUrl: 'https://img.example/main.jpg',
        variantImageUrl: 'https://img.example/red.jpg',
        listImageUrl: 'https://img.example/list.jpg',
        imageStatus: '正常',
        bindingStatus: '已綁定'
      }];
    }
  };

  const result = await listSearchableSkus(repository);
  assert.deepEqual(result.map((item) => item.openCount), [2, 0]);
  assert.equal(result[0].productName, '商品 A 新名稱');
  assert.equal(result[0].productCode, 'SALE-1');
  assert.equal(result[0].variantImageUrl, 'https://img.example/red.jpg');
  assert.equal(result[1].mainImageUrl, '');
});

test('submitRequest normalizes and forwards a valid multi-item request', async () => {
  let received;
  const repository = {
    async createRequest(input) {
      received = input;
      return { requestId: 'RQ-1', items: input.items };
    }
  };

  const result = await submitRequest({
    actor: { userId: 'U123', displayName: ' 小明 ' },
    items: [{ sku: ' SKU-A ', quantity: 2 }, { sku: 'SKU-B', quantity: 3 }],
    note: ' 缺貨 ',
    groupId: 'C123',
    idempotencyKey: 'abcdefghijklmnop'
  }, repository);

  assert.equal(result.requestId, 'RQ-1');
  assert.equal(received.actor.displayName, '小明');
  assert.deepEqual(received.items, [
    { sku: 'SKU-A', quantity: 2 },
    { sku: 'SKU-B', quantity: 3 }
  ]);
  assert.equal(received.note, '缺貨');
});

test('submitRequest rejects duplicate SKUs and invalid quantities', async () => {
  const repository = { createRequest: () => assert.fail('should not write') };

  await assert.rejects(
    submitRequest({
      actor: { userId: 'U123' },
      items: [{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 2 }],
      idempotencyKey: 'abcdefghijklmnop'
    }, repository),
    /重複/
  );

  await assert.rejects(
    submitRequest({
      actor: { userId: 'U123' },
      items: [{ sku: 'A', quantity: 0 }],
      idempotencyKey: 'abcdefghijklmnop'
    }, repository),
    /正整數/
  );
});

test('submitRequest requires a verified LINE actor and operation key', async () => {
  const repository = { createRequest: () => assert.fail('should not write') };
  await assert.rejects(
    submitRequest({ items: [{ sku: 'A', quantity: 1 }] }, repository),
    /LINE 身分/
  );
  await assert.rejects(
    submitRequest({ actor: { userId: 'U123' }, items: [{ sku: 'A', quantity: 1 }] }, repository),
    /操作金鑰/
  );
});
