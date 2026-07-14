import { validateSignature } from '@line/bot-sdk';
import { AuthenticationError, ValidationError } from '../errors.js';
import { createGroupContext } from '../line/context.js';

export function createWebhookHandler({ config, repository, messenger }) {
  return async function webhookHandler(request, response, next) {
    try {
      const rawBody = request.body;
      const signature = request.get('x-line-signature') ?? '';
      if (!Buffer.isBuffer(rawBody) || !validateSignature(rawBody, config.lineChannelSecret, signature)) {
        throw new AuthenticationError('LINE Webhook 簽章無效');
      }

      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new ValidationError('Webhook JSON 格式錯誤');
      }

      await Promise.all((payload.events ?? []).map(async (event) => {
        const groupId = event.source?.type === 'group' ? event.source.groupId : '';
        const isReplenishmentCommand = event.type === 'message'
          && event.message?.type === 'text'
          && event.message.text.trim() === '補貨';
        const isJoin = event.type === 'join' && groupId;
        if (!isReplenishmentCommand && !isJoin) return;

        if (!groupId) {
          if (event.replyToken) await messenger.replyText(event.replyToken, '請在公司的 LINE 工作群組輸入「補貨」。');
          return;
        }

        await repository.saveNotificationGroupId(groupId);
        const contextToken = createGroupContext({ groupId }, config.linkSigningSecret);
        const url = `https://liff.line.me/${config.liffId}?ctx=${encodeURIComponent(contextToken)}`;
        if (event.replyToken) await messenger.replyReplenishmentLink(event.replyToken, url);
      }));

      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  };
}
