import { randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import { loadTodoStore } from './daily-todos.js';
import { loadDraftStore, assertSourceUnreserved } from './purchase-drafts.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { importApprovedReviewSnapshots } from '../flyingmouse/sheets-review.js';
import {
  WRITEBACK_ROW_COUNT,
  WRITEBACK_SHEET_NAME,
  buildWritebackEvent,
  exactWritebackHeaders,
  parseWritebackRows,
  writebackEventRow
} from '../flyingmouse/sheets-writeback.js';
import {
  CORRECTION_SKU_INDEX,
  ORDER_SPEC_CORRECTION_HEADERS,
  ORIGINAL_SKU_INDEX,
  TRACKING_LAST_COLUMN,
  exactOrderSpecCorrectionHeaders,
  flagDuplicateEffectiveSkus,
  resolveOrderSpecCorrection
} from './order-spec-correction.js';
import { STOCK_MODE, STOCK_MODE_LABEL } from '../services/stock-mode.js';

const TRACKING_SHEET = '補貨追蹤';
const UNKNOWN_STOCK_MODE = STOCK_MODE_LABEL[STOCK_MODE.UNKNOWN];
const SKU_SHEET = 'SKU主檔';
const PRODUCT_IMAGES_SHEET = '商品圖片對照';
const SETTINGS_SHEET = '系統設定';
const AUTH_SHEET = '授權人員';
const OPERATIONS_SHEET = '操作紀錄';
const MAX_TRACKING_ROW = 5000;
const CLOSED_STATUSES = new Set(['已完成', '取消', '已轉單']);
const AUTHORIZATION_ROLES = new Set(['申請人', '採購確認', '到貨確認', '管理員']);
const REQUEST_INTERNAL = Symbol('requestInternal');

function sheetSerial(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(
    Number(value.year),
    Number(value.month) - 1,
    Number(value.day),
    Number(value.hour),
    Number(value.minute),
    Number(value.second)
  ) / 86_400_000 + 25_569;
}

function requestId(date, uuid) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `RQ-${value.year}${value.month}${value.day}-${value.hour}${value.minute}${value.second}-${uuid.slice(0, 4)}`;
}

function dateSerial(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new ValidationError('預計到貨日格式錯誤');
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000 + 25_569;
}

function catalogSku(row) {
  return {
    sku: String(row[0]),
    productName: String(row[1] ?? ''),
    spec1: String(row[2] ?? ''),
    spec2: String(row[3] ?? ''),
    stockSnapshot: Number(row[4] ?? 0),
    displayName: String(row[7] || row[1] || row[0]),
    searchKeywords: String(row[10] ?? ''),
    unit: String(row[11] || '件'),
    updatedAt: String(row[13] ?? ''),
    // 由每小時同步從銷售商品名稱推導。補貨追蹤的 W 欄要跟著它走，
    // 否則規格修正後 W 會留著舊 SKU 的型態（規格第 4.3 節）。
    stockMode: String(row[14] ?? ''),
    available: row[9] === '是'
  };
}

function trackingItem(row, rowNumber = 0) {
  return {
    rowNumber,
    requestId: String(row[0] ?? ''),
    requestedAt: row[1] ?? '',
    applicant: String(row[2] ?? ''),
    displayName: String(row[3] ?? ''),
    unit: String(row[4] || '件'),
    requestedQuantity: Number(row[5] ?? 0),
    status: String(row[6] ?? ''),
    orderedQuantity: Number(row[7] ?? 0),
    expectedDate: String(row[8] ?? '').replaceAll('/', '-'),
    receivedQuantity: Number(row[9] ?? 0),
    outstandingQuantity: Number(row[10] ?? 0),
    duplicateWarning: String(row[11] ?? ''),
    note: String(row[12] ?? ''),
    sku: String(row[13] ?? ''),
    sourceGroupId: String(row[15] ?? ''),
    correctionSku: String(row[CORRECTION_SKU_INDEX] ?? ''),
    originalSku: String(row[ORIGINAL_SKU_INDEX] ?? '')
  };
}

export function createGoogleSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

export class SheetsRepository {
  constructor({
    sheets,
    spreadsheetId,
    now = () => new Date(),
    uuid = randomUUID,
    flyingmouseWritebackEnabled = false,
    dailyTodosEnabled = false,
    purchaseDraftsEnabled = false
  }) {
    this.sheets = sheets;
    this.spreadsheetId = spreadsheetId;
    this.now = now;
    this.uuid = uuid;
    this.flyingmouseWritebackEnabled = flyingmouseWritebackEnabled === true;
    this.dailyTodosEnabled = dailyTodosEnabled === true;
    this.purchaseDraftsEnabled = purchaseDraftsEnabled === true;
    this.writeChain = Promise.resolve();
  }

