import test from 'node:test';
import assert from 'node:assert/strict';
import { mutateDraft, readDraft, draftOverview, normalizeDraftItems } from '../src/services/purchase-drafts.js';
import { reconcileDraftItems } from '../public/purchase-drafts.js';
import { purchaseFixture } from './helpers/purchase-fixture.js';
import { SheetsRepository } from '../src/sheets/repository.js';
import { getRequestDetails } from '../src/services/workflow.js';
import { initializePurchaseDrafts } from '../scripts/setup-purchase-drafts.mjs';
import { summarizeRequests, parseGroupCommand } from '../src/services/group-commands.js';

const actor = { userId: 'boss', displayName: '老闆' };
const id = `D-${'a'.repeat(32)}`;
let sequence = 0;
function input(action, extra = {}) { return { actor, id, action, idempotencyKey: `operation_${String(++sequence).padStart(16, '0')}`, ...extra }; }
const create = (repository, extra = {}) => mutateDraft(input('create', { sourceIds: ['RQ-1', 'RQ-2'], ...extra }), repository);

test('merge, persist across repository restart, update catalog, save and submit in one batch', async () => {
  const f = purchaseFixture();
  let draft = await create(f.repository);
  assert.deepEqual(draft.items.map(item => [item.sku, item.quantity]), [['A', 5], ['B', 4]]);
  assert.equal(f.cells['補貨追蹤'][1][6], '待確認');
  assert.equal((await draftOverview(actor, f.repository)).sources[0].reserved, true);
  const restarted = new SheetsRepository({ sheets: f.sheets, spreadsheetId: 'test', purchaseDraftsEnabled: true });
  assert.equal((await readDraft({ actor, id }, restarted)).items[0].quantity, 5);
  f.cells['SKU主檔'][1][7] = '商品 A 新名稱';
  draft = await mutateDraft(input('save', { version: draft.version, items: [{ sku: 'A', quantity: 8 }], note: '調整後', expectedDate: '2026-10-02' }), f.repository);
  assert.equal(draft.items[0].displayName, '商品 A 新名稱');
  const before = f.writes();
  const submit = input('submit', { version: draft.version });
  const result = await mutateDraft(submit, f.repository);
  assert.equal(f.writes(), before + 1);
  assert.equal(result.items[0].orderedQuantity, 8);
  assert.equal(result.items[0].requestedQuantity, 0);
  assert.deepEqual(f.cells['補貨追蹤'].slice(1, 4).map(row => row[6]), ['已轉單', '已轉單', '已轉單']);
  assert.equal((await f.repository.listOpenRequests()).length, 1);
  const rows = await f.repository.listRequestRows();
  const summary = summarizeRequests(rows, '已轉單');
  assert.equal(summary.items.length, 2);
  assert.equal(summarizeRequests(rows, '未結案').items.length, 1);
  assert.equal(parseGroupCommand({ type: 'text', text: '查已轉單' }).status, '已轉單');
  assert.equal((await f.repository.listReminderCandidates({ at: new Date('2026-09-29') })).length, 0);
  const detail = await getRequestDetails({ actor, requestId: 'RQ-1' }, f.repository);
  assert.equal(detail.transfers[0].targetId, result.requestId);
  assert.equal((await mutateDraft(submit, f.repository)).idempotentReplay, true);
  assert.equal(f.writes(), before + 1);
  await assert.rejects(f.repository.confirmReceipt({ actor, requestId: 'RQ-1', items: [{ sku: 'A', receivedQuantity: 1 }], idempotencyKey: 'receipt_long_key_123' }), /下單|到貨/);
});

