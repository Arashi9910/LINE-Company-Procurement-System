import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTodoCommand, parseTodoEvent, runDailyTodos, taipeiDay, visibleTasks } from '../src/services/daily-todos.js';
import { buildTodoPage } from '../src/line/daily-todos.js';
import { createLineMessenger } from '../src/line/messenger.js';
import { loadConfig } from '../src/config.js';

const noon = new Date('2026-09-17T04:00:00Z');
function fixture() {
  let persisted = { templates: ['發貨', '上架'].map((title, i) => ({
    id: `F-${i}`, title, ownerId: '', ownerName: '', enabled: '是', groupId: 'G', updatedAt: ''
  })), tasks: [], operations: [], deliveries: [] };
  let chain = Promise.resolve();
  const calls = [];
  const authorizations = { admin: { role: '管理員', enabled: true, exists: true }, worker: { role: '申請人', enabled: true, exists: true }, other: { role: '申請人', enabled: true, exists: true } };
  const repository = {
    async getAuthorization(id) { return authorizations[id] ?? { enabled: false, exists: false }; },
    async getNotificationGroupId() { return 'G'; },
    withDailyTodos(run) {
      const result = chain.then(async () => {
        const state = structuredClone(persisted);
        return run({ state, async save() {
          if (fixtureState.failSave) { fixtureState.failSave = false; throw new Error('save failed'); }
          persisted = structuredClone(state);
        } });
      });
      chain = result.catch(() => {});
      return result;
    }
  };
  const fixtureState = { repository, authorizations, calls, get state() { return persisted; }, messenger: {
    async getGroupMemberProfile(groupId, userId) {
      assert.equal(groupId, 'G');
      assert.equal(userId, 'admin');
      return { displayName: '老闆' };
    },
    async pushTodoMessage(group, payload, retryKey) {
      calls.push({ group, payload, retryKey });
      if (fixtureState.failPush) { fixtureState.failPush = false; throw new Error('timeout'); }
      if (fixtureState.failAfterPush) { fixtureState.failAfterPush = false; fixtureState.failSave = true; }
    }
  } };
  fixtureState.command = (command, overrides = {}) => executeTodoCommand({ command, actorUserId: 'admin', groupId: 'G', eventId: `evt-${fixtureState.state.operations.length}`, at: noon, ...overrides }, { repository, messenger: fixtureState.messenger });
  fixtureState.run = (overrides = {}) => runDailyTodos({ repository, messenger: fixtureState.messenger, at: noon, slot: 'noon', ...overrides });
  return fixtureState;
}
const parse = (text, mentions = []) => parseTodoEvent({ type: 'message', message: { type: 'text', text, mention: { mentionees: mentions } } });

test('self assignment binds the authenticated sender for one-off and recurring work', async () => {
  const f = fixture();
  await f.command(parse('新增待辦 我 功能測試'), { eventId: 'self-add' });
  const task = f.state.tasks.find((item) => item.title === '功能測試');
  assert.equal(task.ownerId, 'admin');
  assert.equal(task.ownerName, '老闆');
  await f.command(parse('新增固定待辦 自己 每日檢查'));
  assert.equal(f.state.templates.at(-1).ownerId, 'admin');
  await f.command(parse('指派固定待辦 F-0 我'));
  assert.equal(f.state.templates[0].ownerId, 'admin');
  await f.command(parse(`指派待辦 ${f.state.tasks[0].id} 自己`));
  assert.equal(f.state.tasks[0].ownerId, 'admin');
  await f.command({ action: 'complete', id: task.id });
  assert.equal(f.state.tasks.find((item) => item.id === task.id).status, '已完成');
  f.messenger.getGroupMemberProfile = async () => { throw new Error('offline'); };
  await f.command(parse('新增待辦 我 功能測試'), { eventId: 'self-add' });
  const count = f.state.tasks.length;
  await assert.rejects(f.command(parse('新增待辦 我 其他工作')), /稍後重試/);
  assert.equal(f.state.tasks.length, count);
  await assert.rejects(f.command(parse('新增待辦 我 越權'), { actorUserId: 'worker' }), /管理員/);
  assert.equal(parse('新增待辦 我').action, 'invalid');
  assert.equal(parse('指派待辦 T-1 我 額外文字').action, 'invalid');
  assert.equal(parse('新增待辦 我們的活動').selfAssigned, undefined);
});

