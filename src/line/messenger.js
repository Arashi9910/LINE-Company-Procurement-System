import { messagingApi } from '@line/bot-sdk';

export function createLineMessenger({ channelAccessToken }) {
  const client = new messagingApi.MessagingApiClient({ channelAccessToken });

  return {
    async replyReplenishmentLink(replyToken, url) {
      await client.replyMessage({
        replyToken,
        messages: [{
          type: 'template',
          altText: '開啟補貨表單',
          template: {
            type: 'buttons',
            text: '需要補貨嗎？請開啟表單搜尋商品並填寫數量。',
            actions: [{ type: 'uri', label: '開啟補貨表單', uri: url }]
          }
        }]
      });
    },

    async replyText(replyToken, text) {
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
    },

    async pushRequestCreated(groupId, result, actor) {
      const lines = result.items.slice(0, 10).map((item) => {
        const warning = item.duplicateWarning ? ' ⚠已有未結案' : '';
        return `• ${item.displayName} × ${item.quantity} ${item.unit}${warning}`;
      });
      if (result.items.length > 10) lines.push(`…另有 ${result.items.length - 10} 項`);
      const text = [
        `補貨申請 ${result.requestId}`,
        `申請人：${actor.displayName}`,
        ...lines,
        result.idempotentReplay ? '（此為重送，未重複建立資料）' : '狀態：待確認'
      ].join('\n');

      await client.pushMessage({ to: groupId, messages: [{ type: 'text', text }] });
    }
  };
}
