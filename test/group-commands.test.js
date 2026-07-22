import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeAuthorizationCommand,
  executeCancellationCommand,
  formatStatusReply,
  parseGroupCommand,
  summarizeRequests
} from '../src/services/group-commands.js';

test('parseGroupCommand recognizes and normalizes cancellation commands', () => {
  assert.deepEqual(
    parseGroupCommand({ type: 'text', text: ' 取消補貨 rq-20260715-123456-ABCD ' }),
    { type: 'cancellation', requestId: 'RQ-20260715-123456-abcd' }
  );
  assert.deepEqual(
    parseGroupCommand({ type: 'text', text: '取消補貨' }),
    { type: 'cancellation-error', reason: 'invalid-syntax' }
  );
  assert.deepEqual(
    parseGroupCommand({ type: 'text', text: '取消補貨 RQ-123' }),
    { type: 'cancellation-error', reason: 'invalid-syntax' }
  );
  assert.deepEqual(
    parseGroupCommand({ type: 'text', text: ' 取消採購 rq-20260715-123456-ABCD ' }),
    { type: 'cancellation', requestId: 'RQ-20260715-123456-abcd', mode: 'ordered' }
  );
  assert.deepEqual(
    parseGroupCommand({ type: 'text', text: '取消採購 RQ-123' }),
    { type: 'cancellation-error', reason: 'invalid-syntax', mode: 'ordered' }
  );
});

test('parseGroupCommand recognizes every status query and help', () => {
  const cases = [
    ['查未結案', { type: 'status', status: '未結案' }],
    ['查待確認', { type: 'status', status: '待確認' }],
    ['查已下單', { type: 'status', status: '已下單' }],
    ['查部分到貨', { type: 'status', status: '部分到貨' }],
    ['查已完成', { type: 'status', status: '已完成' }],
    ['查取消', { type: 'status', status: '取消' }],
    ['補貨指令', { type: 'help' }]
  ];

  for (const [text, expected] of cases) {
    assert.deepEqual(parseGroupCommand({ type: 'text', text: ` ${text} ` }), expected);
  }
  assert.equal(parseGroupCommand({ type: 'image' }), null);
  assert.equal(parseGroupCommand({ type: 'text', text: '今天要補貨嗎' }), null);
});

test('summarizeRequests aggregates SKU rows and applies request status precedence', () => {
  const rows = [
    { requestId: 'RQ-1', requestedAt: 10, applicant: '小明', displayName: '紅色水壺', status: '已完成' },
    { requestId: 'RQ-1', requestedAt: 10, applicant: '小明', displayName: '藍色水壺', status: '已下單' },
    { requestId: 'RQ-2', requestedAt: 20, applicant: '小華', displayName: '收納盒', status: '取消' },
    { requestId: 'RQ-2', requestedAt: 20, applicant: '小華', displayName: '收納盒替換蓋', status: '取消' },
    { requestId: 'RQ-3', requestedAt: 30, applicant: '老闆', displayName: '掛勾', status: '取消' },
    { requestId: 'RQ-3', requestedAt: 30, applicant: '老闆', displayName: '掛架', status: '已完成' },
    { requestId: 'RQ-4', requestedAt: 40, applicant: '小美', displayName: '桌墊', status: '待確認' }
  ];

  const all = summarizeRequests(rows, '未結案');
  assert.equal(all.total, 2);
  assert.deepEqual(all.items.map(({ requestId, status, itemCount }) => ({ requestId, status, itemCount })), [
    { requestId: 'RQ-4', status: '待確認', itemCount: 1 },
    { requestId: 'RQ-1', status: '部分到貨', itemCount: 2 }
  ]);
  assert.equal(summarizeRequests(rows, '取消').items[0].requestId, 'RQ-2');
  assert.equal(summarizeRequests(rows, '已完成').items[0].requestId, 'RQ-3');
});

