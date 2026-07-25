const FALLBACK_CONTENT = Object.freeze({
  request: {
    altText: '補貨申請等待確認下單',
    text: (requestId) => `${requestId} 已建立，等待確認下單`,
    label: '確認下單',
    mode: 'order'
  },
  order: {
    altText: '補貨單已確認下單',
    text: (requestId) => `${requestId} 已確認下單，等待登記到貨`,
    label: '登記到貨',
    mode: 'receipt'
  },
  receipt: {
    altText: '補貨單已登記到貨',
    text: (requestId) => `${requestId} 已登記到貨`,
    label: '查看明細',
    mode: 'detail'
  }
});

export function buildLineFallbackMessage(liffId, requestId, stage) {
  const content = FALLBACK_CONTENT[stage];
  if (!content) throw new Error(`Unsupported notification stage: ${stage}`);
  const uri = new URL(`https://liff.line.me/${encodeURIComponent(liffId)}`);
  uri.searchParams.set('mode', content.mode);
  uri.searchParams.set('requestId', requestId);
  return {
    type: 'template',
    altText: `${content.altText} ${requestId}`,
    template: {
      type: 'buttons',
      text: content.text(requestId),
      actions: [{ type: 'uri', label: content.label, uri: uri.toString() }]
    }
  };
}

export function canSendToCurrentLineChat(liff) {
  try {
    if (!liff?.isInClient?.() || typeof liff.sendMessages !== 'function') return false;
    if (typeof liff.isApiAvailable === 'function' && !liff.isApiAvailable('sendMessages')) return false;
    const context = liff.getContext?.();
    if (!['group', 'room'].includes(context?.type)) return false;
    if (Array.isArray(context.scope) && !context.scope.includes('chat_message.write')) return false;
    return true;
  } catch {
    return false;
  }
}

export async function sendLineFallbackNotification(liff, liffId, requestId, stage) {
  if (!canSendToCurrentLineChat(liff)) return false;
  try {
    await liff.sendMessages([buildLineFallbackMessage(liffId, requestId, stage)]);
    return true;
  } catch {
    return false;
  }
}