  async checkHealth() {
    const [, correctionHeaders] = await Promise.all([
      this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `'${SETTINGS_SHEET}'!A1:B1`,
        valueRenderOption: 'UNFORMATTED_VALUE'
      }),
      this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `'${TRACKING_SHEET}'!T1:V1`,
        valueRenderOption: 'UNFORMATTED_VALUE'
      })
    ]);
    exactOrderSpecCorrectionHeaders(
      correctionHeaders.data.values?.[0] ?? ORDER_SPEC_CORRECTION_HEADERS.map(() => '')
    );
    if (this.dailyTodosEnabled) await loadTodoStore(this);
    if (this.purchaseDraftsEnabled) await loadDraftStore(this);
    if (this.flyingmouseWritebackEnabled) {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `'${WRITEBACK_SHEET_NAME}'!A1:O1`,
        valueRenderOption: 'UNFORMATTED_VALUE'
      });
      exactWritebackHeaders(response.data.values?.[0] ?? []);
    }
    return true;
  }

  async listAvailableSkus() {
    return (await this.#listSkuCatalog())
      .filter((sku) => sku.available)
      .map(({ available: _available, ...sku }) => sku);
  }

  async #listSkuCatalog() {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${SKU_SHEET}'!A2:O`
    });

    return (response.data.values ?? [])
      .filter((row) => row[0])
      .map(catalogSku);
  }

  async #resolveTrackingItems(rows) {
    const parsed = rows.map(({ row, rowNumber }) => trackingItem(row, rowNumber));
    const needsCatalog = parsed.some((item) => item.correctionSku && !item.originalSku);
    const catalogBySku = needsCatalog
      ? new Map((await this.#listSkuCatalog()).map((sku) => [sku.sku, sku]))
      : new Map();
    return flagDuplicateEffectiveSkus(parsed.map((item) => resolveOrderSpecCorrection({
      item,
      catalogBySku
    })));
  }

  async listProductImages() {
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `'${PRODUCT_IMAGES_SHEET}'!A2:P`
      }).catch((error) => {
        if (Number(error.code ?? error.response?.status) !== 400) throw error;
        return this.sheets.spreadsheets.values.get({
          spreadsheetId: this.spreadsheetId,
          range: `'${PRODUCT_IMAGES_SHEET}'!A2:O`
        });
      });

      return (response.data.values ?? [])
        .filter((row) => row[1])
        .map((row) => ({
          productId: String(row[2] ?? ''),
          sku: String(row[1]),
          productBindings: row[15] ? JSON.parse(row[15]) : [],
          productCode: String(row[3] ?? ''),
          productName: String(row[4] ?? ''),
          variantName: String(row[5] ?? ''),
          mainImageUrl: String(row[6] ?? ''),
          variantImageUrl: String(row[7] ?? ''),
          listImageUrl: String(row[8] ?? ''),
          imageStatus: String(row[10] ?? ''),
          bindingStatus: String(row[11] ?? '')
        }));
    } catch (error) {
      const status = Number(error.code ?? error.response?.status);
      if (status === 400) return [];
      throw error;
    }
  }

  async listOpenRequests() {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${TRACKING_SHEET}'!A2:${TRACKING_LAST_COLUMN}${MAX_TRACKING_ROW}`
    });

    const rows = (response.data.values ?? [])
      .map((row, index) => ({ row, rowNumber: index + 2 }))
      .filter(({ row }) => row[0] && !CLOSED_STATUSES.has(row[6]));
    return (await this.#resolveTrackingItems(rows)).map((item) => ({
      requestId: item.requestId,
      displayName: item.displayName,
      status: item.status,
      orderedQuantity: item.orderedQuantity,
      receivedQuantity: item.receivedQuantity,
      outstandingQuantity: item.outstandingQuantity,
      sku: item.sku,
      ...(item.skuCorrectionError ? { skuCorrectionError: item.skuCorrectionError } : {}),
      // 重複 SKU 是在換過 sku 之後才標記的，少了這兩個欄位就找不回原 SKU。
      ...(item.skuCorrectionPending ? { skuCorrectionPending: true } : {}),
      ...(item.skuCorrectionOriginalSku
        ? { skuCorrectionOriginalSku: item.skuCorrectionOriginalSku }
        : {})
    }));
  }

  async listRequestRows() {
    const idResponse = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${TRACKING_SHEET}'!A2:A${MAX_TRACKING_ROW}`,
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const ids = idResponse.data.values ?? [];
    const lastIndex = ids.findLastIndex((row) => row[0]);
    if (lastIndex < 0) return [];

    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${TRACKING_SHEET}'!A2:${TRACKING_LAST_COLUMN}${lastIndex + 2}`,
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const rows = (response.data.values ?? [])
      .map((row, index) => ({ row, rowNumber: index + 2 }))
      .filter(({ row }) => row[0]);
    return (await this.#resolveTrackingItems(rows)).map((item) => ({
      requestId: item.requestId,
      requestedAt: item.requestedAt,
      applicant: item.applicant,
      displayName: item.displayName,
      unit: item.unit,
      requestedQuantity: item.requestedQuantity,
      status: item.status,
      orderedQuantity: item.orderedQuantity,
      receivedQuantity: item.receivedQuantity,
      outstandingQuantity: item.outstandingQuantity,
      sku: item.sku,
      ...(item.skuCorrectionError ? { skuCorrectionError: item.skuCorrectionError } : {}),
      // 重複 SKU 是在換過 sku 之後才標記的，少了這兩個欄位就找不回原 SKU。
      ...(item.skuCorrectionPending ? { skuCorrectionPending: true } : {}),
      ...(item.skuCorrectionOriginalSku
        ? { skuCorrectionOriginalSku: item.skuCorrectionOriginalSku }
        : {})
    }));
  }

  createRequest(input) {
    return this.#enqueue(() => this.#createRequest(input));
  }

  confirmOrder(input) {
    return this.#enqueue(() => this.#confirmOrder(input));
  }

  confirmReceipt(input) {
    return this.#enqueue(() => this.#confirmReceipt(input));
  }

  cancelRequest(input) {
    return this.#enqueue(() => this.#cancelRequest(input));
  }

  reserveCatalogSyncTrigger(input) {
    return this.#enqueue(() => this.#reserveCatalogSyncTrigger(input));
  }

  importApprovedCatalogSnapshots(input = {}) {
    return this.#enqueue(() => importApprovedReviewSnapshots({
      sheets: this.sheets,
      spreadsheetId: this.spreadsheetId,
      generatedAt: input.at ?? this.now()
    }));
  }

  #enqueue(run) {
    const result = this.writeChain.then(run, run);
    this.writeChain = result.catch(() => undefined);
    return result;
  }

  withDailyTodos(run) {
    return this.#enqueue(async () => run(await loadTodoStore(this)));
  }

  withPurchaseDrafts(run) {
    if (!this.purchaseDraftsEnabled) throw new ValidationError('採購草稿尚未啟用');
    return this.#enqueue(async () => run(await loadDraftStore(this)));
  }

  async #checkDraftReservation(requestId) {
    if (this.purchaseDraftsEnabled) assertSourceUnreserved(await loadDraftStore(this), requestId);
  }

  async getTransferLinks(requestId) {
    if (!this.purchaseDraftsEnabled) return [];
    const store = await loadDraftStore(this);
    return store.links.filter(link => link.status === '已轉單' && (link.sourceId === requestId || link.requestId === requestId))
      .map(({ sourceId, requestId: targetId }) => ({ sourceId, targetId }));
  }

  // Called only by mutateDraft inside withPurchaseDrafts; flush all changes together.
  async commitPurchaseDraft({ store, draft, items, actor, key }) {
    const catalog = new Map((await this.listAvailableSkus()).map(item => [item.sku, item]));
    if (items.some(item => !catalog.has(item.sku))) throw new ValidationError('部分商品已停用或不存在，請更新商品並移除或替換後再送出');
    const sources = [];
    const links = store.links.filter(link => link.draftId === draft.id && link.status === '保留中');
    for (const link of links) {
      const source = await this.getRequest(link.sourceId);
      if (!source.items.length || source.items.some(item => item.status !== '待確認')) throw new ConflictError('來源需求已下單或取消，請捨棄草稿後重新轉單');
      sources.push(source);
    }
    const operation = await this.#findOperation(key);
    if (operation.existing) throw new ConflictError('操作金鑰已被其他操作使用');
    if (operation.nextRow > 5000) throw new ConflictError('操作紀錄已滿，請先封存');
    const startRow = await this.#findAppendRow(items.length);
    const serial = sheetSerial(this.now());
    const newId = requestId(this.now(), this.uuid());
    const data = [];
    const created = items.map((item, index) => {
      const row = startRow + index;
      const sku = catalog.get(item.sku);
      data.push(
        { range: `'${TRACKING_SHEET}'!A${row}:D${row}`, values: [[newId, serial, actor.displayName || '採購人員', sku.displayName]] },
        { range: `'${TRACKING_SHEET}'!F${row}:J${row}`, values: [[0, '已下單', item.quantity, dateSerial(draft.expectedDate), 0]] },
        { range: `'${TRACKING_SHEET}'!M${row}:S${row}`, values: [[draft.note, item.sku, actor.userId, draft.groupId, actor.userId, serial, key]] },
        { range: `'${TRACKING_SHEET}'!${TRACKING_LAST_COLUMN}${row}`, values: [[sku.stockMode || UNKNOWN_STOCK_MODE]] }
      );
      return { sku: item.sku, displayName: sku.displayName, unit: sku.unit, requestedQuantity: 0,
        orderedQuantity: item.quantity, receivedQuantity: 0, outstandingQuantity: item.quantity, status: '已下單', expectedDate: draft.expectedDate };
    });
    for (const source of sources) for (const item of source.items) data.push(
      { range: `'${TRACKING_SHEET}'!G${item.rowNumber}`, values: [['已轉單']] },
      { range: `'${TRACKING_SHEET}'!Q${item.rowNumber}:R${item.rowNumber}`, values: [[actor.userId, serial]] }
    );
    draft.status = '已送出'; draft.requestId = newId;
    for (const link of links) {
      link.status = '已轉單'; link.requestId = newId; link.updatedAt = draft.updatedAt;
    }
    data.push({ range: `'${OPERATIONS_SHEET}'!A${operation.nextRow}:F${operation.nextRow}`,
      values: [[key, '草稿轉單', newId, actor.userId, serial, `草稿 ${draft.id}；來源 ${links.map(link => link.sourceId).join('、') || '自行建立'}`]] });
    await store.flush(data);
    return { requestId: newId, applicant: actor.displayName, groupId: draft.groupId, note: draft.note, items: created, idempotentReplay: false };
  }

  async #createRequest(input) {
    const [positions, availableSkus, openRequests] = await Promise.all([
      this.#findPositions(input.idempotencyKey),
      this.listAvailableSkus(),
      this.listOpenRequests()
    ]);

    if (positions.existingRequestId) {
      return {
        requestId: positions.existingRequestId,
        idempotentReplay: true,
        items: input.items
      };
    }

    const skuMap = new Map(availableSkus.map((sku) => [sku.sku, sku]));
    const invalidSkus = input.items.filter((item) => !skuMap.has(item.sku)).map((item) => item.sku);
    if (invalidSkus.length > 0) {
      throw new ValidationError('部分 SKU 已停用或不存在', { invalidSkus });
    }

    const lastRow = positions.nextRow + input.items.length - 1;
    if (lastRow > MAX_TRACKING_ROW) {
      throw new ConflictError('補貨追蹤表已滿，請先封存舊資料');
    }

    const now = this.now();
    const serial = sheetSerial(now);
    const newRequestId = requestId(now, this.uuid());
    const openCounts = new Map();
    for (const request of openRequests) {
      openCounts.set(request.sku, (openCounts.get(request.sku) ?? 0) + 1);
    }

    const data = [];
    const createdItems = input.items.map((item, index) => {
      const row = positions.nextRow + index;
      const sku = skuMap.get(item.sku);
      data.push(
        {
          range: `'${TRACKING_SHEET}'!A${row}:D${row}`,
          values: [[newRequestId, serial, input.actor.displayName, sku.displayName]]
        },
        {
          range: `'${TRACKING_SHEET}'!F${row}:J${row}`,
          values: [[item.quantity, '待確認', '', '', '']]
        },
        {
          range: `'${TRACKING_SHEET}'!M${row}:S${row}`,
          values: [[
            input.note,
            sku.sku,
            input.actor.userId,
            input.groupId,
            input.actor.userId,
            serial,
            input.idempotencyKey
          ]]
        },
        // 建單當下就寫出貨型態，不要空著等下一輪每小時刷新——採購正是在這個
        // 時間點判斷要不要叫貨。
        {
          range: `'${TRACKING_SHEET}'!${TRACKING_LAST_COLUMN}${row}`,
          values: [[sku.stockMode || UNKNOWN_STOCK_MODE]]
        }
      );
      return {
        sku: sku.sku,
        displayName: sku.displayName,
        quantity: item.quantity,
        unit: sku.unit,
        duplicateWarning: (openCounts.get(sku.sku) ?? 0) > 0
      };
    });

    await this.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data }
    });

    return { requestId: newRequestId, idempotentReplay: false, items: createdItems };
  }

  getRequest(targetRequestId) {
    return this.#readRequest(targetRequestId, false);
  }

  getRequestForCancellation(targetRequestId) {
    return this.#readRequest(targetRequestId, true);
  }

  async #readRequest(targetRequestId, includeRequester) {
    const indexResponse = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${TRACKING_SHEET}'!A2:A${MAX_TRACKING_ROW}`
    });

    const rowNumbers = (indexResponse.data.values ?? [])
      .map((row, index) => row[0] === targetRequestId ? index + 2 : 0)
      .filter(Boolean);
    if (rowNumbers.length === 0) throw new NotFoundError(`找不到補貨單 ${targetRequestId}`);

    const firstRow = rowNumbers[0];
    const lastRow = rowNumbers.at(-1);
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${TRACKING_SHEET}'!A${firstRow}:${TRACKING_LAST_COLUMN}${lastRow}`
    });
    const requestRows = (response.data.values ?? [])
      .map((row, index) => ({ row, rowNumber: index + firstRow }))
      .filter(({ row }) => row[0] === targetRequestId);
    const items = await this.#resolveTrackingItems(requestRows);
    if (items.length === 0) throw new NotFoundError(`找不到補貨單 ${targetRequestId}`);
    return {
      requestId: targetRequestId,
      requestedAt: items[0].requestedAt,
      applicant: items[0].applicant,
      note: items[0].note,
      groupId: items[0].sourceGroupId,
      ...(includeRequester ? { requesterUserId: String(requestRows[0].row[14] ?? '') } : {}),
      items,
      [REQUEST_INTERNAL]: {
        applicantUserId: String(requestRows[0]?.row[14] ?? '')
      }
    };
  }

  async listTodoAssignees() {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId, range: `'${AUTH_SHEET}'!A2:E1000`
    });
    const seen = new Set();
    return (response.data.values ?? []).filter(row => {
      if (!row[0] || seen.has(row[0])) return false;
      seen.add(row[0]);
      return row[3] === '是' && String(row[1] || '').trim();
    }).map(row => ({ id: String(row[0]), name: String(row[1]).trim().slice(0, 80) }));
  }

  async getAuthorization(userId) {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${AUTH_SHEET}'!A2:E1000`
    });
    const row = (response.data.values ?? []).find((value) => value[0] === userId);
    if (!row) return { role: '申請人', enabled: true, exists: false };
    return {
      role: String(row[2] || '申請人'),
      enabled: row[3] === '是',
      exists: true
    };
  }

  updateAuthorization(input) {
    return this.#enqueue(() => this.#updateAuthorization(input));
  }

  async #updateAuthorization(input) {
    const actorUserId = String(input.actor?.userId ?? '');
    const targetUserId = String(input.target?.userId ?? '');
    const displayName = String(input.target?.displayName || 'LINE 成員');
    if (!actorUserId || !targetUserId) throw new ValidationError('授權操作缺少成員識別資料');
    if (input.enabled && !AUTHORIZATION_ROLES.has(input.role)) {
      throw new ValidationError('授權角色不正確');
    }
    if (actorUserId === targetUserId && (!input.enabled || input.role !== '管理員')) {
      throw new ConflictError('管理員不能停用自己或移除自己的管理員權限');
    }

    const [operation, authResponse] = await Promise.all([
      this.#findOperation(input.idempotencyKey),
      this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `'${AUTH_SHEET}'!A2:E1000`
      })
    ]);
    const operationType = input.enabled ? '授權' : '停用';
    const rows = authResponse.data.values ?? [];
    const existingIndex = rows.findIndex((row) => row[0] === targetUserId);
    const existingRow = existingIndex >= 0 ? rows[existingIndex] : [];
    const role = input.enabled ? input.role : String(existingRow[2] || '申請人');

    if (operation.existing) {
      if (operation.type !== operationType || operation.requestId !== targetUserId) {
        throw new ConflictError('操作金鑰已被其他操作使用');
      }
      return {
        role: String(existingRow[2] || role),
        enabled: existingRow[3] === '是',
        idempotentReplay: true
      };
    }

    const firstEmptyIndex = rows.findIndex((row) => !row[0]);
    const targetRow = (existingIndex >= 0
      ? existingIndex
      : (firstEmptyIndex >= 0 ? firstEmptyIndex : rows.length)) + 2;
    const serial = sheetSerial(this.now());
    const data = [
      {
        range: `'${AUTH_SHEET}'!A${targetRow}:E${targetRow}`,
        values: [[targetUserId, displayName, role, input.enabled ? '是' : '否', existingRow[4] ?? '']]
      },
      {
        range: `'${OPERATIONS_SHEET}'!A${operation.nextRow}:F${operation.nextRow}`,
        values: [[
          input.idempotencyKey,
          operationType,
          targetUserId,
          actorUserId,
          serial,
          `${displayName}｜${role}｜${input.enabled ? '啟用' : '停用'}`
        ]]
      }
    ];
    await this.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data }
    });
    return { role, enabled: input.enabled, idempotentReplay: false };
  }

  async #cancelRequest(input) {
    const isOrderedCancellation = input.mode === 'ordered';
    const operationType = isOrderedCancellation ? '取消採購' : '取消補貨';
    const operation = await this.#findOperation(input.idempotencyKey);
    if (operation.existing) {
      if (operation.requestId !== input.requestId || operation.type !== operationType) {
        throw new ConflictError('操作金鑰已被其他操作使用');
      }
      return { ...(await this.getRequest(input.requestId)), idempotentReplay: true };
    }

    await this.#checkDraftReservation(input.requestId);
    const request = await this.getRequest(input.requestId);
    if (isOrderedCancellation) {
      const validStatuses = request.items.every((item) => ['已下單', '取消'].includes(item.status));
      const hasOrderedItem = request.items.some((item) => item.status === '已下單');
      const hasReceivedItem = request.items.some((item) => item.receivedQuantity !== 0);
      if (!validStatuses || !hasOrderedItem || hasReceivedItem) {
        throw new ConflictError('只有尚未到貨且狀態為已下單的補貨單可以取消採購');
      }
    } else if (request.items.some((item) => item.status !== '待確認')) {
      throw new ConflictError('只有尚未下單且所有品項皆為待確認的補貨單可以取消');
    }

    const itemsToCancel = isOrderedCancellation
      ? request.items.filter((item) => item.status === '已下單')
      : request.items;
    const serial = sheetSerial(this.now());
    const data = itemsToCancel.flatMap((item) => [
      { range: `'${TRACKING_SHEET}'!G${item.rowNumber}`, values: [['取消']] },
      {
        range: `'${TRACKING_SHEET}'!Q${item.rowNumber}:R${item.rowNumber}`,
        values: [[input.actor.userId, serial]]
      }
    ]);
    data.push({
      range: `'${OPERATIONS_SHEET}'!A${operation.nextRow}:F${operation.nextRow}`,
      values: [[
        input.idempotencyKey,
        operationType,
        input.requestId,
        input.actor.userId,
        serial,
        `取消 ${itemsToCancel.length} 項；原單共 ${request.items.length} 項`
      ]]
    });
    await this.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data }
    });

    return {
      ...request,
      items: request.items.map((item) => ({ ...item, status: '取消', outstandingQuantity: 0 })),
      idempotentReplay: false
    };
  }

  async #reserveCatalogSyncTrigger(input) {
    const actorUserId = String(input.actor?.userId ?? '');
    const idempotencyKey = String(input.idempotencyKey ?? '');
    if (!actorUserId || !idempotencyKey) {
      throw new ValidationError('飛鼠商品同步缺少操作人或事件識別碼');
    }

    const operationType = '同步飛鼠商品';
    const jobName = 'flyingmouse-catalog-sync';
    const operation = await this.#findOperation(idempotencyKey);
    if (operation.existing) {
      if (operation.type !== operationType || operation.requestId !== jobName) {
        throw new ConflictError('操作金鑰已被其他操作使用');
      }
      return { idempotentReplay: true };
    }

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `'${OPERATIONS_SHEET}'!A${operation.nextRow}:F${operation.nextRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[
        idempotencyKey,
        operationType,
        jobName,
        actorUserId,
        sheetSerial(this.now()),
        'LINE 管理員觸發自動飛鼠商品同步'
      ]] }
    });
    return { idempotentReplay: false };
  }

  async #confirmOrder(input) {
    const operation = await this.#findOperation(input.idempotencyKey);
    if (operation.existing) {
      if (operation.requestId !== input.requestId || operation.type !== '確認下單') {
        throw new ConflictError('操作金鑰已被其他操作使用');
      }
      return { ...(await this.getRequest(input.requestId)), idempotentReplay: true };
    }

    await this.#checkDraftReservation(input.requestId);
    const request = await this.getRequest(input.requestId);
    const inputMap = new Map(input.items.map((item) => [item.sku, item]));
    if (inputMap.size !== input.items.length) {
      throw new ValidationError('同一張補貨單的 SKU 不可重複');
    }
    if (request.items.some((item) => !inputMap.has(item.sku))) {
      throw new ValidationError('原補貨品項不可省略；不採購時請將下單數量設為 0');
    }
    if (request.items.some((item) => item.status !== '待確認')) {
      throw new ConflictError('此補貨單已確認下單或已結案');
    }

    const requestSkuSet = new Set(request.items.map((item) => item.sku));
    const additions = input.items.filter((item) => !requestSkuSet.has(item.sku));
    if (additions.some((item) => item.orderedQuantity < 1)) {
      throw new ValidationError('採購追加品項的下單數量必須是正整數');
    }

    let additionSkus = new Map();
    let additionStartRow = 0;
    if (additions.length > 0) {
      const availableSkus = await this.listAvailableSkus();
      additionSkus = new Map(availableSkus.map((sku) => [sku.sku, sku]));
      const invalidSkus = additions.filter((item) => !additionSkus.has(item.sku)).map((item) => item.sku);
      if (invalidSkus.length > 0) {
        throw new ValidationError('部分追加 SKU 已停用或不存在', { invalidSkus });
      }
      additionStartRow = await this.#findAppendRow(additions.length);
    }

    const serial = sheetSerial(this.now());
    const applicantUserId = request[REQUEST_INTERNAL]?.applicantUserId ?? '';
    const data = request.items.flatMap((item) => {
      const update = inputMap.get(item.sku);
      const status = update.orderedQuantity === 0 ? '取消' : '已下單';
      return [
        {
          range: `'${TRACKING_SHEET}'!G${item.rowNumber}:I${item.rowNumber}`,
          values: [[status, update.orderedQuantity, update.expectedDate ? dateSerial(update.expectedDate) : '']]
        },
        {
          range: `'${TRACKING_SHEET}'!Q${item.rowNumber}:R${item.rowNumber}`,
          values: [[input.actor.userId, serial]]
        }
      ];
    });

    const addedItems = additions.map((update, index) => {
      const sku = additionSkus.get(update.sku);
      const rowNumber = additionStartRow + index;
      data.push(
        {
          range: `'${TRACKING_SHEET}'!A${rowNumber}:D${rowNumber}`,
          values: [[request.requestId, request.requestedAt, request.applicant, sku.displayName]]
        },
        {
          range: `'${TRACKING_SHEET}'!F${rowNumber}:J${rowNumber}`,
          values: [[0, '已下單', update.orderedQuantity, dateSerial(update.expectedDate), 0]]
        },
        {
          range: `'${TRACKING_SHEET}'!M${rowNumber}:S${rowNumber}`,
          values: [[
            request.note,
            sku.sku,
            applicantUserId,
            request.groupId,
            input.actor.userId,
            serial,
            input.idempotencyKey
          ]]
        },
        {
          range: `'${TRACKING_SHEET}'!${TRACKING_LAST_COLUMN}${rowNumber}`,
          values: [[sku.stockMode || UNKNOWN_STOCK_MODE]]
        }
      );
      return {
        rowNumber,
        requestId: request.requestId,
        requestedAt: request.requestedAt,
        applicant: request.applicant,
        displayName: sku.displayName,
        unit: sku.unit,
        requestedQuantity: 0,
        status: '已下單',
        orderedQuantity: update.orderedQuantity,
        expectedDate: update.expectedDate,
        receivedQuantity: 0,
        outstandingQuantity: update.orderedQuantity,
        duplicateWarning: '',
        note: request.note,
        sku: sku.sku,
        sourceGroupId: request.groupId,
        purchaseAdded: true
      };
    });
    data.push({
      range: `'${OPERATIONS_SHEET}'!A${operation.nextRow}:F${operation.nextRow}`,
      values: [[
        input.idempotencyKey,
        '確認下單',
        input.requestId,
        input.actor.userId,
        serial,
        `共 ${input.items.length} 項，追加 ${additions.length} 項`
      ]]
    });
    await this.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data }
    });

    const items = request.items.map((item) => {
      const update = inputMap.get(item.sku);
      return {
        ...item,
        status: update.orderedQuantity === 0 ? '取消' : '已下單',
        orderedQuantity: update.orderedQuantity,
        expectedDate: update.expectedDate,
        outstandingQuantity: update.orderedQuantity
      };
    }).concat(addedItems);
    return { ...request, items, idempotentReplay: false };
  }

  async #confirmReceipt(input) {
    const operation = await this.#findOperation(input.idempotencyKey);
    if (operation.existing) {
      if (operation.requestId !== input.requestId || operation.type !== '到貨確認') {
        throw new ConflictError('操作金鑰已被其他操作使用');
      }
      return { ...(await this.getRequest(input.requestId)), idempotentReplay: true };
    }

    const request = await this.getRequest(input.requestId);
    const requestMap = new Map(request.items.map((item) => [item.sku, item]));
    const receivedAt = this.now();
    const serial = sheetSerial(receivedAt);
    const updated = [];
    const data = [];
    let correctionCount = 0;
    for (const receipt of input.items) {
      const item = requestMap.get(receipt.sku);
      if (!item) throw new ValidationError(`SKU ${receipt.sku} 不在此補貨單`);
      if (item.skuCorrectionError) {
        throw new ConflictError(`SKU ${item.canonicalSku} 的規格修正無法套用：${item.skuCorrectionError}`);
      }
      if (!['已下單', '部分到貨'].includes(item.status)) {
        throw new ConflictError(`SKU ${receipt.sku} 目前不可登記到貨`);
      }
      const newTotal = item.receivedQuantity + receipt.receivedQuantity;
      if (newTotal > item.orderedQuantity) {
        throw new ValidationError(`SKU ${receipt.sku} 的累計到貨量不可超過下單量`);
      }
      const status = newTotal === item.orderedQuantity ? '已完成' : '部分到貨';
      if (item.skuCorrectionPending) {
        correctionCount += 1;
        data.push(
          { range: `'${TRACKING_SHEET}'!D${item.rowNumber}`, values: [[item.displayName]] },
          { range: `'${TRACKING_SHEET}'!N${item.rowNumber}`, values: [[item.sku]] },
          // 這一列可能同時被推進成已完成，之後就不再進入每小時刷新的範圍；
          // W 沒在這裡一起換掉的話，舊 SKU 的型態會永久留著。
          {
            range: `'${TRACKING_SHEET}'!${TRACKING_LAST_COLUMN}${item.rowNumber}`,
            values: [[item.stockMode || UNKNOWN_STOCK_MODE]]
          },
          { range: `'${TRACKING_SHEET}'!V${item.rowNumber}`, values: [[item.canonicalSku]] }
        );
      }
      data.push(
        { range: `'${TRACKING_SHEET}'!G${item.rowNumber}`, values: [[status]] },
        { range: `'${TRACKING_SHEET}'!J${item.rowNumber}`, values: [[newTotal]] },
        { range: `'${TRACKING_SHEET}'!Q${item.rowNumber}:R${item.rowNumber}`, values: [[input.actor.userId, serial]] }
      );
      updated.push({
        ...item,
        status,
        receivedQuantity: newTotal,
        outstandingQuantity: item.orderedQuantity - newTotal,
        ...(item.skuCorrectionPending ? {
          canonicalSku: item.sku,
          originalSku: item.canonicalSku,
          skuCorrectionPending: false,
          skuCorrectionApplied: true,
          skuCorrectionOriginalSku: item.canonicalSku
        } : {})
      });
    }
    data.push({
      range: `'${OPERATIONS_SHEET}'!A${operation.nextRow}:F${operation.nextRow}`,
      values: [[
        input.idempotencyKey,
        '到貨確認',
        input.requestId,
        input.actor.userId,
        serial,
        `本次 ${updated.length} 項${correctionCount > 0 ? `，套用規格修正 ${correctionCount} 項` : ''}`
      ]]
    });
    if (this.flyingmouseWritebackEnabled) {
      data.push(...await this.#buildWritebackData({ input, receivedAt }));
    }
    await this.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data }
    });

    const updatedMap = new Map(updated.map((item) => [item.sku, item]));
    return {
      ...request,
      items: request.items.map((item) => updatedMap.get(item.sku) ?? item),
      idempotentReplay: false
    };
  }

  async #buildWritebackData({ input, receivedAt }) {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${WRITEBACK_SHEET_NAME}'!A1:O${WRITEBACK_ROW_COUNT}`,
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const events = parseWritebackRows(response.data.values ?? []);
    const existingIds = new Set(events.map((event) => event.eventId));
    const occupiedRows = new Set(events.map((event) => event.rowNumber));
    const additions = input.items.map((receipt) => buildWritebackEvent({
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      sku: receipt.sku,
      receivedQuantity: receipt.receivedQuantity,
      actorUserId: input.actor.userId,
      createdAt: receivedAt
    }));
    for (const event of additions) {
      if (existingIds.has(event.eventId)) {
        throw new ConflictError(`飛鼠庫存回寫事件已存在：${event.eventId}`);
      }
    }
    const takeEmptyRow = () => {
      for (let rowNumber = 2; rowNumber <= WRITEBACK_ROW_COUNT; rowNumber += 1) {
        if (occupiedRows.has(rowNumber)) continue;
        occupiedRows.add(rowNumber);
        return rowNumber;
      }
      throw new ConflictError(`${WRITEBACK_SHEET_NAME} 已滿，請先封存舊事件`);
    };
    return additions.map((event) => {
      const rowNumber = takeEmptyRow();
      return {
        range: `'${WRITEBACK_SHEET_NAME}'!A${rowNumber}:O${rowNumber}`,
        values: [writebackEventRow(event)]
      };
    });
  }

  async #findOperation(key) {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${OPERATIONS_SHEET}'!A2:C5000`
    });
    const rows = response.data.values ?? [];
    const row = rows.find((value) => value[0] === key);
    return {
      existing: Boolean(row),
      type: String(row?.[1] ?? ''),
      requestId: String(row?.[2] ?? ''),
      nextRow: rows.length + 2
    };
  }

  async #findReminderOperation(key) {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${OPERATIONS_SHEET}'!A2:F5000`
    });
    const rows = response.data.values ?? [];
    const index = rows.findIndex((value) => value[0] === key);
    const row = index >= 0 ? rows[index] : null;
    return {
      existing: Boolean(row),
      type: String(row?.[1] ?? ''),
      requestId: String(row?.[2] ?? ''),
      summary: String(row?.[5] ?? ''),
      rowNumber: index >= 0 ? index + 2 : null,
      nextRow: rows.length + 2
    };
  }

  async #updateReminderState(input, state) {
    const operation = await this.#findReminderOperation(input.key);
    if (!operation.existing || operation.type !== '提醒' || operation.requestId !== input.requestId) {
      throw new ConflictError(`提醒操作紀錄不一致：${input.key}`);
    }
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `'${OPERATIONS_SHEET}'!F${operation.rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[`${input.summary}｜${state}`]] }
    });
  }

  async #findAppendRow(itemCount) {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${TRACKING_SHEET}'!A2:A${MAX_TRACKING_ROW}`
    });
    const rows = response.data.values ?? [];
    const lastUsedIndex = rows.findLastIndex((row) => row[0]);
    const nextRow = lastUsedIndex < 0 ? 2 : lastUsedIndex + 3;
    if (nextRow + itemCount - 1 > MAX_TRACKING_ROW) {
      throw new ConflictError('補貨追蹤表已滿，請先封存舊資料');
    }
    return nextRow;
  }

  async listReminderCandidates({ at = this.now(), pendingAfterHours = 24 } = {}) {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${TRACKING_SHEET}'!A2:${TRACKING_LAST_COLUMN}${MAX_TRACKING_ROW}`,
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const nowSerial = sheetSerial(at);
    const todaySerial = Math.floor(nowSerial);
    const pendingBefore = nowSerial - pendingAfterHours / 24;
    const candidates = new Map();

    const rows = (response.data.values ?? [])
      .map((row, index) => ({ row, rowNumber: index + 2 }))
      .filter(({ row }) => row[0]);
    for (const item of await this.#resolveTrackingItems(rows)) {
      const requestIdValue = item.requestId;
      const status = item.status;
      if (!requestIdValue || CLOSED_STATUSES.has(status)) continue;
      const requestedAt = Number(item.requestedAt);
      const expectedDate = Number(item.expectedDate);
      const outstanding = item.outstandingQuantity;
      const kind = status === '待確認' && Number.isFinite(requestedAt) && requestedAt <= pendingBefore
        ? 'pending'
        : Number.isFinite(expectedDate) && expectedDate < todaySerial && outstanding > 0
          ? 'overdue'
          : '';
      if (!kind) continue;

      const key = `${kind}:${requestIdValue}`;
      const candidate = candidates.get(key) ?? {
        kind,
        requestId: requestIdValue,
        groupId: item.sourceGroupId,
        items: []
      };
      candidate.items.push({
        sku: item.sku,
        displayName: item.displayName,
        status,
        outstandingQuantity: outstanding,
        unit: item.unit
      });
      candidates.set(key, candidate);
    }
    return [...candidates.values()];
  }

  reserveReminder(input) {
    return this.#enqueue(async () => {
      const operation = await this.#findReminderOperation(input.key);
      if (operation.existing) {
        if (operation.type !== '提醒' || operation.requestId !== input.requestId) {
          throw new ConflictError(`提醒操作金鑰已被其他操作使用：${input.key}`);
        }
        if (operation.summary !== `${input.summary}｜發送失敗`) return false;
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `'${OPERATIONS_SHEET}'!F${operation.rowNumber}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[`${input.summary}｜發送中`]] }
        });
        return true;
      }
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `'${OPERATIONS_SHEET}'!A${operation.nextRow}:F${operation.nextRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[
          input.key,
          '提醒',
          input.requestId,
          'system',
          sheetSerial(input.at ?? this.now()),
          `${input.summary}｜發送中`
        ]] }
      });
      return true;
    });
  }

  failReminder(input) {
    return this.#enqueue(() => this.#updateReminderState(input, '發送失敗'));
  }

  completeReminder(input) {
    return this.#enqueue(() => this.#updateReminderState(input, '已發送'));
  }

  async #findPositions(idempotencyKey) {
    const response = await this.sheets.spreadsheets.values.batchGet({
      spreadsheetId: this.spreadsheetId,
      ranges: [
        `'${TRACKING_SHEET}'!A2:A${MAX_TRACKING_ROW}`,
        `'${TRACKING_SHEET}'!S2:S${MAX_TRACKING_ROW}`
      ]
    });
    const [idRange, keyRange] = response.data.valueRanges ?? [];
    const ids = idRange?.values ?? [];
    const keys = keyRange?.values ?? [];
    const existingIndex = keys.findIndex((row) => row[0] === idempotencyKey);
    const firstEmptyIndex = ids.findIndex((row) => !row[0]);

    return {
      existingRequestId: existingIndex >= 0 ? String(ids[existingIndex]?.[0] ?? '') : '',
      nextRow: (firstEmptyIndex >= 0 ? firstEmptyIndex : ids.length) + 2
    };
  }

  async getNotificationGroupId() {
    const { row, value } = await this.#findSetting('NOTIFICATION_GROUP_ID');
    return row ? value : '';
  }

  saveNotificationGroupId(groupId) {
    if (!groupId) return Promise.resolve(false);
    return this.#enqueue(() => this.#saveNotificationGroupId(groupId));
  }

  async #saveNotificationGroupId(groupId) {
    const setting = await this.#findSetting('NOTIFICATION_GROUP_ID');
    if (!setting.row) return false;
    if (setting.value) return setting.value === groupId;
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `'${SETTINGS_SHEET}'!B${setting.row}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[groupId]] }
    });
    return true;
  }

  async #findSetting(key) {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${SETTINGS_SHEET}'!A2:B100`
    });
    const rows = response.data.values ?? [];
    const index = rows.findIndex((row) => row[0] === key);
    return index < 0
      ? { row: 0, value: '' }
      : { row: index + 2, value: String(rows[index][1] ?? '') };
  }
}
