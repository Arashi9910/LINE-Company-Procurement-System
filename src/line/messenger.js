import { messagingApi } from '@line/bot-sdk';

export function createLineMessenger({ channelAccessToken, liffId }) {
  const client = new messagingApi.MessagingApiClient({ channelAccessToken });
  const workflowUrl = (mode, requestId) =>
    `https://liff.line.me/${liffId}?mode=${mode}&requestId=${encodeURIComponent(requestId)}`;

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

      await client.pushMessage({
        to: groupId,
        messages: [
          { type: 'text', text },
          {
            type: 'template',
            altText: `確認下單 ${result.requestId}`,
            template: {
              type: 'buttons',
              text: `${result.requestId} 等待採購確認`,
              actions: [{ type: 'uri', label: '確認下單', uri: workflowUrl('order', result.requestId) }]
            }
          }
        ]
      });
    },

    async pushOrderConfirmed(groupId, result, actor) {
      const activeItems = result.items.filter((item) => item.status !== '取消');
      const lines = activeItems.slice(0, 10).map((item) =>
        `• ${item.displayName} × ${item.orderedQuantity} ${item.unit}，預計 ${item.expectedDate}`);
      const text = [
        `已確認下單 ${result.requestId}`,
        `操作人：${actor.displayName}`,
        ...lines,
        result.items.some((item) => item.status === '取消') ? '部分品項已取消' : ''
      ].filter(Boolean).join('\n');
      await client.pushMessage({
        to: groupId,
        messages: [
          { type: 'text', text },
          {
            type: 'template',
            altText: `到貨確認 ${result.requestId}`,
            template: {
              type: 'buttons',
              text: `${result.requestId} 到貨後請登記數量`,
              actions: [{ type: 'uri', label: '登記到貨', uri: workflowUrl('receipt', result.requestId) }]
            }
          }
        ]
      });
    },

    async pushReceiptConfirmed(groupId, result, actor) {
      const lines = result.items
        .filter((item) => ['部分到貨', '已完成'].includes(item.status))
        .slice(0, 10)
        .map((item) => `• ${item.displayName}：累計 ${item.receivedQuantity}/${item.orderedQuantity} ${item.unit}`);
      const allComplete = result.items.every((item) => ['已完成', '取消'].includes(item.status));
      await client.pushMessage({
        to: groupId,
        messages: [{
          type: 'text',
          text: [
            `${allComplete ? '補貨單已完成' : '已登記到貨'} ${result.requestId}`,
            `操作人：${actor.displayName}`,
            ...lines,
            allComplete ? '' : `仍未到齊，可再次開啟：${workflowUrl('receipt', result.requestId)}`
          ].filter(Boolean).join('\n')
        }]
      });
    },

    async pushReminder(groupId, candidate) {
      const label = candidate.kind === 'pending' ? '待確認已超過 24 小時' : '已逾預計到貨日';
      const lines = candidate.items.slice(0, 10).map((item) => {
        const quantity = candidate.kind === 'overdue'
          ? `，未到 ${item.outstandingQuantity} ${item.unit}`
          : '';
        return `• ${item.displayName}${quantity}`;
      });
      const action = candidate.kind === 'pending'
        ? { label: '確認下單', uri: workflowUrl('order', candidate.requestId) }
        : { label: '登記到貨', uri: workflowUrl('receipt', candidate.requestId) };
      await client.pushMessage({
        to: groupId,
        messages: [
          { type: 'text', text: [`提醒：${candidate.requestId}`, label, ...lines].join('\n') },
          {
            type: 'template',
            altText: `處理提醒 ${candidate.requestId}`,
            template: {
              type: 'buttons',
              text: `${candidate.requestId} ${label}`,
              actions: [{ type: 'uri', label: action.label, uri: action.uri }]
            }
          }
        ]
      });
    }
  };
}
