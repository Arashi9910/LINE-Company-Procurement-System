import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  ValidationError
} from '../errors.js';

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
const AUTHORIZATION_ROLES = ['申請人', '採購確認', '到貨確認', '管理員'];

export const GROUP_COMMAND_HELP = [
  '【補貨指令】',
  '查未結案｜查待確認｜查已下單',
  '查部分到貨｜查已完成｜查取消',
  '取消補貨 <補貨單號>',
  '取消採購 <補貨單號>',
  '',
  '管理員指令：',
  '同步飛鼠商品',
  '查飛鼠同步',
  '授權 @成員 申請人／採購確認／到貨確認／管理員',
  '停用 @成員',
  '查權限 @成員'
].join('\n');

export function parseGroupCommand(message) {
  if (message?.type !== 'text') return null;
  const text = message.text.trim();
  if (STATUS_COMMANDS.has(text)) return { type: 'status', status: STATUS_COMMANDS.get(text) };
  if (text === '補貨指令') return { type: 'help' };
  if (text === '同步飛鼠商品') return { type: 'catalog-sync', action: 'start' };
  if (text === '查飛鼠同步') return { type: 'catalog-sync', action: 'status' };

  const cancellationMatch = /^取消補貨\s+(RQ-\d{8}-\d{6}-[0-9a-f]{4})$/i.exec(text);
  if (cancellationMatch) {
    const requestId = cancellationMatch[1];
    return {
      type: 'cancellation',
      requestId: `${requestId.slice(0, -4).toUpperCase()}${requestId.slice(-4).toLowerCase()}`
    };
  }
  if (/^取消補貨(?:\s|$)/.test(text)) {
    return { type: 'cancellation-error', reason: 'invalid-syntax' };
  }

  const orderedCancellationMatch = /^取消採購\s+(RQ-\d{8}-\d{6}-[0-9a-f]{4})$/i.exec(text);
  if (orderedCancellationMatch) {
    const requestId = orderedCancellationMatch[1];
    return {
      type: 'cancellation',
      requestId: `${requestId.slice(0, -4).toUpperCase()}${requestId.slice(-4).toLowerCase()}`,
      mode: 'ordered'
    };
  }
  if (/^取消採購(?:\s|$)/.test(text)) {
    return { type: 'cancellation-error', reason: 'invalid-syntax', mode: 'ordered' };
  }

  let action;
  let role;
  const grantMatch = /^授權\s+.+\s+(申請人|採購確認|到貨確認|管理員)$/.exec(text);
  if (grantMatch) {
    action = 'grant';
    role = grantMatch[1];
  } else if (/^停用\s+.+$/.test(text)) {
    action = 'disable';
  } else if (/^查權限\s+.+$/.test(text)) {
    action = 'query';
  } else if (/^(授權|停用|查權限)(\s|$)/.test(text)) {
    return { type: 'authorization-error', reason: 'invalid-syntax' };
  } else {
    return null;
  }

  const targets = (message.mention?.mentionees ?? [])
    .filter((mentionee) => mentionee.type === 'user' && !mentionee.isSelf);
  if (targets.length > 1) return { type: 'authorization-error', reason: 'multiple-targets' };
  if (targets.length === 0) return { type: 'authorization-error', reason: 'invalid-syntax' };
  if (!targets[0].userId) return { type: 'authorization-error', reason: 'missing-user-id' };
  const mentionStart = Number(targets[0].index);
  const mentionLength = Number(targets[0].length);
  const targetDisplayName = Number.isInteger(mentionStart) && Number.isInteger(mentionLength)
    ? text.slice(mentionStart, mentionStart + mentionLength).replace(/^@/, '').trim()
    : '';
  return {
    type: 'authorization',
    action,
    ...(role ? { role } : {}),
    targetUserId: targets[0].userId,
    ...(targetDisplayName ? { targetDisplayName } : {})
  };
}

export async function executeCancellationCommand(input, { repository, messenger }) {
  const { command, actorUserId, groupId, idempotencyKey } = input;
  if (command.type === 'cancellation-error') {
    const commandName = command.mode === 'ordered' ? '取消採購' : '取消補貨';
    return `指令格式不正確。可用格式：${commandName} RQ-20260715-123456-abcd`;
  }
  if (!actorUserId) {
    throw new AuthenticationError('LINE 未提供你的使用者識別資料，無法取消補貨單。');
  }

  const [request, authorization] = await Promise.all([
    repository.getRequestForCancellation(command.requestId),
    repository.getAuthorization(actorUserId)
  ]);
  if (request.groupId && request.groupId !== groupId) {
    throw new AuthorizationError('此補貨單不屬於目前群組。');
  }
  const isApplicant = request.requesterUserId === actorUserId;
  const isEnabledAdmin = authorization.enabled && authorization.role === '管理員';
  const isOrderedCancellation = command.mode === 'ordered';
  const canCancelOrdered = authorization.enabled
    && ['採購確認', '管理員'].includes(authorization.role);
  if (isOrderedCancellation && !canCancelOrdered) {
    throw new AuthorizationError('只有已啟用的採購確認或管理員可以取消已下單補貨單。');
  }
  if (!isOrderedCancellation && !isApplicant && !isEnabledAdmin) {
    throw new AuthorizationError('只有原申請人或已啟用的管理員可以取消補貨單。');
  }

  const result = await repository.cancelRequest({
    actor: { userId: actorUserId },
    requestId: command.requestId,
    idempotencyKey,
    ...(isOrderedCancellation ? { mode: 'ordered' } : {})
  });
  let displayName = 'LINE 成員';
  try {
    const profile = await messenger.getGroupMemberProfile(groupId, actorUserId);
    displayName = String(profile?.displayName || displayName);
  } catch {
    // 取消已完成，不因顯示名稱查詢失敗而回報操作失敗。
  }
  return [
    `${isOrderedCancellation ? '已取消採購單' : '已取消補貨單'} ${result.requestId}`,
    `操作人：${displayName}`,
    `共 ${result.items.length} 項`,
    ...(isOrderedCancellation
      ? ['注意：此操作只取消補貨系統紀錄；採購平台上的訂單仍需另外取消。']
      : []),
    ...(result.idempotentReplay ? ['（此事件已處理過，未重複寫入）'] : [])
  ].join('\n');
}

