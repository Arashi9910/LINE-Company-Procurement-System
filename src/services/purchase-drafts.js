import { AuthenticationError, AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../errors.js';

export async function requirePurchaser(actor, repository) {
  if (!actor?.userId) throw new AuthenticationError();
  const auth = await repository.getAuthorization(actor.userId);
  if (!auth.enabled || !['採購確認', '管理員'].includes(auth.role)) throw new AuthorizationError();
}

export function normalizeDraftItems(items) {
  if (!Array.isArray(items) || items.length > 50) throw new ValidationError('草稿最多 50 個品項');
  const seen = new Set();
  return items.map(item => {
    const sku = String(item?.sku ?? '').trim();
    const quantity = Number(item?.quantity);
    if (!sku || sku.length > 150 || seen.has(sku)) throw new ValidationError('草稿 SKU 缺少或重複');
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999999) throw new ValidationError('數量必須是 1 到 999999 的整數');
    seen.add(sku);
    return { sku, quantity };
  });
}

function date(value, required = false) {
  const result = String(value ?? '').trim();
  if (!result && !required) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(`${result}T00:00:00Z`))
      || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) {
    throw new ValidationError('請填寫有效的預計到貨日');
  }
  return result;
}

function owned(store, id, actor) {
  const draft = store.drafts.find(item => item.id === id);
  if (!draft) throw new NotFoundError('找不到採購草稿');
  if (draft.ownerId !== actor.userId) throw new AuthorizationError('只能操作自己的採購草稿');
  return draft;
}

function snapshot(store, draft) {
  return {
    ...draft, version: Number(draft.version),
    items: store.items.filter(item => item.draftId === draft.id).map(item => ({ ...item, quantity: Number(item.quantity) })),
    sourceIds: store.links.filter(link => link.draftId === draft.id && link.status !== '已釋放').map(link => link.sourceId)
  };
}

export async function draftOverview(actor, repository) {
  await requirePurchaser(actor, repository);
  return repository.withPurchaseDrafts(async store => {
    const rows = await repository.listRequestRows();
    const groups = new Map();
    for (const item of rows) {
      if (!groups.has(item.requestId)) groups.set(item.requestId, []);
      groups.get(item.requestId).push(item);
    }
    return {
      drafts: store.drafts.filter(item => item.ownerId === actor.userId && item.status === '編輯中').map(item => snapshot(store, item)),
      sources: [...groups].filter(([, items]) => items.every(item => item.status === '待確認')).map(([requestId, items]) => ({
        requestId, applicant: items[0].applicant, items,
        reserved: store.links.some(link => link.sourceId === requestId && link.status === '保留中')
      }))
    };
  });
}

export async function readDraft(input, repository) {
  await requirePurchaser(input.actor, repository);
  return repository.withPurchaseDrafts(async store => snapshot(store, owned(store, input.id, input.actor)));
}