test('summarizeRequests returns the newest ten requests and keeps the total count', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    requestId: `RQ-${index + 1}`,
    requestedAt: index + 1,
    applicant: '申請人',
    displayName: `商品 ${index + 1}`,
    status: '待確認'
  }));

  const result = summarizeRequests(rows, '待確認');
  assert.equal(result.total, 12);
  assert.equal(result.items.length, 10);
  assert.equal(result.items[0].requestId, 'RQ-12');
  assert.equal(result.items[9].requestId, 'RQ-3');
});

test('formatStatusReply gives a compact request-level list', () => {
  const text = formatStatusReply('未結案', {
    total: 12,
    items: [{
      requestId: 'RQ-20260714-120000-abcd',
      applicant: '小明',
      itemCount: 3,
      firstItem: '很長很長的商品名稱與規格文字用來測試自動縮短顯示',
      status: '待確認'
    }]
  });

  assert.match(text, /【未結案】共 12 筆（顯示最近 10 筆）/);
  assert.match(text, /RQ-20260714-120000-abcd｜待確認｜小明｜3 項/);
  assert.match(text, /…等/);
});

test('formatStatusReply clearly reports an empty result', () => {
  assert.equal(formatStatusReply('部分到貨', { total: 0, items: [] }), '【部分到貨】目前沒有符合的補貨單。');
});

function textWithMention(text, mentionee) {
  return {
    type: 'text',
    text,
    mention: { mentionees: [{ ...mentionee, index: text.indexOf('@'), length: 3 }] }
  };
}

test('parseGroupCommand binds authorization commands to the mentioned LINE user ID', () => {
  const mentionee = { type: 'user', userId: 'TARGET', isSelf: false, index: 3, length: 3 };
  for (const role of ['申請人', '採購確認', '到貨確認', '管理員']) {
    assert.deepEqual(parseGroupCommand(textWithMention(`授權 @小明 ${role}`, mentionee)), {
      type: 'authorization', action: 'grant', role, targetUserId: 'TARGET', targetDisplayName: '小明'
    });
  }
  assert.deepEqual(parseGroupCommand(textWithMention('停用 @小明', mentionee)), {
    type: 'authorization', action: 'disable', targetUserId: 'TARGET', targetDisplayName: '小明'
  });
  assert.deepEqual(parseGroupCommand(textWithMention('查權限 @小明', mentionee)), {
    type: 'authorization', action: 'query', targetUserId: 'TARGET', targetDisplayName: '小明'
  });
});

test('parseGroupCommand reports unusable or ambiguous mentions without guessing', () => {
  assert.deepEqual(
    parseGroupCommand(textWithMention('授權 @小明 管理員', { type: 'user', isSelf: false })),
    { type: 'authorization-error', reason: 'missing-user-id' }
  );
  assert.deepEqual(parseGroupCommand({
    type: 'text',
    text: '停用 @小明 @小華',
    mention: { mentionees: [
      { type: 'user', userId: 'U1', isSelf: false },
      { type: 'user', userId: 'U2', isSelf: false }
    ] }
  }), { type: 'authorization-error', reason: 'multiple-targets' });
  assert.deepEqual(parseGroupCommand({ type: 'text', text: '授權 小明 老闆' }), {
    type: 'authorization-error', reason: 'invalid-syntax'
  });
});

