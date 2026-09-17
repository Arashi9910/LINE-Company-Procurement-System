import { createHash, randomUUID } from 'node:crypto';
import { AuthenticationError, AuthorizationError, ValidationError, NotFoundError } from '../errors.js';
import { buildTodoCarousel, buildTodoCompletion, buildTodoPage, TODO_PAGE_SIZE } from '../line/daily-todos.js';

export const TODO_HELP = [
  '【待辦指令】', '今日待辦｜固定待辦',
  '管理員可用：',
  '新增待辦 事項（單次，預設待指派）',
  '新增待辦 @成員 事項',
  '新增待辦 我 事項（指派給自己）',
  '新增固定待辦 事項（每個平日重複）',
  '新增固定待辦 @成員 事項',
  '新增固定待辦 我 事項',
  '指派待辦 工作編號 @成員／我／待指派',
  '指派固定待辦 範本編號 @成員／我／待指派',
  '修改待辦 工作編號 新事項',
  '修改固定待辦 範本編號 新事項',
  '取消待辦 工作編號',
  '停用固定待辦 範本編號',
  '啟用固定待辦 範本編號',
  '固定範本變更從下一個未產生清單的工作日生效；當日請用工作編號調整。',
  '只有該項負責人可按 ✅ 完成；先前未完成會持續列出。'
].join('\n');

