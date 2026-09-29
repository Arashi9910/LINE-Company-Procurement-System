import { ConflictError, ValidationError } from '../errors.js';

export const DRAFT_MAX_ROWS = 20000;
export const DRAFT_TABLES = {
  drafts: {
    name: '採購草稿',
    fields: ['id', 'ownerId', 'status', 'note', 'expectedDate', 'version', 'createdAt', 'updatedAt', 'requestId', 'lastKey', 'lastAction', 'groupId'],
    headers: ['草稿ID', '擁有人LINE ID', '狀態', '備註', '預計到貨日', '版本', '建立時間', '更新時間', '正式單號', '最後操作金鑰', '最後操作', '群組ID']
  },
  items: {
    name: '採購草稿品項',
    fields: ['draftId', 'sku', 'displayName', 'unit', 'quantity'],
    headers: ['草稿ID', 'SKU', '商品名稱快照', '單位快照', '數量']
  },
  links: {
    name: '轉單關聯',
    fields: ['draftId', 'sourceId', 'requestId', 'status', 'createdAt', 'updatedAt'],
    headers: ['草稿ID', '來源單號', '正式單號', '狀態', '建立時間', '更新時間']
  }
};

export function assertDraftHeaders(row, table) {
  if (table.headers.some((header, index) => row[index] !== header)) {
    throw new ValidationError(`「${table.name}」欄位不符，請先完成採購草稿初始化`);
  }
}

// Mutations must run inside the same repository queue as orders and cancellations.
export async function loadDraftStore({ sheets, spreadsheetId }) {
  const tables = Object.entries(DRAFT_TABLES);
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: tables.map(([, table]) => `'${table.name}'!A1:${String.fromCharCode(64 + table.fields.length)}${DRAFT_MAX_ROWS}`),
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const state = {};
  const baseline = {};
  tables.forEach(([key, table], index) => {
    const rows = response.data.valueRanges?.[index]?.values ?? [];
    assertDraftHeaders(rows[0] ?? [], table);
    state[key] = rows.slice(1).map(row => Object.fromEntries(table.fields.map((field, i) => [field, String(row[i] ?? '')])));
    baseline[key] = state[key].map(item => table.fields.map(field => item[field] ?? ''));
    const seen = new Set();
    for (const item of state[key]) {
      const id = key === 'drafts' ? item.id : `${item.draftId}/${key === 'items' ? item.sku : item.sourceId}`;
      if (!(item.id || item.draftId)) continue;
      if (seen.has(id)) throw new ValidationError(`「${table.name}」存在重複資料，請先修復`);
      seen.add(id);
    }
  });
  return {
    ...state,
    async flush(extra = []) {
      const data = [...extra];
      for (const [key, table] of tables) {
        if (state[key].length >= DRAFT_MAX_ROWS) throw new ConflictError(`「${table.name}」已滿，請先封存`);
        const size = Math.max(state[key].length, baseline[key].length);
        for (let i = 0; i < size; i += 1) {
          const values = table.fields.map(field => state[key][i]?.[field] ?? '');
          if (JSON.stringify(values) === JSON.stringify(baseline[key][i])) continue;
          data.push({ range: `'${table.name}'!A${i + 2}:${String.fromCharCode(64 + table.fields.length)}${i + 2}`, values: [values] });
        }
      }
      if (data.length) await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId, requestBody: { valueInputOption: 'RAW', data }
      });
    }
  };
}

export function assertSourceUnreserved(store, requestId) {
  if (store.links.some(link => link.sourceId === requestId && link.status === '保留中')) {
    throw new ConflictError('此需求已加入採購草稿，請先捨棄該草稿再直接下單或取消');
  }
}
