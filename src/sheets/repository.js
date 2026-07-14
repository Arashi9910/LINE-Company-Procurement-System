import { randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import { ConflictError, ValidationError } from '../errors.js';

const TRACKING_SHEET = '補貨追蹤';
const SKU_SHEET = 'SKU主檔';
const SETTINGS_SHEET = '系統設定';
const MAX_TRACKING_ROW = 5000;
const CLOSED_STATUSES = new Set(['已完成', '取消']);

function sheetSerial(date) {
  return date.getTime() / 86_400_000 + 25_569;
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

  createRequest(input) {
    const run = () => this.#createRequest(input);
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

  async saveNotificationGroupId(groupId) {
    if (!groupId) return;
    const setting = await this.#findSetting('NOTIFICATION_GROUP_ID');
    if (!setting.row || setting.value === groupId) return;
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `'${SETTINGS_SHEET}'!B${setting.row}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[groupId]] }
    });
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
