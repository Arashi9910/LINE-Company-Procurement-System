import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTodoCommand, parseTodoEvent } from '../src/services/daily-todos.js';
import { buildOwnerPicker, buildTaskPicker } from '../src/line/todo-management.js';

function fixture() {
  let saved = { templates: [], tasks: [], operations: [], deliveries: [] };
  let chain = Promise.resolve();
  let seq = 0;
  const roles = { admin: '管理員', second: '管理員', worker: '申請人', disabled: '' };
  const repository = {
    async getAuthorization(id) { return { exists: !!roles[id], enabled: !!roles[id], role: roles[id] }; },
    async listTodoAssignees() { return Object.keys(roles).filter(id => roles[id]).map(id => ({ id, name: id })); },
    withDailyTodos(run) {
      const result = chain.then(() => {
        const state = structuredClone(saved);
        return run({ state, async save() { saved = structuredClone(state); } });
      });
      chain = result.catch(() => {});
      return result;
    }
  };
  const f = { repository, roles, get state() { return saved; },
    async run(command, extra = {}) {
      return executeTodoCommand({ command, actorUserId: 'admin', groupId: 'G', eventId: `event-${++seq}`, at: new Date('2026-09-17T04:00:00Z'), ...extra }, { repository });
    },
    async click(data, extra) { return f.run(parseTodoEvent({ type: 'postback', postback: { data } }), extra); },
    async say(text, extra) { return f.run(parseTodoEvent({ type: 'message', message: { type: 'text', text } }), extra); },
    async add(ownerId = 'worker', templates = false) { await f.run({ action: 'add', templates, title: '發貨', ownerId, ownerName: ownerId }); return (templates ? saved.templates : saved.tasks).at(-1).id; }
  };
  return f;
}
function actions(message) {
  const result = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.action) result.push(node.action);
    for (const value of Object.values(node)) Array.isArray(value) ? value.forEach(visit) : visit(value);
  }
  visit(message);
  return result;
}
const button = (result, label) => actions(result.message).find(action => action.label === label).data;

test('menu, rename and confirmation persist across calls and suppress duplicate confirmation', async () => {
  const f = fixture(); const id = await f.add();
  const menu = await f.say('待辦選單');
  const picker = await f.click(button(menu, '管理今日工作'));
  await f.click(button(picker, '修改名稱'));
  assert.equal(parseTodoEvent({ type: 'message', message: { type: 'text', text: '這是一般聊天' } }), null);
  const draft = await f.say('改名 整理照片');
  assert.equal(f.state.tasks[0].title, '發貨');
  const confirm = button(draft, '確認儲存');
  await assert.rejects(f.click(confirm, { actorUserId: 'second' }), /其他人/);
  const results = await Promise.all([f.click(confirm), f.click(confirm)]);
  assert.equal(results.filter(result => result.silent).length, 1);
  assert.equal(f.state.tasks[0].title, '整理照片');
  assert.equal(f.state.operations.filter(op => op.action === 'rename').length, 1);
  assert.ok(!results.find(result => result.text).text.includes(id));
  assert.ok(f.state.operations.some(op => op.action === 'todo-dialog'));
});

test('assignee selection only allows enabled members and checks permission again on commit', async () => {
  const f = fixture(); const id = await f.add();
  const picker = await f.click(`todo:ui:begin:assign:t:${id}`);
  assert.equal(actions(picker.message).some(action => action.label === 'disabled'), false);
  const draft = await f.click(button(picker, 'second'));
  f.roles.second = '';
  await assert.rejects(f.click(button(draft, '確認儲存')), /授權/);
  assert.equal(f.state.tasks[0].ownerId, 'worker');
  f.roles.second = '管理員';
  await f.click(button(draft, '確認儲存'));
  assert.equal(f.state.tasks[0].ownerId, 'second');
  const pending = await f.click(`todo:ui:begin:assign:t:${id}`);
  const pendingDraft = await f.click(button(pending, '待指派'));
  await f.click(button(pendingDraft, '確認儲存'));
  assert.equal(f.state.tasks[0].ownerId, '');
});