test('todo parsing supports pending tasks, genuine mentions, edits and rejects ambiguous input', () => {
  assert.equal(parse('新增待辦 整理新品照片').ownerId, '');
  assert.equal(parse('新增固定待辦 發貨').templates, true);
  assert.equal(parse('修改固定待辦 F-1 新名稱').title, '新名稱');
  assert.equal(parse('指派待辦 T-1 待指派').action, 'assign');
  const text = '新增待辦 @小王 發貨';
  const person = { type: 'user', userId: 'worker', index: 5, length: 3 };
  assert.equal(parse(text, [person]).ownerId, 'worker');
  assert.equal(parse(text, [person]).title, '發貨');
  assert.equal(parse(text).action, 'invalid');
  assert.equal(parse(text, [person, person]).action, 'invalid');
  assert.equal(parse(text, [{ ...person, userId: '' }]).action, 'invalid');
  assert.equal(parse('新增待辦 發貨\n上架').action, 'invalid');
  assert.equal(parse('今日待辦 9999999').action, 'invalid');
  assert.equal(parse('聊天而已'), null);
  assert.equal(parseTodoEvent({ type: 'postback', postback: { data: 'todo:complete:T-abc' } }).action, 'complete');
  assert.equal(parseTodoEvent({ type: 'postback', postback: { data: 'todo:bad' } }).action, 'invalid');
});

test('weekday schedules send once per slot; tomorrow has separate tasks and retains unfinished work', async () => {
  const f = fixture();
  await Promise.all([f.run(), f.run()]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.state.tasks.length, 2);
  assert.ok(f.state.tasks.every((item) => !item.ownerId));
  const id = f.state.tasks[0].id;
  await f.command({ action: 'assign', id, ownerId: 'worker', ownerName: '小王' });
  await f.command({ action: 'complete', id }, { actorUserId: 'worker' });
  const completedAt = f.state.tasks[0].completedAt;
  await f.command({ action: 'complete', id }, { actorUserId: 'worker' });
  assert.equal(f.state.tasks[0].completedAt, completedAt);
  await f.run({ slot: 'evening', at: new Date('2026-09-17T11:30:00Z') });
  assert.equal(f.calls.length, 2);
  assert.match(JSON.stringify(f.calls[1].payload), /✅ 發貨/);
  await f.run({ at: new Date('2026-09-18T04:00:00Z') });
  assert.equal(f.state.tasks.length, 4);
  const visible = visibleTasks(f.state, 'G', '2026-09-18');
  assert.equal(visible.length, 3);
  assert.equal(visible.filter((item) => item.date === '2026-09-18' && item.status === '未完成').length, 2);
  assert.match(JSON.stringify(f.calls.at(-1).payload), /先前未完成 2026-09-17/);
});

