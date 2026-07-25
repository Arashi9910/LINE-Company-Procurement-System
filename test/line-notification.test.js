import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLineFallbackMessage,
  canSendToCurrentLineChat,
  sendLineFallbackNotification
} from '../public/line-notification.js';

test('LINE fallback builds a confirmation card that opens the order workflow', () => {
  const message = buildLineFallbackMessage('123-test', 'RQ-1', 'request');

  assert.equal(message.type, 'template');
  assert.equal(message.template.actions[0].label, '確認下單');
  assert.equal(message.template.actions[0].uri, 'https://liff.line.me/123-test?mode=order&requestId=RQ-1');
});

test('LINE fallback only sends from a supported group chat', async () => {
  const calls = [];
  const liff = {
    isInClient: () => true,
    isApiAvailable: (name) => name === 'sendMessages',
    getContext: () => ({ type: 'group', scope: ['openid', 'chat_message.write'] }),
    async sendMessages(messages) { calls.push(messages); }
  };

  assert.equal(canSendToCurrentLineChat(liff), true);
  assert.equal(await sendLineFallbackNotification(liff, '123-test', 'RQ-2', 'request'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].template.actions[0].label, '確認下單');
});

test('LINE fallback leaves instructions on screen when chat sending is unavailable', async () => {
  const liff = {
    isInClient: () => true,
    isApiAvailable: () => false,
    getContext: () => ({ type: 'group', scope: ['openid'] }),
    async sendMessages() { throw new Error('should not be called'); }
  };

  assert.equal(canSendToCurrentLineChat(liff), false);
  assert.equal(await sendLineFallbackNotification(liff, '123-test', 'RQ-3', 'request'), false);
});
