const state = {
  idToken: '',
  items: [],
  cart: new Map(),
  idempotencyKey: crypto.randomUUID().replaceAll('-', '')
};

const elements = {
  shell: document.querySelector('.shell'),
  status: document.querySelector('#status'),
  userName: document.querySelector('#user-name'),
  catalog: document.querySelector('#catalog'),
  search: document.querySelector('#search'),
  summary: document.querySelector('#result-summary'),
  results: document.querySelector('#results'),
  cartSection: document.querySelector('#cart-section'),
  cartCount: document.querySelector('#cart-count'),
  cart: document.querySelector('#cart'),
  note: document.querySelector('#note'),
  submit: document.querySelector('#submit'),
  workflowSection: document.querySelector('#workflow-section'),
  workflowTitle: document.querySelector('#workflow-title'),
  requestId: document.querySelector('#request-id'),
  workflowMeta: document.querySelector('#workflow-meta'),
  workflowItems: document.querySelector('#workflow-items'),
  workflowSubmit: document.querySelector('#workflow-submit')
};

function showStatus(message, kind = '') {
  elements.status.textContent = message;
  elements.status.className = `status ${kind}`.trim();
  elements.status.hidden = false;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${state.idToken}`,
      ...options.headers
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message ?? '系統暫時無法處理');
  return body;
}

function searchableText(item) {
  return [item.sku, item.displayName, item.productName, item.spec1, item.spec2, item.searchKeywords]
    .join(' ')
    .toLocaleLowerCase('zh-Hant');
}

function addToCart(item) {
  const existing = state.cart.get(item.sku);
  state.cart.set(item.sku, { item, quantity: existing?.quantity ?? 1 });
  renderCart();
}

function productCard(item) {
  const card = document.createElement('article');
  card.className = 'product-card';

  const body = document.createElement('div');
  body.className = 'product-body';
  const title = document.createElement('h3');
  title.textContent = item.displayName;
  const meta = document.createElement('p');
  meta.className = 'muted';
  meta.textContent = `SKU ${item.sku}｜庫存快照 ${item.stockSnapshot}｜單位 ${item.unit}`;
  body.append(title, meta);
  if (item.openCount > 0) {
    const warning = document.createElement('span');
    warning.className = 'warning';
    warning.textContent = `⚠ ${item.openCount} 筆未結案`;
    body.append(warning);
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'add-button';
  button.textContent = state.cart.has(item.sku) ? '已加入' : '加入';
  button.disabled = state.cart.has(item.sku);
  button.addEventListener('click', () => {
    addToCart(item);
    renderResults();
  });
  card.append(body, button);
  return card;
}

function renderResults() {
  const query = elements.search.value.trim().toLocaleLowerCase('zh-Hant');
  const matches = state.items
    .filter((item) => !query || searchableText(item).includes(query))
    .slice(0, 30);
  elements.results.replaceChildren(...matches.map(productCard));
  elements.summary.textContent = query
    ? `顯示前 ${matches.length} 筆結果`
    : `共有 ${state.items.length} 個可補貨 SKU，先顯示前 30 筆`;
}

function renderCart() {
  const rows = [...state.cart.values()].map(({ item, quantity }) => {
    const row = document.createElement('div');
    row.className = 'cart-row';
    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = item.displayName;
    const meta = document.createElement('span');
    meta.textContent = `${item.sku}｜${item.unit}`;
    info.append(title, meta);

    const controls = document.createElement('div');
    controls.className = 'quantity-controls';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '999999';
    input.step = '1';
    input.value = String(quantity);
    input.setAttribute('aria-label', `${item.displayName} 數量`);
    input.addEventListener('change', () => {
      const value = Number(input.value);
      state.cart.get(item.sku).quantity = Number.isInteger(value) && value > 0 ? value : 1;
      input.value = String(state.cart.get(item.sku).quantity);
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-button';
    remove.textContent = '移除';
    remove.addEventListener('click', () => {
      state.cart.delete(item.sku);
      renderCart();
      renderResults();
    });
    controls.append(input, remove);
    row.append(info, controls);
    return row;
  });

  elements.cart.replaceChildren(...rows);
  elements.cartCount.textContent = String(state.cart.size);
  elements.cartSection.hidden = state.cart.size === 0;
}

async function submit() {
  if (state.cart.size === 0) return;
  elements.submit.disabled = true;
  elements.submit.textContent = '送出中…';
  try {
    const contextToken = new URLSearchParams(location.search).get('ctx') ?? '';
    const result = await api('/api/requests', {
      method: 'POST',
      body: JSON.stringify({
        items: [...state.cart.values()].map(({ item, quantity }) => ({ sku: item.sku, quantity })),
        note: elements.note.value,
        idempotencyKey: state.idempotencyKey,
        contextToken
      })
    });
    state.cart.clear();
    state.idempotencyKey = crypto.randomUUID().replaceAll('-', '');
    elements.note.value = '';
    renderCart();
    renderResults();
    showStatus(`已建立補貨單 ${result.requestId}`, 'success');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    elements.submit.disabled = false;
    elements.submit.textContent = '送出補貨申請';
  }
}

function workflowItem(item, mode) {
  const row = document.createElement('article');
  row.className = 'workflow-row';
  row.dataset.sku = item.sku;

  const heading = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = item.displayName;
  const meta = document.createElement('p');
  meta.className = 'muted';
  meta.textContent = mode === 'order'
    ? `申請 ${item.requestedQuantity} ${item.unit}｜${item.sku}`
    : `已到 ${item.receivedQuantity}/${item.orderedQuantity} ${item.unit}｜尚缺 ${item.outstandingQuantity}`;
  heading.append(title, meta);
  row.append(heading);

  const fields = document.createElement('div');
  fields.className = 'workflow-fields';
  const quantityLabel = document.createElement('label');
  quantityLabel.textContent = mode === 'order' ? '下單數量' : '本次到貨';
  const quantity = document.createElement('input');
  quantity.type = 'number';
  quantity.className = 'workflow-quantity';
  quantity.min = mode === 'order' ? '0' : '1';
  quantity.max = mode === 'order' ? '999999' : String(item.outstandingQuantity);
  quantity.step = '1';
  quantity.value = String(mode === 'order' ? item.requestedQuantity : item.outstandingQuantity);
  quantityLabel.append(quantity);
  fields.append(quantityLabel);

  if (mode === 'order') {
    const dateLabel = document.createElement('label');
    dateLabel.textContent = '預計到貨日';
    const date = document.createElement('input');
    date.type = 'date';
    date.className = 'workflow-date';
    date.min = new Date().toISOString().slice(0, 10);
    date.value = /^\d{4}-\d{2}-\d{2}$/.test(item.expectedDate) ? item.expectedDate : '';
    dateLabel.append(date);
    fields.append(dateLabel);
  }
  row.append(fields);
  return row;
}

async function loadWorkflow(mode, requestId) {
  const request = await api(`/api/requests/${encodeURIComponent(requestId)}`);
  const allowedRoles = mode === 'order' ? ['採購確認', '管理員'] : ['到貨確認', '管理員'];
  if (!allowedRoles.includes(request.actorRole)) {
    throw new Error(mode === 'order' ? '你沒有確認下單的權限' : '你沒有確認到貨的權限');
  }

  const items = mode === 'order'
    ? request.items.filter((item) => item.status === '待確認')
    : request.items.filter((item) => ['已下單', '部分到貨'].includes(item.status) && item.outstandingQuantity > 0);
  elements.workflowTitle.textContent = mode === 'order' ? '確認下單' : '登記到貨';
  elements.requestId.textContent = request.requestId;
  elements.workflowMeta.textContent = `申請人 ${request.applicant}｜共 ${request.items.length} 項`;
  elements.workflowItems.replaceChildren(...items.map((item) => workflowItem(item, mode)));
  elements.workflowSubmit.textContent = mode === 'order' ? '確認下單' : '確認本次到貨';
  elements.workflowSubmit.dataset.mode = mode;
  elements.workflowSubmit.dataset.requestId = request.requestId;
  elements.workflowSubmit.hidden = items.length === 0;
  elements.workflowSection.hidden = false;
  if (items.length === 0) showStatus(mode === 'order' ? '此補貨單已確認處理' : '此補貨單目前沒有待到貨品項', 'success');
}

async function submitWorkflow() {
  const mode = elements.workflowSubmit.dataset.mode;
  const requestId = elements.workflowSubmit.dataset.requestId;
  const rows = [...elements.workflowItems.querySelectorAll('.workflow-row')];
  const items = rows.map((row) => {
    const sku = row.dataset.sku;
    const quantity = Number(row.querySelector('.workflow-quantity').value);
    return mode === 'order'
      ? { sku, orderedQuantity: quantity, expectedDate: row.querySelector('.workflow-date').value }
      : { sku, receivedQuantity: quantity };
  });

  elements.workflowSubmit.disabled = true;
  const originalText = elements.workflowSubmit.textContent;
  elements.workflowSubmit.textContent = '處理中…';
  try {
    const endpoint = mode === 'order' ? 'order' : 'receipt';
    const result = await api(`/api/requests/${encodeURIComponent(requestId)}/${endpoint}`, {
      method: 'POST',
      body: JSON.stringify({ items, idempotencyKey: state.idempotencyKey })
    });
    state.idempotencyKey = crypto.randomUUID().replaceAll('-', '');
    elements.workflowSubmit.hidden = true;
    showStatus(
      mode === 'order' ? `已確認下單 ${result.requestId}` : `已登記到貨 ${result.requestId}`,
      'success'
    );
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    elements.workflowSubmit.disabled = false;
    elements.workflowSubmit.textContent = originalText;
  }
}

async function initialize() {
  try {
    const configResponse = await fetch('/api/config');
    const config = await configResponse.json();
    if (!config.liffId) throw new Error('尚未設定 LIFF ID');
    if (!window.liff) throw new Error('LINE LIFF SDK 載入失敗');

    await liff.init({ liffId: config.liffId });
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: location.href });
      return;
    }
    state.idToken = liff.getIDToken();
    if (!state.idToken) throw new Error('無法取得 LINE 登入憑證');
    const profile = await liff.getProfile();
    elements.userName.textContent = profile.displayName;

    elements.shell.setAttribute('aria-busy', 'false');
    elements.status.hidden = true;
    const params = new URLSearchParams(location.search);
    const mode = params.get('mode');
    const requestId = params.get('requestId');
    if (['order', 'receipt'].includes(mode) && requestId) {
      await loadWorkflow(mode, requestId);
    } else {
      const body = await api('/api/skus');
      state.items = body.items;
      elements.catalog.hidden = false;
      renderResults();
      elements.search.focus();
    }
  } catch (error) {
    elements.shell.setAttribute('aria-busy', 'false');
    showStatus(error.message, 'error');
  }
}

elements.search.addEventListener('input', renderResults);
elements.submit.addEventListener('click', submit);
elements.workflowSubmit.addEventListener('click', submitWorkflow);
initialize();
