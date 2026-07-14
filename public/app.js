import { cartTotals, filterCatalog, groupCatalog, variantLabel, visibleVariants } from './catalog.js';

const MAX_CART_ITEMS = 50;
const MAX_QUANTITY = 999999;

const state = {
  idToken: '',
  items: [],
  groups: [],
  groupsBySku: new Map(),
  cart: new Map(),
  activeGroupKey: '',
  lastFocus: null,
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
  cartSummary: document.querySelector('#cart-summary'),
  cart: document.querySelector('#cart'),
  note: document.querySelector('#note'),
  submit: document.querySelector('#submit'),
  cartDock: document.querySelector('#cart-dock'),
  cartDockButton: document.querySelector('#cart-dock-button'),
  cartDockSummary: document.querySelector('#cart-dock-summary'),
  variantDialog: document.querySelector('#variant-dialog'),
  variantTitle: document.querySelector('#variant-title'),
  variantSubtitle: document.querySelector('#variant-subtitle'),
  variantItems: document.querySelector('#variant-items'),
  variantNotice: document.querySelector('#variant-notice'),
  variantSelection: document.querySelector('#variant-selection'),
  variantClose: document.querySelector('#variant-close'),
  variantDone: document.querySelector('#variant-done'),
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

function validImageUrls(values) {
  return [...new Set(values)].filter((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  });
}

function imageFrame(values, alt, extraClass = '') {
  const frame = document.createElement('div');
  frame.className = `image-frame ${extraClass}`.trim();
  const placeholder = document.createElement('span');
  placeholder.className = 'image-placeholder';
  placeholder.textContent = '無圖片';
  frame.append(placeholder);

  const urls = validImageUrls(values);
  if (urls.length === 0) return frame;

  const image = document.createElement('img');
  image.alt = alt;
  image.loading = 'lazy';
  image.decoding = 'async';
  placeholder.hidden = true;
  frame.prepend(image);
  let index = 0;
  image.addEventListener('error', () => {
    index += 1;
    if (index < urls.length) {
      image.src = urls[index];
    } else {
      image.remove();
      placeholder.hidden = false;
    }
  });
  image.src = urls[index];
  return frame;
}

function groupForItem(item) {
  return state.groupsBySku.get(item.sku);
}

function itemImageUrls(item) {
  const group = groupForItem(item);
  return [item.variantImageUrl, item.mainImageUrl, item.listImageUrl, ...(group?.imageUrls ?? [])];
}

function quantityFor(item) {
  return state.cart.get(item.sku)?.quantity ?? 0;
}

function showVariantNotice(message) {
  elements.variantNotice.textContent = message;
  elements.variantNotice.hidden = false;
}

function updateQuantity(item, nextQuantity) {
  const quantity = Math.max(0, Math.min(MAX_QUANTITY, Math.trunc(Number(nextQuantity) || 0)));
  if (quantity > 0 && !state.cart.has(item.sku) && state.cart.size >= MAX_CART_ITEMS) {
    showVariantNotice(`單次最多選擇 ${MAX_CART_ITEMS} 個規格，請先送出這一批。`);
    return;
  }

  elements.variantNotice.hidden = true;
  if (quantity === 0) state.cart.delete(item.sku);
  else state.cart.set(item.sku, { item, quantity });
  renderCart();
  renderResults();
  if (!elements.variantDialog.hidden) renderVariantDialog();
}

function quantityStepper(item, label) {
  const controls = document.createElement('div');
  controls.className = 'quantity-stepper';
  const quantity = quantityFor(item);

  const minus = document.createElement('button');
  minus.type = 'button';
  minus.className = 'step-button';
  minus.textContent = '−';
  minus.disabled = quantity === 0;
  minus.setAttribute('aria-label', `${label} 減少數量`);
  minus.addEventListener('click', () => updateQuantity(item, quantity - 1));

  const value = document.createElement('output');
  value.className = 'quantity-value';
  value.textContent = String(quantity);
  value.setAttribute('aria-label', `${label} 目前數量 ${quantity}`);

  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'step-button plus';
  plus.textContent = '+';
  plus.disabled = quantity >= MAX_QUANTITY;
  plus.setAttribute('aria-label', `${label} 增加數量`);
  plus.addEventListener('click', () => updateQuantity(item, quantity + 1));

  controls.append(minus, value, plus);
  return controls;
}

function productCard(group) {
  const article = document.createElement('article');
  article.className = 'product-card';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'product-button';
  button.setAttribute('aria-label', `選擇 ${group.title} 的規格`);

  const media = imageFrame(group.imageUrls, group.title, 'product-image');
  const variantBadge = document.createElement('span');
  variantBadge.className = 'variant-badge';
  variantBadge.textContent = `${group.items.length} 規格`;
  media.append(variantBadge);

  const info = document.createElement('div');
  info.className = 'product-info';
  const title = document.createElement('h3');
  title.textContent = group.title;
  const selectedCount = group.items.filter((item) => state.cart.has(item.sku)).length;
  const meta = document.createElement('p');
  meta.className = 'card-meta';
  meta.textContent = selectedCount > 0 ? `已選 ${selectedCount} 個規格` : '點擊選擇規格';
  info.append(title, meta);
  if (group.openCount > 0) {
    const warning = document.createElement('span');
    warning.className = 'warning';
    warning.textContent = `⚠ ${group.openCount} 筆未結案`;
    info.append(warning);
  }
  button.append(media, info);
  button.addEventListener('click', () => openVariantDialog(group));
  article.append(button);
  return article;
}

function renderResults() {
  const query = elements.search.value.trim();
  const matches = filterCatalog(state.groups, query);
  if (matches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '找不到符合的商品，請改用 SKU 或其他關鍵字。';
    elements.results.replaceChildren(empty);
  } else {
    elements.results.replaceChildren(...matches.map(productCard));
  }
  elements.summary.textContent = query
    ? `找到 ${matches.length} 項商品`
    : `共 ${state.groups.length} 項商品、${state.items.length} 個可補貨規格`;
}

function variantRow(item) {
  const row = document.createElement('article');
  row.className = 'variant-row';
  const name = variantLabel(item);
  row.append(imageFrame(itemImageUrls(item), name, 'variant-image'));

  const info = document.createElement('div');
  info.className = 'variant-info';
  const title = document.createElement('h3');
  title.textContent = name;
  const meta = document.createElement('p');
  meta.className = 'muted';
  meta.textContent = `SKU ${item.sku}｜庫存 ${item.stockSnapshot} ${item.unit}`;
  info.append(title, meta);
  if (item.openCount > 0) {
    const warning = document.createElement('span');
    warning.className = 'warning';
    warning.textContent = `⚠ ${item.openCount} 筆未結案`;
    info.append(warning);
  }
  row.append(info, quantityStepper(item, name));
  return row;
}

function renderVariantDialog() {
  const group = state.groups.find((item) => item.key === state.activeGroupKey);
  if (!group) return;
  const variants = visibleVariants(group, elements.search.value);
  elements.variantTitle.textContent = group.title;
  elements.variantSubtitle.textContent = variants.length === group.items.length
    ? `共 ${group.items.length} 個規格`
    : `目前搜尋符合 ${variants.length} / ${group.items.length} 個規格`;
  elements.variantItems.replaceChildren(...variants.map(variantRow));
  const selected = group.items.filter((item) => state.cart.has(item.sku));
  const totals = cartTotals(selected.map((item) => state.cart.get(item.sku)));
  elements.variantSelection.textContent = totals.variants > 0
    ? `本商品已選 ${totals.variants} 個規格，共 ${totals.quantity} 件`
    : '尚未選擇規格';
}

function openVariantDialog(group) {
  state.activeGroupKey = group.key;
  state.lastFocus = document.activeElement;
  elements.variantNotice.hidden = true;
  renderVariantDialog();
  elements.variantDialog.hidden = false;
  document.body.classList.add('sheet-open');
  elements.variantClose.focus();
}

function closeVariantDialog() {
  if (elements.variantDialog.hidden) return;
  elements.variantDialog.hidden = true;
  document.body.classList.remove('sheet-open');
  state.activeGroupKey = '';
  state.lastFocus?.focus?.();
}

function cartRow(entry) {
  const { item } = entry;
  const row = document.createElement('article');
  row.className = 'cart-row';
  row.append(imageFrame(itemImageUrls(item), variantLabel(item), 'cart-image'));

  const info = document.createElement('div');
  info.className = 'cart-info';
  const title = document.createElement('strong');
  title.textContent = item.productName || item.displayName;
  const variant = document.createElement('span');
  variant.textContent = `${variantLabel(item)}｜${item.sku}`;
  info.append(title, variant);

  const controls = quantityStepper(item, item.displayName);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'text-button danger';
  remove.textContent = '移除';
  remove.addEventListener('click', () => updateQuantity(item, 0));

  const actions = document.createElement('div');
  actions.className = 'cart-actions';
  actions.append(controls, remove);
  row.append(info, actions);
  return row;
}

function renderCart() {
  const entries = [...state.cart.values()];
  const totals = cartTotals(entries);
  elements.cart.replaceChildren(...entries.map(cartRow));
  elements.cartCount.textContent = String(totals.variants);
  elements.cartSummary.textContent = `已選 ${totals.variants} 個規格，共 ${totals.quantity} 件`;
  elements.cartDockSummary.textContent = `已選 ${totals.variants} 個規格・共 ${totals.quantity} 件`;
  elements.cartSection.hidden = totals.variants === 0;
  elements.cartDock.hidden = totals.variants === 0;
  document.body.classList.toggle('has-cart-dock', totals.variants > 0);
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
  quantity.max = mode === 'order' ? String(MAX_QUANTITY) : String(item.outstandingQuantity);
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
      state.groups = groupCatalog(state.items);
      for (const group of state.groups) {
        for (const item of group.items) state.groupsBySku.set(item.sku, group);
      }
      elements.catalog.hidden = false;
      renderResults();
    }
  } catch (error) {
    elements.shell.setAttribute('aria-busy', 'false');
    showStatus(error.message, 'error');
  }
}

elements.search.addEventListener('input', () => {
  renderResults();
  if (!elements.variantDialog.hidden) renderVariantDialog();
});
elements.submit.addEventListener('click', submit);
elements.cartDockButton.addEventListener('click', () => {
  closeVariantDialog();
  elements.cartSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
elements.variantClose.addEventListener('click', closeVariantDialog);
elements.variantDone.addEventListener('click', closeVariantDialog);
elements.variantDialog.addEventListener('click', (event) => {
  if (event.target === elements.variantDialog) closeVariantDialog();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeVariantDialog();
});
elements.workflowSubmit.addEventListener('click', submitWorkflow);
initialize();
