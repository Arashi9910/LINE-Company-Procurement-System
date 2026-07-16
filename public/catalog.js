function normalized(value) {
  return String(value ?? '').trim().toLocaleLowerCase('zh-Hant');
}

function searchableItemText(item) {
  return [
    item.sku,
    item.displayName,
    item.productName,
    item.variantName,
    item.spec1,
    item.spec2,
    item.searchKeywords
  ].map(normalized).join(' ');
}

function isWebImage(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function variantLabel(item) {
  const mapped = String(item.variantName ?? '').trim();
  if (mapped) return mapped;
  const specs = [item.spec1, item.spec2].map((value) => String(value ?? '').trim()).filter(Boolean);
  return specs.join(' / ') || String(item.displayName || item.sku);
}

export function groupCatalog(items) {
  const groups = new Map();

  for (const item of items) {
    const productCode = String(item.productCode ?? '').trim();
    const productName = String(item.productName ?? '').trim();
    const key = productCode
      ? `product:${productCode}`
      : productName
        ? `name:${normalized(productName)}`
        : `sku:${item.sku}`;
    const group = groups.get(key) ?? {
      key,
      productCode,
      title: productName || String(item.displayName || item.sku),
      items: [],
      imageUrls: [],
      openCount: 0,
      searchText: ''
    };
    group.items.push(item);
    group.openCount += Number(item.openCount ?? 0);
    group.searchText += ` ${searchableItemText(item)}`;
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const candidates = [
      ...group.items.map((item) => item.mainImageUrl),
      ...group.items.map((item) => item.variantImageUrl),
      ...group.items.map((item) => item.listImageUrl)
    ].filter(isWebImage);
    group.imageUrls = [...new Set(candidates)];
    group.searchText = `${normalized(group.title)} ${normalized(group.productCode)} ${group.searchText}`;
    return group;
  });
}

export function filterCatalog(groups, query) {
  const needle = normalized(query);
  return needle ? groups.filter((group) => group.searchText.includes(needle)) : groups;
}

export function visibleVariants(group, query) {
  const needle = normalized(query);
  if (!needle) return group.items;
  const groupText = `${normalized(group.title)} ${normalized(group.productCode)}`;
  if (groupText.includes(needle)) return group.items;
  return group.items.filter((item) => searchableItemText(item).includes(needle));
}

export function selectableCatalogItems(items, excludedSkus) {
  const excluded = excludedSkus instanceof Set ? excludedSkus : new Set(excludedSkus ?? []);
  return items.filter((item) => !excluded.has(item.sku));
}

export function cartTotals(entries) {
  const values = [...entries];
  return {
    variants: values.length,
    quantity: values.reduce((total, entry) => total + Number(entry.quantity ?? 0), 0)
  };
}