export function taipeiDay(at) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(at).map(({ type, value }) => [type, value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return { date, weekday, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

const stableId = (prefix, value) => `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;

export function parseTodoEvent(event) {
  if (event.type === 'postback' && event.postback?.data?.startsWith('todo:')) {
    const match = /^todo:complete:(T-[a-zA-Z0-9-]+)$/.exec(event.postback.data);
    return match ? { action: 'complete', id: match[1] } : { action: 'invalid' };
  }
  if (event.type !== 'message' || event.message?.type !== 'text') return null;
  const raw = event.message.text;
  const text = raw.trim();
  if (text === '待辦指令') return { action: 'help' };
  const list = /^(今日待辦|固定待辦)(?:\s+([1-9]\d{0,5}))?$/.exec(text);
  if (list) return { action: 'list', templates: list[1] === '固定待辦', page: Number(list[2] || 1) };
  const match = /^(新增固定待辦|新增待辦|指派固定待辦|指派待辦|修改固定待辦|修改待辦|停用固定待辦|啟用固定待辦|取消待辦)\s+([\s\S]+)$/.exec(text);
  if (!match) return /^(今日待辦|固定待辦|新增待辦|新增固定待辦|指派待辦|指派固定待辦|修改待辦|修改固定待辦|停用固定待辦|啟用固定待辦|取消待辦)(?:\s|$)/.test(text) ? { action: 'invalid' } : null;
  const name = match[1];
  const templates = name.includes('固定');
  const action = name.startsWith('新增') ? 'add' : name.startsWith('指派') ? 'assign'
    : name.startsWith('修改') ? 'rename' : name.startsWith('停用') ? 'disable'
      : name.startsWith('啟用') ? 'enable' : 'cancel';
  let rest = match[2];
  let id;
  if (action !== 'add') {
    const parts = /^(\S+)(?:\s+([\s\S]+))?$/.exec(rest);
    id = parts[1];
    rest = parts[2] || '';
  }
  let ownerId = '';
  let ownerName = '';
  let selfAssigned = false;
  if (['add', 'assign'].includes(action)) {
    const mentions = event.message.mention?.mentionees ?? [];
    if (mentions.length) {
      const person = mentions[0];
      if (mentions.length !== 1 || person.type !== 'user' || person.isSelf || !person.userId
        || !Number.isInteger(person.index) || !Number.isInteger(person.length) || person.index < 0 || person.length < 1) return { action: 'invalid' };
      const mention = raw.slice(person.index, person.index + person.length);
      // Require the genuine mention at the argument position, not a name elsewhere in the title.
      const expectedPrefix = action === 'add' ? name : `${name} ${id}`;
      if (raw.slice(0, person.index).trim().replace(/\s+/g, ' ') !== expectedPrefix
        || !rest.startsWith(mention)) return { action: 'invalid' };
      rest = rest.slice(mention.length).trim();
      ownerId = person.userId;
      ownerName = mention.replace(/^@/, '').slice(0, 80);
    } else if (/^(我|自己)(?:\s|$)/.test(rest)) {
      selfAssigned = true;
      rest = rest.replace(/^(我|自己)(?:\s+|$)/, '').trim();
    } else if (action === 'assign') {
      if (rest !== '待指派') return { action: 'invalid' };
      rest = '';
    } else if (rest.startsWith('@')) return { action: 'invalid' };
  }
  if (['add', 'rename'].includes(action)) {
    if (!rest.trim() || rest.length > 100 || /[\r\n]/.test(rest)) return { action: 'invalid' };
  } else if (rest) return { action: 'invalid' };
  return { action, templates, id, title: rest.trim(), ownerId, ownerName, ...(selfAssigned ? { selfAssigned } : {}) };
}

function generateDay(state, groupId, at) {
  const { date, weekday } = taipeiDay(at);
  const id = stableId('G', `${groupId}|${date}`);
  if ([0, 6].includes(weekday) || state.operations.some((item) => item.id === id)) return;
  for (const template of state.templates.filter((item) => item.groupId === groupId && item.enabled === '是')) {
    const taskId = stableId('T', `${groupId}|${date}|${template.id}`);
    if (state.tasks.some((item) => item.id === taskId)) continue;
    state.tasks.push({
      id: taskId, date, templateId: template.id, title: template.title,
      ownerId: template.ownerId, ownerName: template.ownerName, status: '未完成',
      completedBy: '', completedAt: '', groupId, createdBy: 'scheduler', updatedAt: at.toISOString()
    });
  }
  state.operations.push({ id, actorId: 'scheduler', groupId, action: 'generate', targetId: date, at: at.toISOString(), result: '已產生當日清單' });
}

export function visibleTasks(state, groupId, date) {
  return state.tasks.filter((item) => item.groupId === groupId && item.date <= date
    && (item.status === '未完成' || (item.date === date && item.status === '已完成')))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

async function requireMember(repository, userId) {
  if (!userId) throw new AuthenticationError('LINE 未提供使用者身分。');
  const authorization = await repository.getAuthorization(userId);
  if (!authorization.enabled || authorization.exists === false) throw new AuthorizationError('請先由管理員使用「授權 @成員 申請人」啟用此人員。');
  return authorization;
}

export async function executeTodoCommand({ command, actorUserId, groupId, eventId, at = new Date() }, { repository, messenger }) {
  if (command.action === 'invalid') throw new ValidationError(`指令格式不正確。\n${TODO_HELP}`);
  if (command.action === 'help') return { text: TODO_HELP };
  return repository.withDailyTodos(async (store) => {
    const authorization = await requireMember(repository, actorUserId);
    const { state } = store;
    const date = taipeiDay(at).date;
    const { action, templates } = command;
    if (action === 'list') {
      if (!templates) generateDay(state, groupId, at);
      const items = templates ? state.templates.filter((item) => item.groupId === groupId) : visibleTasks(state, groupId, date);
      await store.save();
      return { message: buildTodoCarousel(items, {
        date, page: command.page || 1, templates, title: templates ? '固定待辦' : '今日待辦'
      }) };
    }
    if (action !== 'complete' && authorization.role !== '管理員') throw new AuthorizationError('只有管理員可以管理待辦事項與負責人。');
    if (!eventId) throw new ValidationError('LINE 事件缺少識別碼，請重新操作。');
    const operationId = stableId('E', `${groupId}|${eventId}`);
    const previous = state.operations.find((item) => item.id === operationId);
    if (previous) return action === 'complete' ? { silent: true } : { text: previous.result };
    if (command.selfAssigned) {
      let profile;
      try { profile = await messenger.getGroupMemberProfile(groupId, actorUserId); }
      catch { throw new ValidationError('暫時無法取得你的 LINE 名稱，請稍後重試。'); }
      const ownerName = String(profile?.displayName ?? '').trim().slice(0, 80);
      if (!ownerName) throw new ValidationError('LINE 尚未提供你的名稱，請稍後重試。');
      command = { ...command, ownerId: actorUserId, ownerName };
    }
    if (command.ownerId) await requireMember(repository, command.ownerId);
    // Freeze today's templates before any edits so a mid-day change only affects future days.
    generateDay(state, groupId, at);
    const collection = templates ? state.templates : state.tasks;
    let target = collection.find((item) => item.id === command.id && item.groupId === groupId);
    if (action === 'add') {
      target = {
        id: stableId(templates ? 'F' : 'T', `${groupId}|${eventId}`), title: command.title,
        ownerId: command.ownerId, ownerName: command.ownerName, groupId, updatedAt: at.toISOString(),
        ...(templates ? { enabled: '是' } : { date, templateId: '', status: '未完成', completedBy: '', completedAt: '', createdBy: actorUserId })
      };
      collection.push(target);
    } else {
      if (!target) throw new NotFoundError('找不到此群組的待辦編號。');
      if (action === 'complete') {
        if (!target.ownerId || target.ownerId !== actorUserId) throw new AuthorizationError('只有這項工作的負責人可以確認完成。');
        if (target.status === '取消') throw new ValidationError('此工作已取消。');
        if (target.status === '已完成') return { silent: true };
        target.status = '已完成'; target.completedBy = actorUserId; target.completedAt = at.toISOString();
      } else {
        if (!templates && target.status !== '未完成') throw new ValidationError('只能修改或取消未完成工作。');
        if (action === 'assign') { target.ownerId = command.ownerId; target.ownerName = command.ownerName; }
        if (action === 'rename') target.title = command.title;
        if (action === 'cancel') target.status = '取消';
        if (action === 'disable') target.enabled = '否';
        if (action === 'enable') target.enabled = '是';
      }
      target.updatedAt = at.toISOString();
    }
    const label = { add: '已新增', assign: '已指派', rename: '已修改', cancel: '已取消', disable: '已停用', enable: '已啟用', complete: '✅ 已完成' }[action];
    const result = `${label}：${target.title}\n${target.id}\n負責人：${target.ownerName || '待指派'}${templates ? '\n固定範本變更從下一個未產生清單的工作日生效。' : ''}`;
    state.operations.push({ id: operationId, actorId: actorUserId, groupId, action, targetId: target.id, at: at.toISOString(), result });
    await store.save();
    return { text: result, ...(action === 'complete' ? { message: buildTodoCompletion(target) } : {}) };
  });
}

export async function runDailyTodos({ repository, messenger, slot, at = new Date(), scheduledAt }) {
  if (!['noon', 'evening'].includes(slot)) throw new ValidationError('待辦排程時段無效。');
  const day = taipeiDay(at);
  const start = slot === 'noon' ? 720 : 1170;
  const end = slot === 'noon' ? 1170 : 1440;
  if ([0, 6].includes(day.weekday) || day.minute < start || day.minute >= end) return { skipped: 'outside-window', sent: 0 };
  if (scheduledAt) {
    const scheduled = new Date(scheduledAt);
    if (Number.isNaN(scheduled.getTime()) || taipeiDay(scheduled).date !== day.date) return { skipped: 'stale-schedule', sent: 0 };
  }
  const groupId = await repository.getNotificationGroupId();
  if (!groupId) throw new ValidationError('尚未設定工作群組。');
  return repository.withDailyTodos(async (store) => {
    const { state } = store;
    generateDay(state, groupId, at);
    let deliveries = state.deliveries.filter((item) => item.groupId === groupId && item.date === day.date && item.slot === slot);
    if (!deliveries.length) {
      const items = visibleTasks(state, groupId, day.date);
      const totalPages = Math.max(1, Math.ceil(items.length / TODO_PAGE_SIZE));
      deliveries = Array.from({ length: totalPages }, (_, index) => ({
        id: stableId('P', `${groupId}|${day.date}|${slot}|${index}`), groupId, date: day.date, slot,
        status: '待發送', retryKey: randomUUID(),
        payload: JSON.stringify(buildTodoPage(items.slice(index * TODO_PAGE_SIZE, (index + 1) * TODO_PAGE_SIZE), {
          date: day.date, title: slot === 'noon' ? '今日待辦' : '下班確認', page: index + 1, totalPages
        })), createdAt: at.toISOString(), updatedAt: at.toISOString()
      }));
      state.deliveries.push(...deliveries);
    }
    // Persist exact payloads and retry keys BEFORE contacting LINE.
    await store.save();
    let sent = 0;
    for (const delivery of deliveries) {
      if (delivery.status === '已發送') continue;
      if (at.getTime() - Date.parse(delivery.createdAt) >= 23 * 3600000) throw new ValidationError('推播重試期限已過，請人工確認。');
      await messenger.pushTodoMessage(groupId, JSON.parse(delivery.payload), delivery.retryKey);
      delivery.status = '已發送'; delivery.updatedAt = at.toISOString();
      await store.save();
      sent += 1;
    }
    return { sent };
  });
}
