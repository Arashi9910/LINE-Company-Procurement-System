const STATUS_COMMANDS = new Map([
  ['查未結案', '未結案'],
  ['查待確認', '待確認'],
  ['查已下單', '已下單'],
  ['查部分到貨', '部分到貨'],
  ['查已完成', '已完成'],
  ['查取消', '取消']
]);

const OPEN_STATUSES = new Set(['待確認', '已下單', '部分到貨']);
const TERMINAL_STATUSES = new Set(['已完成', '取消']);

export const GROUP_COMMAND_HELP = [
  '【補貨指令】',
  '查未結案｜查待確認｜查已下單',
  '查部分到貨｜查已完成｜查取消',
  '',
  '管理員指令：',
  '授權 @成員 申請人／採購確認／到貨確認／管理員',
  '停用 @成員',
  '查權限 @成員'
].join('\n');

export function parseGroupCommand(message) {
  if (message?.type !== 'text') return null;
  const text = message.text.trim();
  if (STATUS_COMMANDS.has(text)) return { type: 'status', status: STATUS_COMMANDS.get(text) };
  if (text === '補貨指令') return { type: 'help' };
  return null;
}

function aggregateStatus(rows) {
  const statuses = rows.map((row) => row.status);
  if (statuses.every((status) => status === '取消')) return '取消';
  if (statuses.every((status) => TERMINAL_STATUSES.has(status))
    && statuses.some((status) => status === '已完成')) return '已完成';
  if (statuses.includes('部分到貨')
    || (statuses.includes('已完成') && statuses.some((status) => !TERMINAL_STATUSES.has(status)))) {
    return '部分到貨';
  }
  if (statuses.includes('待確認')) return '待確認';
  return '已下單';
}

function sortValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const timestamp = Date.parse(String(value ?? ''));
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function summarizeRequests(rows, filter, limit = 10) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.requestId) continue;
    const group = groups.get(row.requestId) ?? [];
    group.push(row);
    groups.set(row.requestId, group);
  }

  const matching = [...groups.entries()]
    .map(([requestId, items]) => ({
      requestId,
      requestedAt: items[0].requestedAt,
      applicant: items[0].applicant,
      firstItem: items[0].displayName,
      itemCount: items.length,
      status: aggregateStatus(items)
    }))
    .filter((request) => filter === '未結案'
      ? OPEN_STATUSES.has(request.status)
      : request.status === filter)
    .sort((left, right) => sortValue(right.requestedAt) - sortValue(left.requestedAt));

  return { total: matching.length, items: matching.slice(0, limit) };
}

function compactName(value, maxLength = 18) {
  const name = String(value || '未命名商品');
  return name.length > maxLength ? `${name.slice(0, maxLength)}…` : name;
}

export function formatStatusReply(filter, result) {
  if (result.total === 0) return `【${filter}】目前沒有符合的補貨單。`;
  const shown = Math.min(result.total, 10);
  const header = result.total > 10
    ? `【${filter}】共 ${result.total} 筆（顯示最近 ${shown} 筆）`
    : `【${filter}】共 ${result.total} 筆`;
  const lines = result.items.flatMap((item, index) => [
    `${index + 1}. ${item.requestId}｜${item.status}｜${item.applicant || '未知申請人'}｜${item.itemCount} 項`,
    `   ${compactName(item.firstItem)}${item.itemCount > 1 ? '等' : ''}`
  ]);
  return [header, ...lines].join('\n');
}