export async function mutateDraft(input, repository) {
  await requirePurchaser(input.actor, repository);
  const { action, actor } = input;
  if (!['create', 'save', 'discard', 'submit'].includes(action)) throw new ValidationError('未知草稿操作');
  const key = String(input.idempotencyKey ?? '');
  const id = String(input.id ?? '');
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(key) || !/^D-[a-f0-9]{32}$/.test(id)) throw new ValidationError('草稿操作識別碼不正確');
  return repository.withPurchaseDrafts(async store => {
    let draft = store.drafts.find(item => item.id === id);
    if (draft) {
      owned(store, id, actor);
      if (draft.lastKey === key && draft.lastAction === action) {
        if (action === 'submit') return { ...(await repository.getRequest(draft.requestId)), idempotentReplay: true };
        return { ...snapshot(store, draft), idempotentReplay: true };
      }
      if (action === 'create' || draft.status !== '編輯中' || Number(input.version) !== Number(draft.version)) {
        throw new ConflictError('草稿已變更或已處理，請重新開啟草稿');
      }
    } else if (action !== 'create') throw new NotFoundError('找不到採購草稿');

    const now = repository.now().toISOString();
    if (action === 'create') {
      if (!Array.isArray(input.sourceIds) || input.sourceIds.length > 50) throw new ValidationError('最多合併 50 張需求');
      const sourceIds = [...new Set(input.sourceIds.map(String))];
      if (sourceIds.some(sourceId => !sourceId || sourceId.length > 100)) throw new ValidationError('來源單號不正確');
      if (store.links.some(link => sourceIds.includes(link.sourceId) && ['保留中', '已轉單'].includes(link.status))) {
        throw new ConflictError('部分需求已被其他草稿保留或已轉單，請重新整理');
      }
      const sources = [];
      for (const sourceId of sourceIds) {
        const source = await repository.getRequest(sourceId);
        if (!source.items.length || source.items.some(item => item.status !== '待確認')) throw new ConflictError('只能轉入全部待確認的需求');
        sources.push(source);
      }
      const groupIds = new Set(sources.map(source => source.groupId));
      if (groupIds.size > 1) throw new ValidationError('不同群組的需求不可合併');
      const merged = new Map();
      for (const source of sources) for (const item of source.items) {
        const previous = merged.get(item.sku);
        merged.set(item.sku, { ...item, quantity: (previous?.quantity ?? 0) + item.requestedQuantity });
      }
      const items = normalizeDraftItems(input.items ?? (sourceIds.length ? [...merged.values()] : []));
      const catalog = new Map((await repository.listAvailableSkus()).map(item => [item.sku, item]));
      draft = { id, ownerId: actor.userId, status: '編輯中', note: String(input.note ?? '').trim(), expectedDate: date(input.expectedDate), version: 0,
        createdAt: now, groupId: sources[0]?.groupId || await repository.getNotificationGroupId(), requestId: '' };
      if (draft.note.length > 500) throw new ValidationError('備註最多 500 字');
      for (const item of items) {
        const details = catalog.get(item.sku) ?? merged.get(item.sku);
        if (!details) throw new ValidationError(`SKU ${item.sku} 已停用或不存在`);
        store.items.push({ draftId: id, ...item, displayName: details.displayName, unit: details.unit });
      }
      store.drafts.push(draft);
      for (const sourceId of sourceIds) store.links.push({ draftId: id, sourceId, requestId: '', status: '保留中', createdAt: now, updatedAt: now });
    }
    if (action === 'save') {
      const items = normalizeDraftItems(input.items);
      const note = String(input.note ?? '').trim();
      if (note.length > 500) throw new ValidationError('備註最多 500 字');
      draft.note = note;
      draft.expectedDate = date(input.expectedDate);
      const previous = new Map(store.items.filter(item => item.draftId === id).map(item => [item.sku, item]));
      const catalog = new Map((await repository.listAvailableSkus()).map(item => [item.sku, item]));
      const updated = items.map(item => {
        const details = catalog.get(item.sku) ?? previous.get(item.sku);
        if (!details) throw new ValidationError(`SKU ${item.sku} 已停用或不存在`);
        return { draftId: id, ...item, displayName: details.displayName, unit: details.unit };
      });
      // Reuse this draft's slots; never reorder rows belonging to other drafts.
      for (let i = 0; i < store.items.length; i += 1) {
        if (store.items[i].draftId === id) store.items[i] = updated.shift() ?? {};
      }
      store.items.push(...updated);
    }
    if (action === 'discard') {
      draft.status = '已捨棄';
      for (const link of store.links.filter(link => link.draftId === id)) {
        link.status = '已釋放'; link.updatedAt = now;
      }
    }
    draft.version = Number(draft.version) + 1;
    draft.updatedAt = now;
    draft.lastKey = key;
    draft.lastAction = action;
    if (action === 'submit') {
      const saved = snapshot(store, draft);
      normalizeDraftItems(saved.items);
      if (!saved.items.length) throw new ValidationError('至少選擇一個下單品項');
      date(saved.expectedDate, true);
      return repository.commitPurchaseDraft({ store, draft, items: saved.items, actor, key });
    }
    await store.flush();
    return snapshot(store, draft);
  });
}