test('reservations block legacy order/cancel, simultaneous transfer, and release on discard', async () => {
  const f = purchaseFixture();
  const results = await Promise.allSettled([create(f.repository), create(f.repository, { id: `D-${'b'.repeat(32)}` })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await assert.rejects(f.repository.confirmOrder({ actor, requestId: 'RQ-1', items: [], idempotencyKey: 'long_order_key_123' }), /草稿/);
  await assert.rejects(f.repository.cancelRequest({ actor, requestId: 'RQ-1', idempotencyKey: 'long_cancel_key_123' }), /草稿/);
  const draft = results.find(result => result.status === 'fulfilled').value;
  await mutateDraft(input('discard', { id: draft.id, version: draft.version }), f.repository);
  assert.equal((await draftOverview(actor, f.repository)).sources[0].reserved, false);
  assert.equal((await create(f.repository, { id: `D-${'c'.repeat(32)}` })).items[0].quantity, 5);
});

test('save failure preserves persisted data and retry is idempotent; stale editor cannot overwrite', async () => {
  const f = purchaseFixture();
  const draft = await create(f.repository);
  const save = input('save', { version: draft.version, items: [{ sku: 'A', quantity: 7 }], expectedDate: '', note: '測試' });
  f.failNext();
  await assert.rejects(mutateDraft(save, f.repository), /network/);
  assert.equal((await readDraft({ actor, id }, f.repository)).items[0].quantity, 5);
  await mutateDraft(save, f.repository);
  const before = f.writes();
  assert.equal((await mutateDraft(save, f.repository)).idempotentReplay, true);
  assert.equal(f.writes(), before);
  await assert.rejects(mutateDraft(input('save', { ...save, idempotencyKey: 'different_long_key' }), f.repository), /變更/);
});

test('unavailable source SKU persists for editing, but cannot be submitted; catalog mapping never swaps SKU', async () => {
  const f = purchaseFixture();
  f.cells['SKU主檔'][1][9] = '否';
  let draft = await create(f.repository);
  draft = await mutateDraft(input('save', { version: draft.version, items: draft.items, expectedDate: '2026-10-01' }), f.repository);
  const before = f.writes();
  await assert.rejects(mutateDraft(input('submit', { version: draft.version }), f.repository), /停用/);
  assert.equal(f.writes(), before);
  const mapped = reconcileDraftItems(draft.items, [{ sku: 'C', displayName: '商品 A' }]);
  assert.equal(mapped[0].item.sku, 'A');
  assert.equal(mapped[0].item.unavailable, true);
  assert.equal(mapped[0].quantity, 5);
});

test('role, ownership, source state, quantities and dates are validated without writes', async () => {
  const f = purchaseFixture();
  await assert.rejects(create(f.repository, { actor: { userId: 'employee' } }), /權限/);
  let draft = await create(f.repository);
  await assert.rejects(readDraft({ actor: { userId: 'other' }, id }, f.repository), /自己/);
  await assert.rejects(mutateDraft(input('save', { version: 1, items: [], expectedDate: '2026-02-30' }), f.repository), /日期|到貨日/);
  assert.throws(() => normalizeDraftItems([{ sku: 'A', quantity: 1.5 }]), /數量/);
  assert.throws(() => normalizeDraftItems([{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 2 }]), /重複/);
  assert.throws(() => normalizeDraftItems(Array.from({ length: 51 }, (_, i) => ({ sku: String(i), quantity: 1 }))), /50/);
  draft = await mutateDraft(input('save', { version: draft.version, items: draft.items, expectedDate: '2026-10-01' }), f.repository);
  f.cells['補貨追蹤'][1][6] = '取消';
  const before = f.writes();
  await assert.rejects(mutateDraft(input('submit', { version: draft.version }), f.repository), /來源需求/);
  assert.equal(f.writes(), before);
});

test('creation retry and submit write failure never duplicate or partially close source requests', async () => {
  const f = purchaseFixture();
  const command = input('create', { sourceIds: ['RQ-1'] });
  const first = await mutateDraft(command, f.repository);
  assert.equal((await mutateDraft(command, f.repository)).idempotentReplay, true);
  const saved = await mutateDraft(input('save', { version: first.version, items: first.items, expectedDate: '2026-10-01' }), f.repository);
  const submit = input('submit', { version: saved.version });
  f.failNext();
  await assert.rejects(mutateDraft(submit, f.repository), /network/);
  assert.equal(f.cells['補貨追蹤'][1][6], '待確認');
  assert.equal((await readDraft({ actor, id }, f.repository)).status, '編輯中');
  await mutateDraft(submit, f.repository);
  assert.equal(f.cells['補貨追蹤'][1][6], '已轉單');
});

test('saving one draft does not erase another draft and omitted items remain omitted after reopen', async () => {
  const f = purchaseFixture();
  const one = await create(f.repository, { sourceIds: [], items: [{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 2 }] });
  const two = await create(f.repository, { id: `D-${'b'.repeat(32)}`, sourceIds: [], items: [{ sku: 'B', quantity: 9 }] });
  await mutateDraft(input('save', { version: one.version, items: [] }), f.repository);
  assert.equal((await readDraft({ actor, id }, f.repository)).items.length, 0);
  assert.equal((await readDraft({ actor, id: two.id }, f.repository)).items[0].quantity, 9);
});

test('initializer creates three sheets in one batch and refuses conflicting headers', async () => {
  const writes = [];
  const sheets = { spreadsheets: { get: async () => ({ data: { sheets: [] } }), batchUpdate: async input => writes.push(input) } };
  await initializePurchaseDrafts({ sheets, spreadsheetId: 'test' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].requestBody.requests.filter(request => request.addSheet).length, 3);
  sheets.spreadsheets.get = async () => ({ data: { sheets: [{ properties: { title: '採購草稿', sheetId: 1 } }] } });
  sheets.spreadsheets.values = { get: async () => ({ data: { values: [['unexpected']] } }) };
  await assert.rejects(initializePurchaseDrafts({ sheets, spreadsheetId: 'test' }), /欄位不符/);
  assert.equal(writes.length, 1);
});
