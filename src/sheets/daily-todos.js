import { ValidationError } from '../errors.js';

export const TODO_MAX_ROWS = 20000;
export const TODO_TABLES = {
  templates: {
    name: '每日待辦範本',
    fields: ['id', 'title', 'ownerId', 'ownerName', 'enabled', 'groupId', 'updatedAt'],
    headers: ['範本編號', '任務', '負責人ID', '負責人', '啟用', '群組ID', '更新時間']
  },
  tasks: {
    name: '每日待辦紀錄',
    fields: ['id', 'date', 'templateId', 'title', 'ownerId', 'ownerName', 'status', 'completedBy', 'completedAt', 'groupId', 'createdBy', 'updatedAt'],
    headers: ['工作編號', '工作日期', '範本編號', '任務', '負責人ID', '負責人', '狀態', '完成人ID', '完成時間', '群組ID', '建立者ID', '更新時間']
  },
  deliveries: {
    name: '待辦推播紀錄',
    fields: ['id', 'groupId', 'date', 'slot', 'status', 'retryKey', 'payload', 'createdAt', 'updatedAt'],
    headers: ['推播編號', '群組ID', '日期', '時段', '狀態', '重試識別碼', '訊息快照', '建立時間', '更新時間']
  },
  operations: {
    name: '待辦操作紀錄',
    fields: ['id', 'actorId', 'groupId', 'action', 'targetId', 'at', 'result'],
    headers: ['事件編號', '操作人ID', '群組ID', '操作', '目標編號', '時間', '結果']
  }
};

export function assertTodoHeaders(values, definition) {
  if (definition.headers.some((header, index) => values[index] !== header)) {
    throw new ValidationError(`「${definition.name}」欄位不符，請先完成每日待辦初始化。`);
  }
}

// Run only inside the repository write queue. RAW writes keep task text out of formulas.
export async function loadTodoStore({ sheets, spreadsheetId }) {
  const tables = Object.entries(TODO_TABLES);
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: tables.map(([, table]) => `'${table.name}'!A1:${String.fromCharCode(64 + table.fields.length)}`),
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const state = {};
  const baselines = {};
  tables.forEach(([key, table], index) => {
    const values = response.data.valueRanges?.[index]?.values ?? [];
    assertTodoHeaders(values[0] ?? [], table);
    if (values.length > TODO_MAX_ROWS) throw new ValidationError(`「${table.name}」已達容量限制，請先封存。`);
    const ids = new Set();
    state[key] = values.slice(1).map((row, rowIndex) => {
      const item = Object.fromEntries(table.fields.map((field, i) => [field, String(row[i] ?? '')]));
      if (!item.id || ids.has(item.id)) throw new ValidationError(`「${table.name}」有空白列或重複編號，請修復後重試。`);
      if (key === 'templates' || key === 'tasks') {
        const validDate = key !== 'tasks' || (/^\d{4}-\d{2}-\d{2}$/.test(item.date)
          && !Number.isNaN(Date.parse(`${item.date}T00:00:00Z`))
          && new Date(`${item.date}T00:00:00Z`).toISOString().slice(0, 10) === item.date);
        if (!item.title.trim() || item.title.length > 100 || !item.groupId
          || (Boolean(item.ownerId) !== Boolean(item.ownerName)) || item.ownerName.length > 80
          || (key === 'templates' && !['是', '否'].includes(item.enabled))
          || (key === 'tasks' && (!validDate || !['未完成', '已完成', '取消'].includes(item.status)))) {
          throw new ValidationError(`「${table.name}」第 ${rowIndex + 2} 列資料不完整，請修復後重試。`);
        }
      }
      ids.add(item.id);
      return item;
    });
    baselines[key] = state[key].map((item) => JSON.stringify(item));
  });

  return {
    state,
    async save() {
      const data = [];
      for (const [key, table] of tables) {
        if (state[key].length >= TODO_MAX_ROWS) throw new ValidationError(`「${table.name}」已達容量限制，請先封存。`);
        state[key].forEach((item, index) => {
          if (JSON.stringify(item) === baselines[key][index]) return;
          const row = table.fields.map((field) => String(item[field] ?? ''));
          if (row.some((value) => value.length > 45000)) throw new ValidationError('待辦資料過長，無法儲存。');
          data.push({ range: `'${table.name}'!A${index + 2}`, values: [row] });
        });
      }
      if (!data.length) return;
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId, requestBody: { valueInputOption: 'RAW', data }
      });
      for (const [key] of tables) baselines[key] = state[key].map((item) => JSON.stringify(item));
    }
  };
}