test('executeAuthorizationCommand allows only an enabled administrator to grant a role', async () => {
  const writes = [];
  const dependencies = {
    repository: {
      async getAuthorization(userId) {
        return userId === 'ADMIN'
          ? { role: '管理員', enabled: true, exists: true }
          : { role: '申請人', enabled: true, exists: false };
      },
      async updateAuthorization(input) {
        writes.push(input);
        return { role: input.role, enabled: input.enabled, idempotentReplay: false };
      }
    },
    messenger: {
      async getGroupMemberProfile(groupId, userId) {
        assert.equal(groupId, 'COMPANY');
        assert.equal(userId, 'TARGET');
        return { displayName: '小明' };
      }
    }
  };
  const command = { type: 'authorization', action: 'grant', role: '採購確認', targetUserId: 'TARGET' };

  const text = await executeAuthorizationCommand({
    command, actorUserId: 'ADMIN', groupId: 'COMPANY', idempotencyKey: 'line-event-123456'
  }, dependencies);

  assert.match(text, /已授權小明/);
  assert.match(text, /採購確認/);
  assert.deepEqual(writes[0], {
    actor: { userId: 'ADMIN' },
    target: { userId: 'TARGET', displayName: '小明' },
    role: '採購確認',
    enabled: true,
    idempotencyKey: 'line-event-123456'
  });

  await assert.rejects(executeAuthorizationCommand({
    command, actorUserId: 'MEMBER', groupId: 'COMPANY', idempotencyKey: 'line-event-654321'
  }, dependencies), /只有已啟用的管理員/);
  assert.equal(writes.length, 1);
});

test('executeAuthorizationCommand queries the mentioned member role without writing', async () => {
  const dependencies = {
    repository: {
      async getAuthorization(userId) {
        if (userId === 'ADMIN') return { role: '管理員', enabled: true, exists: true };
        return { role: '到貨確認', enabled: false, exists: true };
      },
      async updateAuthorization() { throw new Error('must not write'); }
    },
    messenger: { async getGroupMemberProfile() { return { displayName: '小華' }; } }
  };
  const text = await executeAuthorizationCommand({
    command: { type: 'authorization', action: 'query', targetUserId: 'TARGET' },
    actorUserId: 'ADMIN', groupId: 'COMPANY', idempotencyKey: 'unused-query-key'
  }, dependencies);

  assert.match(text, /【權限】小華/);
  assert.match(text, /角色：到貨確認/);
  assert.match(text, /狀態：停用/);
});

test('executeAuthorizationCommand safely falls back to the mention label when profile lookup fails', async () => {
  let write;
  const text = await executeAuthorizationCommand({
    command: {
      type: 'authorization', action: 'grant', role: '申請人',
      targetUserId: 'TARGET', targetDisplayName: '小美'
    },
    actorUserId: 'ADMIN', groupId: 'COMPANY', idempotencyKey: 'line-event-fallback'
  }, {
    repository: {
      async getAuthorization() { return { role: '管理員', enabled: true, exists: true }; },
      async updateAuthorization(input) {
        write = input;
        return { role: input.role, enabled: true, idempotentReplay: false };
      }
    },
    messenger: { async getGroupMemberProfile() { throw new Error('profile unavailable'); } }
  });

  assert.equal(write.target.displayName, '小美');
  assert.match(text, /已授權小美/);
});

function cancellationDependencies({ owner = 'OWNER', role = '申請人', enabled = true, status = '待確認' } = {}) {
  const writes = [];
  return {
    writes,
    dependencies: {
      repository: {
        async getRequestForCancellation(requestId) {
          return {
            requestId,
            requesterUserId: owner,
            groupId: 'COMPANY',
            items: [{ sku: 'SKU-A', status }]
          };
        },
        async getAuthorization() { return { role, enabled, exists: true }; },
        async cancelRequest(input) {
          writes.push(input);
          return {
            requestId: input.requestId,
            items: [{ sku: 'SKU-A', status: '取消' }],
            idempotentReplay: false
          };
        }
      },
      messenger: {
        async getGroupMemberProfile(groupId, userId) {
          assert.equal(groupId, 'COMPANY');
          assert.ok(userId);
          return { displayName: userId === 'OWNER' ? '小明' : '管理員' };
        }
      }
    }
  };
}

