import test from 'node:test';
import assert from 'node:assert/strict';
import { runReminders } from '../src/services/reminders.js';

test('runReminders reserves and sends each daily reminder once', async () => {
  const reserved = new Set();
  const pushes = [];
  const repository = {
    async listReminderCandidates() {
      return [
        { kind: 'pending', requestId: 'RQ-1', groupId: 'C1', items: [] },
        { kind: 'overdue', requestId: 'RQ-2', groupId: '', items: [] }
      ];
    },
    async getNotificationGroupId() { return 'C-FALLBACK'; },
    async reserveReminder(input) {
      if (reserved.has(input.key)) return false;
      reserved.add(input.key);
      return true;
    }
  };
  const messenger = { async pushReminder(...args) { pushes.push(args); } };
  const at = new Date('2026-07-14T02:00:00.000Z');

  const first = await runReminders({ repository, messenger, at });
  const second = await runReminders({ repository, messenger, at });

  assert.equal(first.sent.length, 2);
  assert.equal(second.sent.length, 0);
  assert.deepEqual(pushes.map((entry) => entry[0]), ['C1', 'C-FALLBACK']);
  assert.match([...reserved][0], /^reminder-2026-07-14-/);
});
