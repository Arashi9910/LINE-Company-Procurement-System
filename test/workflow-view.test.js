import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectWorkflowItems,
  workflowConfig,
  workflowItemView
} from '../public/workflow.js';

const items = [
  {
    sku: 'SKU-A', status: '待確認', unit: '件',
    requestedQuantity: 5, orderedQuantity: 0, receivedQuantity: 0, outstandingQuantity: 0
  },
  {
    sku: 'SKU-B', status: '已下單', unit: '組',
    requestedQuantity: 4, orderedQuantity: 3, receivedQuantity: 0, outstandingQuantity: 3
  },
  {
    sku: 'SKU-C', status: '部分到貨', unit: '盒',
    requestedQuantity: 6, orderedQuantity: 6, receivedQuantity: 2, outstandingQuantity: 4
  },
  {
    sku: 'SKU-D', status: '取消', unit: '件',
    requestedQuantity: 2, orderedQuantity: 0, receivedQuantity: 0, outstandingQuantity: 0
  }
];

test('workflow config exposes detail as a read-only mode without roles or submit action', () => {
  assert.deepEqual(workflowConfig('detail'), {
    title: '補貨單明細',
    allowedRoles: [],
    authorizationMessage: '',
    submitLabel: '',
    emptyMessage: '此補貨單沒有品項',
    readOnly: true
  });
  assert.equal(workflowConfig('unknown'), null);
});

test('workflow item selection preserves existing order and receipt rules and shows every detail row', () => {
  assert.deepEqual(selectWorkflowItems(items, 'order').map((item) => item.sku), ['SKU-A']);
  assert.deepEqual(selectWorkflowItems(items, 'receipt').map((item) => item.sku), ['SKU-B', 'SKU-C']);
  assert.deepEqual(selectWorkflowItems(items, 'detail').map((item) => item.sku), [
    'SKU-A', 'SKU-B', 'SKU-C', 'SKU-D'
  ]);
});

test('detail item view reports status and every quantity without editable fields', () => {
  const view = workflowItemView({
    sku: 'SKU-C', status: '部分到貨', unit: '盒',
    requestedQuantity: 6, orderedQuantity: 6, receivedQuantity: 2
  }, 'detail');

  assert.equal(view.readOnly, true);
  assert.equal(view.meta, '狀態：部分到貨｜申請 6 盒｜下單 6 盒｜已到 2 盒');
});

test('order and receipt item views remain editable and retain their existing summaries', () => {
  assert.deepEqual(workflowItemView(items[0], 'order'), {
    readOnly: false,
    meta: '申請 5 件｜SKU-A'
  });
  assert.deepEqual(workflowItemView(items[2], 'receipt'), {
    readOnly: false,
    meta: '已到 2/6 盒｜尚缺 4'
  });
  assert.deepEqual(workflowItemView({ ...items[0], requestedQuantity: 0 }, 'order', {
    purchaseAdded: true
  }), {
    readOnly: false,
    meta: '原申請未包含｜SKU-A'
  });
});