test('executeCancellationCommand lets the original applicant cancel a pending request', async () => {
  const fixture = cancellationDependencies();
  const text = await executeCancellationCommand({
    command: { type: 'cancellation', requestId: 'RQ-20260715-123456-abcd' },
    actorUserId: 'OWNER',
    groupId: 'COMPANY',
    idempotencyKey: 'line-event-cancel-1'
  }, fixture.dependencies);

  assert.match(text, /已取消補貨單 RQ-20260715-123456-abcd/);
  assert.match(text, /操作人：小明/);
  assert.match(text, /共 1 項/);
  assert.deepEqual(fixture.writes, [{
    actor: { userId: 'OWNER' },
    requestId: 'RQ-20260715-123456-abcd',
    idempotencyKey: 'line-event-cancel-1'
  }]);
});

test('executeCancellationCommand permits enabled administrators and rejects other members', async () => {
  const admin = cancellationDependencies({ owner: 'OWNER', role: '管理員', enabled: true });
  await executeCancellationCommand({
    command: { type: 'cancellation', requestId: 'RQ-20260715-123456-abcd' },
    actorUserId: 'ADMIN', groupId: 'COMPANY', idempotencyKey: 'line-event-admin-1'
  }, admin.dependencies);
  assert.equal(admin.writes.length, 1);

  const member = cancellationDependencies({ owner: 'OWNER', role: '採購確認', enabled: true });
  await assert.rejects(executeCancellationCommand({
    command: { type: 'cancellation', requestId: 'RQ-20260715-123456-abcd' },
    actorUserId: 'BUYER', groupId: 'COMPANY', idempotencyKey: 'line-event-buyer-1'
  }, member.dependencies), /只有原申請人或已啟用的管理員/);
  assert.equal(member.writes.length, 0);
});

test('executeCancellationCommand restricts ordered cancellation to purchasing staff and administrators', async () => {
  const buyer = cancellationDependencies({ owner: 'OWNER', role: '採購確認', enabled: true, status: '已下單' });
  const text = await executeCancellationCommand({
    command: {
      type: 'cancellation',
      requestId: 'RQ-20260715-123456-abcd',
      mode: 'ordered'
    },
    actorUserId: 'BUYER',
    groupId: 'COMPANY',
    idempotencyKey: 'line-event-cancel-ordered-1'
  }, buyer.dependencies);

  assert.match(text, /已取消採購單 RQ-20260715-123456-abcd/);
  assert.match(text, /採購平台上的訂單仍需另外取消/);
  assert.deepEqual(buyer.writes, [{
    actor: { userId: 'BUYER' },
    requestId: 'RQ-20260715-123456-abcd',
    idempotencyKey: 'line-event-cancel-ordered-1',
    mode: 'ordered'
  }]);

  const applicant = cancellationDependencies({ owner: 'OWNER', role: '申請人', enabled: true, status: '已下單' });
  await assert.rejects(executeCancellationCommand({
    command: {
      type: 'cancellation',
      requestId: 'RQ-20260715-123456-abcd',
      mode: 'ordered'
    },
    actorUserId: 'OWNER',
    groupId: 'COMPANY',
    idempotencyKey: 'line-event-cancel-ordered-2'
  }, applicant.dependencies), /採購確認或管理員/);
  assert.equal(applicant.writes.length, 0);
});

test('executeCancellationCommand rejects another group and gives syntax guidance', async () => {
  const fixture = cancellationDependencies();
  await assert.rejects(executeCancellationCommand({
    command: { type: 'cancellation', requestId: 'RQ-20260715-123456-abcd' },
    actorUserId: 'OWNER', groupId: 'OTHER', idempotencyKey: 'line-event-group-1'
  }, fixture.dependencies), /不屬於目前群組/);

  const guidance = await executeCancellationCommand({
    command: { type: 'cancellation-error', reason: 'invalid-syntax' }
  }, fixture.dependencies);
  assert.match(guidance, /取消補貨 RQ-/);

  const orderedGuidance = await executeCancellationCommand({
    command: { type: 'cancellation-error', reason: 'invalid-syntax', mode: 'ordered' }
  }, fixture.dependencies);
  assert.match(orderedGuidance, /取消採購 RQ-/);
});
