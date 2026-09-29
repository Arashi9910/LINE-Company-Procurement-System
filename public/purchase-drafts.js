export function reconcileDraftItems(entries, catalog) {
  const bySku = new Map(catalog.map(item => [item.sku, item]));
  return entries.map(entry => ({
    item: { ...(bySku.get(entry.sku) ?? entry), unavailable: !bySku.has(entry.sku) },
    quantity: entry.quantity
  }));
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function createDraftControls({ api, showStatus, readSelection, openSelection, refreshSelection, currentSourceId, resetSelection }) {
  const root = document.querySelector('#purchase-tools');
  const list = document.querySelector('#purchase-list');
  const editor = document.querySelector('#purchase-editor');
  const date = document.querySelector('#purchase-date');
  const savedStatus = document.querySelector('#purchase-save-status');
  const sourceSummary = document.querySelector('#purchase-sources');
  let current = null;
  let baseline = '';
  let pending = null;
  let creation = null;
  let busy = false;
  const uuid = () => crypto.randomUUID().replaceAll('-', '');
  const payload = () => ({ ...readSelection(), expectedDate: date.value });
  const fingerprint = () => JSON.stringify(payload());
  const dirty = () => Boolean(current && current.status === '編輯中' && fingerprint() !== baseline);

  function changed() {
    if (current) savedStatus.textContent = dirty() ? '有尚未儲存的變更，關閉前請儲存' : `已儲存｜${new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(current.updatedAt))}`;
  }
  async function run(fn) {
    if (busy) return;
    busy = true;
    const shell = document.querySelector('.shell');
    shell.inert = true;
    try { await fn(); } catch (error) { showStatus(error.message, 'error'); }
    finally { busy = false; shell.inert = false; changed(); }
  }
  async function mutation(id, action, data = {}) {
    const signature = JSON.stringify({ id, action, data });
    if (pending?.signature !== signature) pending = { signature, key: uuid() };
    const result = await api(`/api/purchase-drafts/${encodeURIComponent(id)}/${action}`, {
      method: 'POST', body: JSON.stringify({ ...data, idempotencyKey: pending.key })
    });
    pending = null;
    return result;
  }
  function allowSwitch() {
    return !dirty() || window.confirm('有尚未儲存的變更。要放棄這些變更並切換草稿嗎？');
  }
  async function activate(draft) {
    if (draft.status !== '編輯中') throw new Error('這張草稿已送出或已捨棄，請重新整理清單');
    const catalog = await api('/api/skus');
    current = draft;
    date.value = draft.expectedDate;
    await openSelection(draft, catalog.items);
    editor.hidden = false;
    list.hidden = true;
    sourceSummary.replaceChildren();
    sourceSummary.append(element('p', draft.sourceIds.length ? `合併 ${draft.sourceIds.length} 張需求（點單號查看原需求）` : '自行建立的採購草稿'));
    for (const id of draft.sourceIds) {
      const link = element('a', id);
      link.href = `/?mode=detail&requestId=${encodeURIComponent(id)}`;
      link.target = '_blank'; link.rel = 'noopener';
      sourceSummary.append(link, document.createTextNode(' '));
    }
    baseline = fingerprint();
    changed();
    showStatus('已開啟採購草稿；完成編輯後請儲存，或確認正式送出');
  }
  async function create(sourceIds, selection) {
    const data = { sourceIds, ...(selection ?? {}) };
    const signature = JSON.stringify(data);
    if (creation?.signature !== signature) creation = { signature, id: `D-${uuid()}` };
    const draft = await mutation(creation.id, 'create', data);
    // If opening fails after create, keep the ID so retry never creates another draft.
    await activate(draft);
    creation = null;
  }
  async function overview() {
    const data = await api('/api/purchase-drafts');
    list.replaceChildren(element('h2', '我的採購草稿'));
    if (!data.drafts.length) list.append(element('p', '目前沒有草稿', 'muted'));
    for (const draft of data.drafts) {
      const button = element('button', `${draft.note || '未命名草稿'}｜${draft.items.length} 項｜${draft.sourceIds.length} 張來源`, 'secondary');
      button.type = 'button';
      button.addEventListener('click', () => run(async () => {
        if (allowSwitch()) await activate(await api(`/api/purchase-drafts/${draft.id}`));
      }));
      list.append(button);
    }
    list.append(element('h2', '勾選員工需求轉單'));
    const boxes = [];
    for (const source of data.sources) {
      const label = element('label', '', 'purchase-source');
      const checkbox = element('input');
      checkbox.type = 'checkbox'; checkbox.value = source.requestId; checkbox.disabled = source.reserved;
      boxes.push(checkbox);
      label.append(checkbox, document.createTextNode(`${source.requestId}｜${source.applicant}｜${source.items.length} 項${source.reserved ? '（已在草稿中）' : ''}`));
      const details = element('details');
      details.append(element('summary', '查看需求品項'));
      for (const item of source.items) details.append(element('p', `${item.displayName} × ${item.requestedQuantity} ${item.unit}`));
      list.append(label, details);
    }
    if (!data.sources.length) list.append(element('p', '目前沒有待確認需求', 'muted'));
    const transfer = element('button', '將勾選需求合併成草稿', 'primary');
    transfer.type = 'button';
    transfer.addEventListener('click', () => run(async () => {
      const ids = boxes.filter(box => box.checked).map(box => box.value);
      if (!ids.length) throw new Error('請先勾選至少一張需求');
      if (allowSwitch()) await create(ids);
    }));
    list.append(transfer);
    list.hidden = false;
  }
  async function save() {
    if (!current) throw new Error('請先建立或開啟草稿');
    const saved = await mutation(current.id, 'save', { version: current.version, ...payload() });
    current = saved; baseline = fingerprint(); changed();
    return saved;
  }
  document.querySelector('#purchase-open').addEventListener('click', () => run(overview));
  document.querySelector('#purchase-create').addEventListener('click', () => run(async () => {
    if (!allowSwitch()) return;
    const selection = readSelection();
    const sourceId = currentSourceId();
    await create(sourceId ? [sourceId] : [], selection);
  }));
  document.querySelector('#purchase-save').addEventListener('click', () => run(async () => {
    await save(); showStatus('草稿已儲存，關閉 LINE 後可再開啟繼續', 'success');
  }));
  document.querySelector('#purchase-refresh').addEventListener('click', () => run(async () => {
    const catalog = await api('/api/skus');
    refreshSelection(catalog.items);
    showStatus('商品清單已更新，已選數量與備註保留', 'success');
  }));
  document.querySelector('#purchase-discard').addEventListener('click', () => run(async () => {
    if (!current || !window.confirm('確定捨棄這張草稿？來源需求會重新開放處理。')) return;
    await mutation(current.id, 'discard', { version: current.version });
    current = null; editor.hidden = true;
    resetSelection(); await overview(); showStatus('草稿已捨棄，來源需求已釋放', 'success');
  }));
  date.addEventListener('input', changed);
  window.addEventListener('beforeunload', event => {
    if (!dirty()) return;
    event.preventDefault(); event.returnValue = '';
  });
  root.hidden = false;
  return {
    changed,
    async submit() {
      await run(async () => {
        if (!current) throw new Error('請先開啟採購草稿');
        if (!date.value) throw new Error('請填寫預計到貨日');
        if (!window.confirm('確定正式送出採購單？來源需求將標記已轉單，之後由新單追蹤到貨。')) return;
        if (dirty()) await save();
        const result = await mutation(current.id, 'submit', { version: current.version });
        current = null; editor.hidden = true; list.hidden = true;
        resetSelection();
        showStatus(`已建立採購單 ${result.requestId}${result.notification?.sent === false ? '；LINE 通知未送達，請輸入「查已下單」查看' : ''}`, 'success');
      });
    }
  };
}
