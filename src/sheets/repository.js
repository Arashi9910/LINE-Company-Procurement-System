import { randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

const TRACKING_SHEET = '補貨追蹤';
const SKU_SHEET = 'SKU主檔';
const PRODUCT_IMAGES_SHEET = '商品圖片對照';
const SETTINGS_SHEET = '系統設定';
const AUTH_SHEET = '授權人員';
const OPERATIONS_SHEET = '操作紀錄';
const MAX_TRACKING_ROW = 5000;
const CLOSED_STATUSES = new Set(['已完成', '取消']);
const AUTHORIZATION_ROLES = new Set(['申請人', '採購確認', '到貨確認', '管理員']);

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

export function createGoogleSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

export class SheetsRepository {
  constructor({ sheets, spreadsheetId, now = () => new Date(), uuid = randomUUID }) {
    this.sheets = sheets;
    this.spreadsheetId = spreadsheetId;
    this.now = now;
    this.uuid = uuid;
    this.writeChain = Promise.resolve();
  }

  async listAvailableSkus() {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${SKU_SHEET}'!A2:N`
    });

    return (response.data.values ?? [])
      .filter((row) => row[0] && row[9] === '是')
      .map((row) => ({
        sku: String(row[0]),
        productName: String(row[1] ?? ''),
        spec1: String(row[2] ?? ''),
        spec2: String(row[3] ?? ''),
        stockSnapshot: Number(row[4] ?? 0),
        displayName: String(row[7] || row[1] || row[0]),
        searchKeywords: String(row[10] ?? ''),
        unit: String(row[11] || '件'),
        updatedAt: String(row[13] ?? '')
      }));
  }

  async listProductImages() {
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `'${PRODUCT_IMAGES_SHEET}'!A2:O`
      });

      return (response.data.values ?? [])
        .filter((row) => row[1])
        .map((row) => ({
          productId: String(row[2] ?? ''),
          sku: String(row[1]),
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
      range: `'${TRACKING_SHEET}'!A2:S${MAX_TRACKING_ROW}`
    });

    return (response.data.values ?? [])
      .filter((row) => row[0] && !CLOSED_STATUSES.has(row[6]))
      .map((row) => ({
        requestId: String(row[0]),
        displayName: String(row[3] ?? ''),
        status: String(row[6] ?? ''),
        orderedQuantity: Number(row[7] ?? 0),
        receivedQuantity: Number(row[9] ?? 0),
        outstandingQuantity: Number(row[10] ?? 0),
        sku: String(row[13] ?? '')
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
      range: `'${TRACKING_SHEET}'!A2:N${lastIndex + 2}`,
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    return (response.data.values ?? [])
      .filter((row) => row[0])
      .map((row) => ({
        requestId: String(row[0]),
        requestedAt: row[1] ?? '',
        applicant: String(row[2] ?? ''),
        displayName: String(row[3] ?? ''),
        unit: String(row[4] || '件'),
        requestedQuantity: Number(row[5] ?? 0),
        status: String(row[6] ?? ''),
        orderedQuantity: Number(row[7] ?? 0),
        receivedQuantity: Number(row[9] ?? 0),
        outstandingQuantity: Number(row[10] ?? 0),
        sku: String(row[13] ?? '')
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

  #enqueue(run) {
    const result = this.writeChain.then(run, run);
    this.writeChain = result.catch(() => undefined);
    return result;
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

  async getRequest(targetRequestId) {
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
      range: `'${TRACKING_SHEET}'!A${firstRow}:S${lastRow}`
    });
    const items = (response.data.values ?? [])
      .map((row, index) => ({ row, rowNumber: index + firstRow }))
      .filter(({ row }) => row[0] === targetRequestId)
      .map(({ row, rowNumber }) => ({
        rowNumber,
        requestId: String(row[0]),
        requestedAt: String(row[1] ?? ''),
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
        sourceGroupId: String(row[15] ?? '')
      }));
    if (items.length === 0) throw new NotFoundError(`找不到補貨單 ${targetRequestId}`);
    return {
      requestId: targetRequestId,
      requestedAt: items[0].requestedAt,
      applicant: items[0].applicant,
      note: items[0].note,
      groupId: items[0].sourceGroupId,
      items
    };
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

  async #confirmOrder(input) {
    const operation = await this.#findOperation(input.idempotencyKey);
    if (operation.existing) {
      if (operation.requestId !== input.requestId || operation.type !== '確認下單') {
        throw new ConflictError('操作金鑰已被其他操作使用');
      }
      return { ...(await this.getRequest(input.requestId)), idempotentReplay: true };
    }

    const request = await this.getRequest(input.requestId);
    const inputMap = new Map(input.items.map((item) => [item.sku, item]));
    if (inputMap.size !== request.items.length || request.items.some((item) => !inputMap.has(item.sku))) {
      throw new ValidationError('下單品項必須與補貨單一致');
    }
    if (request.items.some((item) => item.status !== '待確認')) {
      throw new ConflictError('此補貨單已確認下單或已結案');
    }

    const serial = sheetSerial(this.now());
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
    data.push({
      range: `'${OPERATIONS_SHEET}'!A${operation.nextRow}:F${operation.nextRow}`,
      values: [[
        input.idempotencyKey,
        '確認下單',
        input.requestId,
        input.actor.userId,
        serial,
        `共 ${request.items.length} 項`
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
    });
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
    const serial = sheetSerial(this.now());
    const updated = [];
    const data = [];
    for (const receipt of input.items) {
      const item = requestMap.get(receipt.sku);
      if (!item) throw new ValidationError(`SKU ${receipt.sku} 不在此補貨單`);
      if (!['已下單', '部分到貨'].includes(item.status)) {
        throw new ConflictError(`SKU ${receipt.sku} 目前不可登記到貨`);
      }
      const newTotal = item.receivedQuantity + receipt.receivedQuantity;
      if (newTotal > item.orderedQuantity) {
        throw new ValidationError(`SKU ${receipt.sku} 的累計到貨量不可超過下單量`);
      }
      const status = newTotal === item.orderedQuantity ? '已完成' : '部分到貨';
      data.push(
        { range: `'${TRACKING_SHEET}'!G${item.rowNumber}`, values: [[status]] },
        { range: `'${TRACKING_SHEET}'!J${item.rowNumber}`, values: [[newTotal]] },
        { range: `'${TRACKING_SHEET}'!Q${item.rowNumber}:R${item.rowNumber}`, values: [[input.actor.userId, serial]] }
      );
      updated.push({
        ...item,
        status,
        receivedQuantity: newTotal,
        outstandingQuantity: item.orderedQuantity - newTotal
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
        `本次 ${updated.length} 項`
      ]]
    });
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

  async listReminderCandidates({ at = this.now(), pendingAfterHours = 24 } = {}) {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${TRACKING_SHEET}'!A2:S${MAX_TRACKING_ROW}`,
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const nowSerial = sheetSerial(at);
    const todaySerial = Math.floor(nowSerial);
    const pendingBefore = nowSerial - pendingAfterHours / 24;
    const candidates = new Map();

    for (const row of response.data.values ?? []) {
      const requestIdValue = String(row[0] ?? '');
      const status = String(row[6] ?? '');
      if (!requestIdValue || CLOSED_STATUSES.has(status)) continue;
      const requestedAt = Number(row[1]);
      const expectedDate = Number(row[8]);
      const outstanding = Number(row[10] ?? 0);
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
        groupId: String(row[15] ?? ''),
        items: []
      };
      candidate.items.push({
        sku: String(row[13] ?? ''),
        displayName: String(row[3] ?? ''),
        status,
        outstandingQuantity: outstanding,
        unit: String(row[4] || '件')
      });
      candidates.set(key, candidate);
    }
    return [...candidates.values()];
  }

  reserveReminder(input) {
    return this.#enqueue(async () => {
      const operation = await this.#findOperation(input.key);
      if (operation.existing) return false;
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
          input.summary
        ]] }
      });
      return true;
    });
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
