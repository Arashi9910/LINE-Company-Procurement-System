const WORKFLOW_CONFIG = Object.freeze({
  order: Object.freeze({
    title: '確認下單',
    allowedRoles: Object.freeze(['採購確認', '管理員']),
    authorizationMessage: '你沒有確認下單的權限',
    submitLabel: '確認下單',
    emptyMessage: '此補貨單已確認處理',
    readOnly: false
  }),
  receipt: Object.freeze({
    title: '登記到貨',
    allowedRoles: Object.freeze(['到貨確認', '管理員']),
    authorizationMessage: '你沒有確認到貨的權限',
    submitLabel: '確認本次到貨',
    emptyMessage: '此補貨單目前沒有待到貨品項',
    readOnly: false
  }),
  detail: Object.freeze({
    title: '補貨單明細',
    allowedRoles: Object.freeze([]),
    authorizationMessage: '',
    submitLabel: '',
    emptyMessage: '此補貨單沒有品項',
    readOnly: true
  })
});

function quantity(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function workflowConfig(mode) {
  return WORKFLOW_CONFIG[mode] ?? null;
}

export function selectWorkflowItems(items, mode) {
  const rows = Array.isArray(items) ? items : [];
  if (mode === 'order') return rows.filter((item) => item.status === '待確認');
  if (mode === 'receipt') {
    return rows.filter((item) =>
      ['已下單', '部分到貨'].includes(item.status) && quantity(item.outstandingQuantity) > 0);
  }
  if (mode === 'detail') return rows;
  return [];
}

export function workflowItemView(item, mode, { purchaseAdded = false } = {}) {
  const config = workflowConfig(mode);
  if (!config) throw new TypeError(`未知的補貨流程模式：${mode}`);
  if (config.readOnly) {
    const unit = String(item.unit || '件');
    return {
      readOnly: true,
      meta: [
        `狀態：${String(item.status || '未知')}`,
        `申請 ${quantity(item.requestedQuantity)} ${unit}`,
        `下單 ${quantity(item.orderedQuantity)} ${unit}`,
        `已到 ${quantity(item.receivedQuantity)} ${unit}`
      ].join('｜')
    };
  }
  if (mode === 'order') {
    return {
      readOnly: false,
      meta: purchaseAdded
        ? `原申請未包含｜${item.sku}`
        : `申請 ${quantity(item.requestedQuantity)} ${item.unit}｜${item.sku}`
    };
  }
  return {
    readOnly: false,
    meta: `已到 ${quantity(item.receivedQuantity)}/${quantity(item.orderedQuantity)} ${item.unit}｜尚缺 ${quantity(item.outstandingQuantity)}`
  };
}
