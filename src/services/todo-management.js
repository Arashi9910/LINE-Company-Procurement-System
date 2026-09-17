import { randomUUID } from 'node:crypto';
import { AuthorizationError, NotFoundError, ValidationError } from '../errors.js';
import { buildTodoMenu, buildTaskPicker, buildOwnerPicker, buildRenamePrompt, buildEditConfirmation } from '../line/todo-management.js';

export function parseTodoManagement(event) {
  if (event.type === 'postback' && event.postback?.data?.startsWith('todo:ui:')) {
    const parts = event.postback.data.slice(8).split(':');
    return { action: 'ui', parts };
  }
  if (event.type !== 'message' || event.message?.type !== 'text') return null;
  const text = event.message.text.trim();
  if (text === '待辦選單') return { action: 'ui', parts: ['menu'] };
  if (text === '取消操作') return { action: 'ui', parts: ['cancel'] };
  if (/^改名(?:\s|$)/.test(text)) return { action: 'ui', parts: ['rename-text'], title: text.slice(2).trim() };
  const mine = /^我的待辦(?:\s+([1-9]\d{0,5}))?$/.exec(text);
  if (mine) return { action: 'list', mine: true, page: Number(mine[1] || 1) };
  return null;
}

// Called inside the existing Sheets transaction. Dialogs share its durable operation table.
export async function handleTodoManagement({ command, state, repository, actorUserId, groupId, authorization, at, date }) {
  const [step, a, b, c, extra] = command.parts;
  if (extra !== undefined) throw new ValidationError('操作格式不正確，請重新輸入「待辦選單」。');
  const isAdmin = authorization.role === '管理員';
  const admin = () => { if (!isAdmin) throw new AuthorizationError('只有管理員可以修改工作與指派負責人。'); };
  const ownSessions = state.operations.filter(op => op.action === 'todo-dialog' && op.actorId === actorUserId && op.groupId === groupId);
  const read = op => JSON.parse(op.result);
  function lookup(token) {
    const op = ownSessions.find(item => item.id === token);
    if (!op) throw new AuthorizationError('這是其他人的操作，請自行開啟「待辦選單」。');
    const session = read(op);
    if (session.closed) return { op, session, closed: true };
    if (at.getTime() >= session.expiresAt) throw new ValidationError('操作已逾時，請重新開啟「待辦選單」。');
    return { op, session };
  }
  function close(op) { op.result = JSON.stringify({ ...read(op), closed: true }); }
  function create(session) {
    for (const op of ownSessions) if (!read(op).closed) close(op);
    const token = `D-${randomUUID()}`;
    state.operations.push({ id: token, actorId: actorUserId, groupId, action: 'todo-dialog', targetId: session.id,
      at: at.toISOString(), result: JSON.stringify({ ...session, expiresAt: at.getTime() + 10 * 60000 }) });
    return token;
  }
  function targetFor(session) {
    const target = (session.templates ? state.templates : state.tasks).find(item => item.id === session.id && item.groupId === groupId);
    if (!target) throw new NotFoundError('工作已不存在，請重新選取。');
    if (JSON.stringify(target) !== session.snapshot) throw new ValidationError('這項工作已被更新，請重新選取後操作。');
    if (session.action === 'reopen') {
      if (target.ownerId !== actorUserId || target.status !== '已完成') throw new AuthorizationError('只能撤回自己已完成的工作。');
    } else {
      admin();
      if (!session.templates && target.status !== '未完成') throw new ValidationError('只能修改未完成的工作。');
    }
    return target;
  }
  if (step === 'menu' && a === undefined) return { message: buildTodoMenu(isAdmin) };
  if (step === 'list' && ['all', 'mine'].includes(a) && b === undefined) return { command: { action: 'list', mine: a === 'mine' } };
  if (step === 'tasks' && ['t', 'f', 'reopen'].includes(a) && /^\d{1,6}$/.test(b) && c === undefined) {
    if (a !== 'reopen') admin();
    const items = (a === 'f' ? state.templates : state.tasks).filter(item => item.groupId === groupId && (a === 'f'
      || (item.date <= date && (a === 'reopen' ? item.ownerId === actorUserId && item.status === '已完成' : item.status === '未完成'))));
    return { message: buildTaskPicker(items, a, Number(b)) };
  }
  if (step === 'begin' && ['rename', 'assign', 'reopen'].includes(a) && ['t', 'f'].includes(b) && c) {
    if (a !== 'reopen') admin();
    if (a === 'reopen' && b !== 't') throw new ValidationError('固定範本不能撤回完成。');
    const target = (b === 'f' ? state.templates : state.tasks).find(item => item.id === c && item.groupId === groupId);
    if (!target) throw new NotFoundError('找不到工作，請重新選取。');
    const session = { action: a, templates: b === 'f', id: target.id, snapshot: JSON.stringify(target), stage: a === 'reopen' ? 'confirm' : a };
    targetFor(session);
    const token = create(session);
    return { message: a === 'rename' ? buildRenamePrompt(target, token) : a === 'assign'
      ? buildOwnerPicker(await repository.listTodoAssignees(), token, 1) : buildEditConfirmation(target, session, token) };
  }
  if (step === 'cancel' && b === undefined) {
    if (a) {
      const entry = lookup(a);
      if (entry.closed) return { silent: true };
      close(entry.op);
    } else {
      for (const op of ownSessions) if (!read(op).closed) close(op);
    }
    return { text: '已取消目前操作，工作資料沒有變更。' };
  }
  if (step === 'rename-text' && a === undefined) {
    admin();
    if (!command.title || command.title.length > 100 || /[\r\n]/.test(command.title)) throw new ValidationError('請輸入「改名 新名稱」，名稱需為 1～100 字且不可換行。');
    const op = [...ownSessions].reverse().find(item => !read(item).closed);
    if (!op) throw new ValidationError('請先從「待辦選單」選擇工作並按「修改名稱」。');
    const { session } = lookup(op.id);
    if (session.stage !== 'rename') throw new ValidationError('目前不是修改名稱步驟，請重新選取工作。');
    const target = targetFor(session);
    const draft = { ...session, title: command.title, stage: 'confirm' };
    const token = create(draft);
    return { message: buildEditConfirmation(target, draft, token) };
  }
  if (['owner', 'owners', 'confirm'].includes(step) && a && c === undefined) {
    const { op, session, closed } = lookup(a);
    if (closed) return { silent: true };
    const target = targetFor(session);
    if (step === 'confirm' && b === undefined && session.stage === 'confirm') {
      close(op);
      return { command: { action: session.action, templates: session.templates, id: session.id, title: session.title,
        ownerId: session.ownerId || '', ownerName: session.ownerName || '', fromDialog: true } };
    }
    if (session.stage !== 'assign') throw new ValidationError('操作步驟已改變，請使用最新卡片。');
    const members = await repository.listTodoAssignees();
    if (step === 'owners' && /^\d{1,6}$/.test(b)) return { message: buildOwnerPicker(members, a, Number(b)) };
    if (step === 'owner' && b) {
      const member = b === 'pending' ? { id: '', name: '' } : members.find(item => item.id === b);
      if (!member) throw new ValidationError('這位成員已停用或未授權，請重新選擇。');
      const draft = { ...session, ownerId: member.id, ownerName: member.name, stage: 'confirm' };
      const token = create(draft);
      return { message: buildEditConfirmation(target, draft, token) };
    }
  }
  throw new ValidationError('操作格式不正確，請重新輸入「待辦選單」。');
}
