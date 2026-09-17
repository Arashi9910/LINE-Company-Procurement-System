import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { SheetsRepository } from '../src/sheets/repository.js';
import { TODO_TABLES, loadTodoStore } from '../src/sheets/daily-todos.js';
import { executeTodoCommand } from '../src/services/daily-todos.js';
import { initializeDailyTodos } from '../scripts/setup-daily-todos.mjs';

function sheetsFixture() {
  const tables = Object.fromEntries(Object.values(TODO_TABLES).map((table) => [table.name, [table.headers]]));
  const writes = [];
  const sheets = { spreadsheets: {
    async get() { return { data: { sheets: Object.keys(tables).map((title, sheetId) => ({ properties: { title, sheetId, gridProperties: { rowCount: 20000 } } })) } }; },
    async batchUpdate({ requestBody }) {
      for (const request of requestBody.requests) {
        if (request.addSheet) tables[request.addSheet.properties.title] = [];
        if (request.updateCells) {
          const table = Object.values(TODO_TABLES)[request.updateCells.start.sheetId - 1700000000];
          tables[table.name] = [request.updateCells.rows[0].values.map((value) => value.userEnteredValue.stringValue)];
        }
      }
    },
    values: {
      async get({ range }) {
        if (range.includes('系統設定')) return { data: { values: [['NOTIFICATION_GROUP_ID', 'G']] } };
        if (range.includes('授權人員')) return { data: { values: [['admin', '老闆', '管理員', '是'], ['worker', '小王', '申請人', '是']] } };
        return { data: { values: [tables[range.match(/^'([^']+)'/)[1]][0]] } };
      },
      async batchGet({ ranges }) { return { data: { valueRanges: ranges.map((range) => ({ values: structuredClone(tables[range.match(/^'([^']+)'/)[1]]) })) } }; },
      async batchUpdate({ requestBody }) {
        writes.push(requestBody);
        for (const { range, values } of requestBody.data) {
          const [, name, row] = /^'([^']+)'!A(\d+)$/.exec(range);
          tables[name][Number(row) - 1] = structuredClone(values[0]);
        }
      }
    }
  } };
  return { tables, sheets, writes, repository: new SheetsRepository({ sheets, spreadsheetId: 'test' }) };
}

test('real Sheets adapter writes named columns with RAW, persists idempotency and serializes commands', async () => {
  const f = sheetsFixture();
  const run = () => executeTodoCommand({ command: { action: 'add', title: '=danger()', ownerId: '', ownerName: '' }, actorUserId: 'admin', groupId: 'G', eventId: 'duplicate', at: new Date('2026-09-17T04:00:00Z') }, { repository: f.repository });
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(f.tables['每日待辦紀錄'].length, 2);
  assert.equal(f.tables['每日待辦紀錄'][1][3], '=danger()');
  assert.ok(f.writes.every((write) => write.valueInputOption === 'RAW'));
  const store = await loadTodoStore({ sheets: f.sheets, spreadsheetId: 'test' });
  assert.equal(store.state.tasks[0].title, '=danger()');
  const count = f.writes.length;
  await store.save();
  assert.equal(f.writes.length, count);
});

test('missing headers and duplicate IDs fail before writes', async () => {
  const f = sheetsFixture();
  f.tables['每日待辦範本'][0] = ['wrong'];
  await assert.rejects(loadTodoStore({ sheets: f.sheets, spreadsheetId: 'test' }), /欄位不符/);
  f.tables['每日待辦範本'][0] = TODO_TABLES.templates.headers;
  f.tables['每日待辦範本'].push(['same', '發貨', '', '', '是', 'G'], ['same', '發貨', '', '', '是', 'G']);
  await assert.rejects(loadTodoStore({ sheets: f.sheets, spreadsheetId: 'test' }), /重複編號/);
  assert.equal(f.writes.length, 0);
});

test('invalid worksheet task state fails explicitly rather than hiding unfinished work', async () => {
  const f = sheetsFixture();
  f.tables['每日待辦紀錄'].push(['T-1', '2026-09-17', '', '發貨', '', '', 'unknown', '', '', 'G']);
  await assert.rejects(loadTodoStore({ sheets: f.sheets, spreadsheetId: 'test' }), /資料不完整/);
  f.tables['每日待辦紀錄'][1][6] = '未完成';
  f.tables['每日待辦紀錄'][1][1] = '2026-02-30';
  await assert.rejects(loadTodoStore({ sheets: f.sheets, spreadsheetId: 'test' }), /資料不完整/);
});

test('setup creates four tables, seeds six pending templates and safely reruns', async () => {
  const f = sheetsFixture();
  for (const name of Object.keys(f.tables)) delete f.tables[name];
  const first = await initializeDailyTodos({ sheets: f.sheets, spreadsheetId: 'test' });
  assert.equal(first.createdTables.length, 4);
  assert.equal(f.tables['每日待辦範本'].length, 7);
  assert.ok(f.tables['每日待辦範本'].slice(1).every((row) => row[2] === '' && row[3] === ''));
  const second = await initializeDailyTodos({ sheets: f.sheets, spreadsheetId: 'test' });
  assert.equal(second.createdTables.length, 0);
  assert.equal(f.tables['每日待辦範本'].length, 7);
});

async function start(t, enabled = true) {
  const f = sheetsFixture();
  f.repository.checkHealth = async () => true;
  const replies = [];
  const app = createApp({ config: { dailyTodosEnabled: enabled, lineChannelSecret: 'secret', jobToken: 'job-secret' }, repository: f.repository,
    identityVerifier: {}, messenger: { async getGroupMemberProfile() { return { displayName: '老闆' }; }, async replyText(token, text) { replies.push({ token, text }); }, async replyTodoMessage(token, message) { replies.push({ token, message }); } }
  });
  const server = app.listen(0);
  t.after(() => server.close());
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const webhook = async (event, signature = true) => {
    const body = JSON.stringify({ events: [event] });
    return fetch(`${url}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': signature ? createHmac('sha256', 'secret').update(body).digest('base64') : 'invalid' }, body });
  };
  return { ...f, replies, webhook, url };
}
const event = (text, overrides = {}) => ({ type: 'message', webhookEventId: 'evt-1', replyToken: 'reply', source: { type: 'group', groupId: 'G', userId: 'admin' }, message: { type: 'text', text }, ...overrides });

test('signed webhook self-assignment uses sender identity without a mention', async (t) => {
  const f = await start(t);
  assert.equal((await f.webhook(event('新增待辦 我 功能測試'))).status, 200);
  assert.match(f.replies.at(-1).text, /負責人：老闆/);
  assert.equal(f.tables['每日待辦紀錄'][1][4], 'admin');
});

test('burst completion taps, delayed taps and webhook replay only reply and record once', async (t) => {
  const f = await start(t);
  await f.webhook(event('新增待辦 我 功能測試'));
  const id = f.tables['每日待辦紀錄'][1][0];
  f.replies.length = 0;
  const click = (eventId) => f.webhook({ type: 'postback', webhookEventId: eventId, replyToken: 'reply', source: { type: 'group', groupId: 'G', userId: 'admin' }, postback: { data: `todo:complete:${id}` } });
  const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => click(`tap-${i}`)));
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(f.replies.length, 1);
  const before = structuredClone(f.tables['每日待辦紀錄'][1]);
  await click('delayed-tap');
  await click('tap-0');
  assert.equal(f.replies.length, 1);
  assert.deepEqual(f.tables['每日待辦紀錄'][1], before);
  assert.equal(f.tables['待辦操作紀錄'].filter((row) => row[3] === 'complete').length, 1);
});

test('signed webhook adds tasks, lists cards, rejects outsiders and handles assignee postbacks', async (t) => {
  const f = await start(t);
  assert.equal((await f.webhook(event('新增待辦 發貨'), false)).status, 401);
  assert.equal((await f.webhook(event('新增待辦 發貨'))).status, 200);
  assert.match(f.replies.at(-1).text, /已新增/);
  const id = f.tables['每日待辦紀錄'][1][0];
  const assign = `指派待辦 ${id} @小王`;
  await f.webhook(event(assign, { webhookEventId: 'evt-2', message: { type: 'text', text: assign, mention: { mentionees: [{ type: 'user', userId: 'worker', index: assign.indexOf('@'), length: 3 }] } } }));
  assert.match(f.replies.at(-1).text, /已指派/);
  await f.webhook(event('今日待辦'));
  assert.equal(f.replies.at(-1).message.type, 'flex');
  await f.webhook(event('新增待辦 越權', { source: { type: 'group', groupId: 'foreign', userId: 'admin' } }));
  assert.match(f.replies.at(-1).text, /未授權/);
  await f.webhook({ type: 'postback', webhookEventId: 'complete', replyToken: 'reply', source: { type: 'group', groupId: 'G', userId: 'worker' }, postback: { data: `todo:complete:${id}` } });
  const confirmation = f.replies.at(-1).message;
  assert.match(confirmation?.altText ?? '', /✅ 已完成/);
  assert.match(JSON.stringify(confirmation), /今日待辦/);
  assert.doesNotMatch(JSON.stringify(confirmation), /todo:complete:/);
  assert.equal(f.tables['每日待辦紀錄'][1][6], '已完成');
});

test('disabled feature is non-mutating and scheduler requires bearer token', async (t) => {
  const f = await start(t, false);
  await f.webhook(event('今日待辦'));
  assert.match(f.replies.at(-1).text, /尚未啟用/);
  assert.equal(f.writes.length, 0);
  assert.equal((await fetch(`${f.url}/jobs/daily-todos/noon`, { method: 'POST' })).status, 401);
  const response = await fetch(`${f.url}/jobs/daily-todos/noon`, { method: 'POST', headers: { authorization: 'Bearer job-secret' } });
  assert.deepEqual(await response.json(), { skipped: 'disabled', sent: 0 });
});
