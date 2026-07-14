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
  submit: document.querySelector('#submit')
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

    const body = await api('/api/skus');
    state.items = body.items;
    elements.catalog.hidden = false;
    elements.shell.setAttribute('aria-busy', 'false');
    elements.status.hidden = true;
    renderResults();
    elements.search.focus();
  } catch (error) {
    elements.shell.setAttribute('aria-busy', 'false');
    showStatus(error.message, 'error');
  }
}

elements.search.addEventListener('input', renderResults);
elements.submit.addEventListener('click', submit);
initialize();
