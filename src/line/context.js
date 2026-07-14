import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthenticationError } from '../errors.js';

function signature(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createGroupContext({ groupId }, secret, options = {}) {
  if (!groupId || !secret) throw new Error('groupId 與簽章密鑰不可為空');
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ groupId, exp: now + ttlMs })).toString('base64url');
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyGroupContext(token, secret, options = {}) {
  if (!token || !secret) throw new AuthenticationError('群組連結已失效，請回到群組重新輸入「補貨」');
  const [payload, receivedSignature, extra] = token.split('.');
  if (!payload || !receivedSignature || extra) throw new AuthenticationError('群組連結格式錯誤');

  const expected = Buffer.from(signature(payload, secret));
  const received = Buffer.from(receivedSignature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new AuthenticationError('群組連結簽章無效');
  }

  let value;
  try {
    value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new AuthenticationError('群組連結內容無效');
  }

  if (!value.groupId || Number(value.exp) < (options.now ?? Date.now())) {
    throw new AuthenticationError('群組連結已過期，請回到群組重新輸入「補貨」');
  }
  return { groupId: value.groupId };
}
