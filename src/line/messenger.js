import { messagingApi } from '@line/bot-sdk';

const STATUS_ACTIONS = new Map([
  ['待確認', { label: '確認下單', mode: 'order' }],
  ['已下單', { label: '登記到貨', mode: 'receipt' }],
  ['部分到貨', { label: '繼續登記', mode: 'receipt' }],
  ['已完成', { label: '查看明細', mode: 'detail' }],
  ['取消', { label: '查看明細', mode: 'detail' }]
]);

const STATUS_COLORS = new Map([
  ['待確認', '#b26a00'],
  ['已下單', '#0066cc'],
  ['部分到貨', '#7a4db3'],
  ['已完成', '#16833b'],
  ['取消', '#777777']
]);

function workflowUrl(liffId, mode, requestId) {
  return `https://liff.line.me/${liffId}?mode=${mode}&requestId=${encodeURIComponent(requestId)}`;
}

function compactText(value, maxLength, fallback) {
  const text = String(value || fallback);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function statusCardAction(liffId, item) {
  const action = STATUS_ACTIONS.get(item.status) ?? { label: '查看明細', mode: 'detail' };
  return {
    type: 'uri',
    label: action.label,
    uri: workflowUrl(liffId, action.mode, item.requestId)
  };
}

function statusBubble(liffId, item) {
  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      paddingBottom: 'none',
      contents: [{
        type: 'text',
        text: compactText(item.status, 20, '未知狀態'),
        size: 'sm',
        weight: 'bold',
        color: STATUS_COLORS.get(item.status) ?? '#555555'
      }]
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'text',
          text: compactText(item.requestId, 50, '未知單號'),
          weight: 'bold',
          size: 'md',
          wrap: true
        },
        {
          type: 'text',
          text: `申請人：${compactText(item.applicant, 24, '未知申請人')}`,
          size: 'sm',
          color: '#555555',
          wrap: true
        },
        {
          type: 'text',
          text: `共 ${Number(item.itemCount) || 0} 項`,
          size: 'sm',
          color: '#555555'
        },
        {
          type: 'text',
          text: compactText(item.firstItem, 36, '未命名商品'),
          size: 'sm',
          wrap: true
        }
      ]
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [{
        type: 'button',
        style: 'primary',
        color: '#06c755',
        action: statusCardAction(liffId, item)
      }]
    }
  };
}

export function buildStatusReply(liffId, filter, result) {
  if (result.total === 0) {
    return { type: 'text', text: `【${filter}】目前沒有符合的補貨單。` };
  }
  const items = result.items.slice(0, 10);
  const shownNote = result.total > items.length ? `（顯示最近 ${items.length} 筆）` : '';
  return {
    type: 'flex',
    altText: `【${filter}】共 ${result.total} 筆補貨單${shownNote}`,
    contents: {
      type: 'carousel',
      contents: items.map((item) => statusBubble(liffId, item))
    }
  };
}

export function createLineMessenger({ channelAccessToken, liffId }, dependencies = {}) {
  const client = dependencies.client ?? new messagingApi.MessagingApiClient({ channelAccessToken });
  const liffWorkflowUrl = (mode, requestId) => workflowUrl(liffId, mode, requestId);

  return {
    async getGroupMemberProfile(groupId, userId) {
      return client.getGroupMemberProfile(groupId, userId);
    },

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

    async replyStatusCards(replyToken, filter, result) {
      await client.replyMessage({
        replyToken,
        messages: [buildStatusReply(liffId, filter, result)]
      });
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
              actions: [{ type: 'uri', label: '確認下單', uri: liffWorkflowUrl('order', result.requestId) }]
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
              actions: [{ type: 'uri', label: '登記到貨', uri: liffWorkflowUrl('receipt', result.requestId) }]
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
            allComplete ? '' : `仍未到齊，可再次開啟：${liffWorkflowUrl('receipt', result.requestId)}`
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
        ? { label: '確認下單', uri: liffWorkflowUrl('order', candidate.requestId) }
        : { label: '登記到貨', uri: liffWorkflowUrl('receipt', candidate.requestId) };
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
