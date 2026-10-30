import { SheetsRepository } from '../../src/sheets/repository.js';
import { DRAFT_TABLES } from '../../src/sheets/purchase-drafts.js';

export function purchaseFixture() {
  const cells = Object.fromEntries(Object.values(DRAFT_TABLES).map(table => [table.name, [table.headers]]));
  cells['SKU主檔'] = [[], ['A', '商品 A', '', '', '', '', '', '商品 A', '', '是'], ['B', '商品 B', '', '', '', '', '', '商品 B', '', '是']];
  cells['補貨追蹤'] = [[]];
  cells['操作紀錄'] = [[]];
  cells['授權人員'] = [[], ['boss', '老闆', '採購確認', '是'], ['other', '另一位', '管理員', '是']];
  cells['系統設定'] = [[], ['NOTIFICATION_GROUP_ID', 'group']];
  function source(id, sku, quantity) {
    cells['補貨追蹤'].push([id, 46000, '員工', `商品 ${sku}`, '件', quantity, '待確認', 0, '', 0, 0, '', '員工備註', sku, 'employee', 'group']);
  }
  source('RQ-1', 'A', 2); source('RQ-2', 'A', 3); source('RQ-2', 'B', 4);
  const column = value => [...value].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
  function parse(range) {
    const match = /^'([^']+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d*)?)?$/.exec(range);
    if (!match) throw new Error(`Unsupported range: ${range}`);
    return { name: match[1], left: column(match[2]), top: Number(match[3]) - 1,
      right: column(match[4] || match[2]), bottom: match[5] ? Number(match[5]) - 1 : (match[4] ? (cells[match[1]]?.length ?? 0) - 1 : Number(match[3]) - 1) };
  }
  function read(range) {
    const { name, left, top, right, bottom } = parse(range);
    const rows = cells[name] ?? [];
    const values = rows.slice(top, bottom + 1).map(row => (row ?? []).slice(left, right + 1));
    while (values.length && !values.at(-1).some(value => value !== '' && value != null)) values.pop();
    return values;
  }
  let failure = false;
  let calls = 0;
  const sheets = { spreadsheets: { values: {
    async get({ range }) { return { data: { values: read(range) } }; },
    async batchGet({ ranges }) { return { data: { valueRanges: ranges.map(range => ({ values: read(range) })) } }; },
    async batchUpdate({ requestBody }) {
      if (failure) { failure = false; throw new Error('simulated network failure'); }
      calls += 1;
      for (const entry of requestBody.data) {
        const { name, left, top } = parse(entry.range);
        cells[name] ??= [];
        entry.values.forEach((row, i) => {
          cells[name][top + i] ??= [];
          row.forEach((value, j) => { cells[name][top + i][left + j] = value; });
        });
      }
      return { data: {} };
    }
  } } };
  let sequence = 0;
  const repository = new SheetsRepository({ sheets, spreadsheetId: 'test', purchaseDraftsEnabled: true,
    now: () => new Date('2026-09-29T04:00:00Z'), uuid: () => `${String(++sequence).padStart(4, '0')}-test` });
  return { repository, cells, sheets, source, failNext: () => { failure = true; }, writes: () => calls };
}