test('reopen belongs to assignee, clears completion and records exactly once', async () => {
  const f = fixture(); const id = await f.add();
  await f.run({ action: 'complete', id }, { actorUserId: 'worker' });
  await assert.rejects(f.click(`todo:ui:begin:reopen:t:${id}`), /自己/);
  const draft = await f.click(`todo:ui:begin:reopen:t:${id}`, { actorUserId: 'worker' });
  const confirm = button(draft, '確認儲存');
  await f.click(confirm, { actorUserId: 'worker', eventId: 'same-event' });
  assert.deepEqual(await f.click(confirm, { actorUserId: 'worker', eventId: 'same-event' }), { silent: true });
  assert.deepEqual(await f.click(confirm, { actorUserId: 'worker' }), { silent: true });
  assert.equal(f.state.tasks[0].status, '未完成');
  assert.equal(f.state.tasks[0].completedAt, '');
  assert.equal(f.state.tasks[0].completedBy, '');
  assert.equal(f.state.operations.filter(op => op.action === 'reopen').length, 1);
  assert.equal(f.state.operations.filter(op => op.action === 'complete').length, 1);
});

test('dialogs reject expiry, group mismatch, stale snapshots and permission loss', async () => {
  const f = fixture(); const id = await f.add();
  await f.click(`todo:ui:begin:rename:t:${id}`);
  const draft = await f.say('改名 新名字'); const confirm = button(draft, '確認儲存');
  await assert.rejects(f.click(confirm, { at: new Date('2026-09-17T04:10:00Z') }), /逾時/);
  await assert.rejects(f.click(confirm, { groupId: 'OTHER' }), /其他人/);
  f.roles.admin = '申請人';
  await assert.rejects(f.click(confirm), /管理員/);
  f.roles.admin = '管理員';
  await f.run({ action: 'rename', id, title: '別人改過' }, { actorUserId: 'second' });
  await assert.rejects(f.click(confirm), /已被更新/);
  assert.equal(f.state.tasks[0].title, '別人改過');
});

test('cancel and replacement invalidate old buttons without affecting another actor', async () => {
  const f = fixture(); const id = await f.add();
  await f.click(`todo:ui:begin:rename:t:${id}`, { actorUserId: 'second' });
  const old = await f.click(`todo:ui:begin:assign:t:${id}`);
  await f.click(`todo:ui:begin:rename:t:${id}`);
  assert.deepEqual(await f.click(button(old, 'worker')), { silent: true });
  await f.say('取消操作');
  await assert.rejects(f.say('改名 不應儲存'), /先從/);
  const other = await f.say('改名 另一人', { actorUserId: 'second' });
  await f.click(button(other, '確認儲存'), { actorUserId: 'second' });
  assert.equal(f.state.tasks[0].title, '另一人');
});

test('template management keeps today frozen and my list contains only sender tasks', async () => {
  const f = fixture(); const id = await f.add('worker', true);
  await f.click(`todo:ui:begin:rename:f:${id}`);
  const draft = await f.say('改名 固定新名字');
  await f.click(button(draft, '確認儲存'));
  assert.equal(f.state.templates[0].title, '固定新名字');
  await f.add('admin'); await f.add('worker');
  const mine = await f.say('我的待辦', { actorUserId: 'worker' });
  const ids = actions(mine.message).filter(action => action.data?.startsWith('todo:complete:')).map(action => action.data.split(':').at(-1));
  assert.deepEqual(ids, f.state.tasks.filter(task => task.ownerId === 'worker').map(task => task.id));
  assert.equal(parseTodoEvent({ type: 'message', message: { type: 'text', text: '我的待辦 2' } }).page, 2);
  await assert.rejects(f.click('todo:ui:tasks:t:1', { actorUserId: 'worker' }), /管理員/);
});

test('task and member pickers expose bounded pages with no message actions or raw IDs', () => {
  const tasks = Array.from({ length: 14 }, (_, i) => ({ id: `T-${i}`, title: `任務${i}`, ownerName: '名字' }));
  const first = buildTaskPicker(tasks, 't', 1);
  assert.ok(actions(first).some(action => action.data === 'todo:ui:tasks:t:2'));
  assert.equal(actions(first).filter(action => action.label === '修改名稱').length, 6);
  const last = buildTaskPicker(tasks, 't', 999);
  assert.equal(actions(last).filter(action => action.label === '修改名稱').length, 2);
  const owners = buildOwnerPicker(tasks.map(task => ({ id: task.id, name: task.title })), 'D-test', 1);
  assert.ok(actions(owners).some(action => action.data === 'todo:ui:owners:D-test:2'));
  assert.ok(actions(owners).every(action => action.type === 'postback' && !action.displayText));
});