test('weekends, wrong time windows and stale scheduled dates never send', async () => {
  const f = fixture();
  for (const at of ['2026-09-19T04:00:00Z', '2026-09-20T04:00:00Z', '2026-09-17T03:59:00Z', '2026-09-17T11:30:00Z']) await f.run({ at: new Date(at) });
  await f.run({ slot: 'evening' });
  await f.run({ scheduledAt: '2026-09-16T04:00:00Z' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.tasks.length, 0);
  assert.equal(taipeiDay(new Date('2026-09-17T16:00:00Z')).date, '2026-09-18');
});

test('single tasks deduplicate webhook retries and template changes apply to future work', async () => {
  const f = fixture();
  const command = parse('新增待辦 額外交辦');
  const first = await f.command(command, { eventId: 'same' });
  assert.deepEqual(await f.command(command, { eventId: 'same' }), first);
  assert.equal(f.state.tasks.length, 3);
  await f.command({ action: 'assign', templates: true, id: 'F-0', ownerId: 'worker', ownerName: '小王' });
  await f.command({ action: 'rename', templates: true, id: 'F-0', title: '出貨檢查' });
  await f.command({ action: 'disable', templates: true, id: 'F-1' });
  await f.run({ at: new Date('2026-09-18T04:00:00Z') });
  const next = f.state.tasks.filter((item) => item.date === '2026-09-18');
  assert.equal(next.length, 1);
  assert.equal(next[0].ownerId, 'worker');
  assert.equal(next[0].title, '出貨檢查');
  assert.equal(f.state.tasks.filter((item) => item.title === '額外交辦').length, 1);
  assert.equal(f.state.tasks.find((item) => item.title === '發貨').ownerId, '');
});

test('only enabled assignee can complete; old buttons never change new work', async () => {
  const f = fixture();
  await f.run();
  const id = f.state.tasks[0].id;
  await assert.rejects(f.command({ action: 'complete', id }, { actorUserId: 'worker' }), /負責人/);
  await assert.rejects(f.command(parse('新增待辦 測試'), { actorUserId: 'worker' }), /管理員/);
  await assert.rejects(f.command(parse('新增待辦 測試'), { eventId: '' }), /識別碼/);
  await f.command({ action: 'assign', id, ownerId: 'worker', ownerName: '小王' });
  await assert.rejects(f.command({ action: 'complete', id }, { actorUserId: 'other' }), /負責人/);
  await assert.rejects(f.command({ action: 'complete', id }, { groupId: 'foreign' }), /找不到/);
  f.authorizations.worker.enabled = false;
  await assert.rejects(f.command({ action: 'complete', id }, { actorUserId: 'worker' }), /啟用/);
  f.authorizations.worker.enabled = true;
  await f.run({ at: new Date('2026-09-18T04:00:00Z') });
  await f.command({ action: 'complete', id }, { actorUserId: 'worker', at: new Date('2026-09-18T04:01:00Z') });
  assert.ok(f.state.tasks.filter((item) => item.date === '2026-09-18').every((item) => item.status === '未完成'));
});

test('persistent payload and retry key survive send failure and post-send save failure', async () => {
  for (const failure of ['failPush', 'failAfterPush']) {
    const f = fixture();
    f[failure] = true;
    await assert.rejects(f.run());
    assert.equal(f.state.deliveries[0].status, '待發送');
    await f.command({ action: 'rename', id: f.state.tasks[0].id, title: '發送後改名稱' });
    await f.run();
    assert.deepEqual(f.calls[0], f.calls[1]);
    assert.equal(f.state.deliveries[0].status, '已發送');
    await f.run();
    assert.equal(f.calls.length, 2);
  }
});

test('partial page failure resumes only unsent pages and list pagination exposes every task', async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) await f.command(parse(`新增待辦 工作${i}`));
  let count = 0;
  const push = f.messenger.pushTodoMessage;
  f.messenger.pushTodoMessage = async (...args) => { if (++count === 2) throw new Error('timeout'); return push(...args); };
  await assert.rejects(f.run());
  await f.run();
  assert.equal(f.calls.length, 3);
  assert.equal(new Set(f.calls.map((call) => call.retryKey)).size, 3);
  const result = await f.command({ action: 'list', page: 3 });
  assert.match(result.message.altText, /3\/3/);
  assert.equal(result.message.contents.body.contents.length, 4);
});

test('LINE messenger sends retry header and only accepts a proven duplicate 409', async () => {
  const calls = [];
  let error;
  const messenger = createLineMessenger({ channelAccessToken: 'test' }, { client: {
    async pushMessage(...args) { calls.push(args); if (error) throw error; },
    async replyMessage(input) { calls.push(input); }
  } });
  const message = buildTodoPage([], { date: '2026-09-17' });
  await messenger.pushTodoMessage('G', message, 'retry');
  assert.equal(calls[0][1], 'retry');
  await messenger.replyTodoMessage('reply', message);
  assert.equal(calls[1].replyToken, 'reply');
  error = { status: 409, headers: new Headers({ 'x-line-accepted-request-id': 'accepted' }) };
  await messenger.pushTodoMessage('G', message, 'retry');
  error = { status: 409, headers: new Headers() };
  await assert.rejects(messenger.pushTodoMessage('G', message, 'retry'));
});

test('daily todos are disabled by default and invalid flags fail fast', () => {
  assert.equal(loadConfig({ SPREADSHEET_ID: 'test' }, { allowMissingSecrets: true }).dailyTodosEnabled, false);
  assert.equal(loadConfig({ SPREADSHEET_ID: 'test', DAILY_TODOS_ENABLED: 'true' }, { allowMissingSecrets: true }).dailyTodosEnabled, true);
  assert.throws(() => loadConfig({ SPREADSHEET_ID: 'test', DAILY_TODOS_ENABLED: 'yes' }, { allowMissingSecrets: true }), /DAILY_TODOS_ENABLED/);
});