function formatCatalogSyncTime(value) {
  if (!value) return '尚未提供';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '尚未提供';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(timestamp));
}

function formatCatalogSyncStatus(status) {
  if (status.state === 'never') return '尚未有飛鼠商品同步紀錄。';
  const execution = status.execution || '尚未提供';
  if (status.state === 'running') {
    return [
      '飛鼠商品同步執行中',
      `執行編號：${execution}`,
      `開始時間：${formatCatalogSyncTime(status.startedAt || status.createdAt)}`
    ].join('\n');
  }
  const succeeded = status.state === 'succeeded';
  return [
    `最近一次飛鼠商品同步${succeeded ? '成功' : '失敗'}`,
    `執行編號：${execution}`,
    `完成時間：${formatCatalogSyncTime(status.completedAt)}`,
    ...(!succeeded ? ['請查看 Cloud Run Job 日誌後再重試。'] : [])
  ].join('\n');
}

export async function executeCatalogSyncCommand(input, { repository, catalogSyncRunner }) {
  const { command, actorUserId, idempotencyKey } = input;
  if (!actorUserId) {
    throw new AuthenticationError('LINE 未提供你的使用者識別資料，無法操作飛鼠商品同步。');
  }
  const authorization = await repository.getAuthorization(actorUserId);
  if (!authorization.enabled || authorization.role !== '管理員') {
    throw new AuthorizationError('只有已啟用的管理員可以操作飛鼠商品同步。');
  }
  if (!catalogSyncRunner) {
    throw new AppError('飛鼠商品同步服務尚未設定', {
      code: 'CATALOG_SYNC_UNAVAILABLE',
      status: 503
    });
  }

  if (command.action === 'status') {
    return formatCatalogSyncStatus(await catalogSyncRunner.status());
  }
  if (!idempotencyKey) {
    throw new ValidationError('LINE 事件缺少識別碼，請重新送出「同步飛鼠商品」。');
  }

  const reservation = await repository.reserveCatalogSyncTrigger({
    actor: { userId: actorUserId },
    idempotencyKey
  });
  if (reservation.idempotentReplay) {
    return '這筆飛鼠商品同步指令已受理過，未重複啟動。\n請輸入「查飛鼠同步」查看狀態。';
  }

  const result = await catalogSyncRunner.start();
  return [
    '已受理飛鼠商品同步。',
    ...(result.execution ? [`執行編號：${result.execution}`] : []),
    ...(result.operation && !result.execution ? [`操作編號：${result.operation}`] : []),
    '請稍後輸入「查飛鼠同步」查看結果。'
  ].join('\n');
}

function authorizationErrorMessage(reason) {
  if (reason === 'missing-user-id') {
    return 'LINE 尚未提供這位成員的識別資料。請確認對方目前有使用手機版 LINE；若仍無法取得，請改到「授權人員」工作表設定。';
  }
  if (reason === 'multiple-targets') return '一次只能設定一位成員，請只 @一位成員 後重試。';
  return `指令格式不正確。可用格式：\n授權 @成員 ${AUTHORIZATION_ROLES.join('／')}\n停用 @成員\n查權限 @成員`;
}

export async function executeAuthorizationCommand(input, { repository, messenger }) {
  const { command, actorUserId, groupId, idempotencyKey } = input;
  if (command.type === 'authorization-error') return authorizationErrorMessage(command.reason);
  if (!actorUserId) {
    throw new AuthenticationError('LINE 未提供你的使用者識別資料。請確認你目前有使用手機版 LINE；若仍失敗，請改用「授權人員」工作表。');
  }

  const actorAuthorization = await repository.getAuthorization(actorUserId);
  if (!actorAuthorization.enabled || actorAuthorization.role !== '管理員') {
    throw new AuthorizationError('只有已啟用的管理員可以管理成員權限。');
  }

  let displayName = String(command.targetDisplayName || '');
  try {
    const profile = await messenger.getGroupMemberProfile(groupId, command.targetUserId);
    displayName = String(profile?.displayName || displayName);
  } catch (error) {
    if (!displayName) throw error;
  }
  if (!displayName) displayName = 'LINE 成員';
  if (command.action === 'query') {
    const authorization = await repository.getAuthorization(command.targetUserId);
    return [
      `【權限】${displayName}`,
      `角色：${authorization.role}${authorization.exists ? '' : '（尚未登記）'}`,
      `狀態：${authorization.enabled ? '啟用' : '停用'}`
    ].join('\n');
  }

  const enabled = command.action === 'grant';
  const result = await repository.updateAuthorization({
    actor: { userId: actorUserId },
    target: { userId: command.targetUserId, displayName },
    ...(enabled ? { role: command.role } : {}),
    enabled,
    idempotencyKey
  });
  return [
    `${enabled ? '已授權' : '已停用'}${displayName}`,
    `角色：${result.role}`,
    `狀態：${result.enabled ? '啟用' : '停用'}`,
    ...(result.idempotentReplay ? ['（此事件已處理過，未重複寫入）'] : [])
  ].join('\n');
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
