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
    },
    async failReminder() {},
    async completeReminder() {}
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

test('runReminders marks a rejected push retryable and completes it only after delivery succeeds', async () => {
  let state = '';
  let attempts = 0;
  const transitions = [];
  const candidate = { kind: 'overdue', requestId: 'RQ-FAILED', groupId: 'C1', items: [] };
  const repository = {
    async listReminderCandidates() { return [candidate]; },
    async getNotificationGroupId() { return ''; },
    async reserveReminder() {
      if (state && state !== 'failed') return false;
      state = 'sending';
      transitions.push(state);
      return true;
    },
    async failReminder() {
      state = 'failed';
      transitions.push(state);
    },
    async completeReminder() {
      state = 'sent';
      transitions.push(state);
    }
  };
  const messenger = {
    async pushReminder() {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('You have reached your monthly limit.');
        error.status = 429;
        throw error;
      }
    }
  };
  const at = new Date('2026-08-24T02:00:00.000Z');

  await assert.rejects(runReminders({ repository, messenger, at }), /monthly limit/);
  assert.equal(state, 'failed');

  const retried = await runReminders({ repository, messenger, at });
  assert.equal(retried.sent.length, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(transitions, ['sending', 'failed', 'sending', 'sent']);
});
