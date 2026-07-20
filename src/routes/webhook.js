import { validateSignature } from '@line/bot-sdk';
import { AuthenticationError, ValidationError } from '../errors.js';
import { createGroupContext } from '../line/context.js';
import {
  executeAuthorizationCommand,
  executeCancellationCommand,
  GROUP_COMMAND_HELP,
  parseGroupCommand,
  summarizeRequests
} from '../services/group-commands.js';

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
        const command = event.type === 'message' ? parseGroupCommand(event.message) : null;
        if (!isReplenishmentCommand && !isJoin && !command) return;

        if (!groupId) {
          const instruction = isReplenishmentCommand
            ? '請在公司的 LINE 工作群組輸入「補貨」。'
            : '請在公司的 LINE 工作群組輸入補貨指令。';
          if (event.replyToken) await messenger.replyText(event.replyToken, instruction);
          return;
        }

        const groupAllowed = await repository.saveNotificationGroupId(groupId);
        if (!groupAllowed) {
          if (event.replyToken) await messenger.replyText(event.replyToken, '此群組未授權使用補貨系統。');
          return;
        }

        if (isReplenishmentCommand || isJoin) {
          const contextToken = createGroupContext({ groupId }, config.linkSigningSecret);
          const url = `https://liff.line.me/${config.liffId}?ctx=${encodeURIComponent(contextToken)}`;
          if (event.replyToken) await messenger.replyReplenishmentLink(event.replyToken, url);
          return;
        }

        if (command.type === 'help') {
          if (event.replyToken) await messenger.replyText(event.replyToken, GROUP_COMMAND_HELP);
          return;
        }

        if (['cancellation', 'cancellation-error'].includes(command.type)) {
          let reply;
          try {
            if (command.type === 'cancellation' && !event.webhookEventId) {
              throw new ValidationError('LINE 事件缺少識別碼，請重新送出取消指令。');
            }
            reply = await executeCancellationCommand({
              command,
              actorUserId: event.source?.userId,
              groupId,
              idempotencyKey: event.webhookEventId ? `line-${event.webhookEventId}` : ''
            }, { repository, messenger });
          } catch (error) {
            if (!Number.isInteger(error.status) || error.status >= 500) throw error;
            reply = error.message;
          }
          if (event.replyToken) await messenger.replyText(event.replyToken, reply);
          return;
        }

        if (['authorization', 'authorization-error'].includes(command.type)) {
          let reply;
          try {
            if (command.type === 'authorization'
              && command.action !== 'query'
              && !event.webhookEventId) {
              throw new ValidationError('LINE 事件缺少識別碼，請重新送出指令。');
            }
            reply = await executeAuthorizationCommand({
              command,
              actorUserId: event.source?.userId,
              groupId,
              idempotencyKey: event.webhookEventId ? `line-${event.webhookEventId}` : ''
            }, { repository, messenger });
          } catch (error) {
            if (!Number.isInteger(error.status) || error.status >= 500) throw error;
            reply = error.message;
          }
          if (event.replyToken) await messenger.replyText(event.replyToken, reply);
          return;
        }

        const rows = await repository.listRequestRows();
        const result = summarizeRequests(rows, command.status);
        if (event.replyToken) {
          await messenger.replyStatusCards(event.replyToken, command.status, result);
        }
      }));

      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  };
}
