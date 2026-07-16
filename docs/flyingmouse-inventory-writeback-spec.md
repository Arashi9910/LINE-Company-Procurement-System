# 規格：到貨後自動回寫飛鼠庫存

## 1. 目標

當有權限的人員在 LINE 補貨系統完成「到貨確認」後，系統將本次各 SKU 的實到數量可靠地排入佇列，並由獨立的 Cloud Run Job 登入飛鼠後台，將該 SKU 的飛鼠庫存增加相同數量。

本功能需支援部分到貨、多次到貨、重送冪等、失敗重試及人工稽核；飛鼠暫時不可用時，不得遺失已在 LINE 確認的到貨資料，也不得盲目重複加庫存。

## 技術棧

- Node.js 22、ES modules。
- Google Sheets API 及既有 `SheetsRepository`。
- Playwright 1.61.0，沿用既有飛鼠登入 session。
- Cloud Run Job、Cloud Scheduler、Secret Manager、Cloud Logging。

## 指令

- 安裝：`npm.cmd ci --ignore-scripts --no-audit --no-fund`
- 全部測試：`npm.cmd test`
- 單項測試：`node --test test/flyingmouse-inventory-writeback.test.js`
- lint：`npm.cmd run lint`
- build：`npm.cmd run build`
- 本機 dry-run：`node scripts/flyingmouse-inventory-writeback.mjs --mode dry-run --spreadsheet-id <ID>`

## 專案結構

- `src/sheets/repository.js`：到貨交易與 outbox 寫入。
- `src/flyingmouse/`：飛鼠查詢、庫存更新及 Sheets queue 存取。
- `scripts/`：worker 入口與 Google Cloud 部署腳本。
- `test/`：Node test runner 單元／整合測試。
- `docs/`：規格、計畫與維運文件。

## 程式風格

沿用現有 ESM、具名 export、dependency injection 與明確驗證：

```js
export function expectedStock(currentStock, receivedQuantity) {
  if (!Number.isInteger(currentStock) || currentStock < 0) {
    throw new Error('飛鼠庫存必須是非負整數');
  }
  if (!Number.isInteger(receivedQuantity) || receivedQuantity < 1) {
    throw new Error('本次到貨量必須是正整數');
  }
  return currentStock + receivedQuantity;
}
```

- 常數使用大寫 snake case；函式與欄位使用 camelCase。
- 不以 catch 吞掉錯誤；將錯誤分類為可重試或需人工確認。
- 外部依賴透過參數注入，測試不得連到正式飛鼠。

## 邊界

- 一律執行：驗證貨號／數量／API 結構、先寫 prepared 狀態、PUT 後再 GET、提交前跑全部測試。
- 需要先詢問：新增雲端服務、建立正式分頁、部署、切 live、第一筆正式 PUT、變更重試頻率。
- 絕不執行：提交帳密或 session、dry-run 發出 PUT、模糊狀態下猜測成功、修改非 stock 欄位、刪除失敗測試。

## 2. 已查證的飛鼠行為

2026-07-16 以既有帳號對正式後台做唯讀檢查，沒有送出任何庫存修改：

- 貨品編輯頁是直接修改「庫存總數」，沒有獨立的「入庫 +N」欄位。
- 貨號可由 `GET /api/admin/part/no/{貨號}` 精確查詢。
- 回傳的 `part.id` 是數字、`part.no` 是字串、`part.stock` 是數字，並含 `stock_history`。
- 後台儲存使用 `PUT /api/admin/part/id/{id}`，送出完整貨品資料。
- 以上是飛鼠後台目前使用的未公開內部 API，不是官方對外契約；頁面改版時可能失效。

因此本版不能直接拿每日快照覆蓋飛鼠，也不能假設第三方具備冪等鍵；必須在每次修改前重新讀取最新庫存並在修改後再次驗證。

## 3. 使用流程

1. 到貨人員在 LINE 到貨頁輸入本次實到數量並確認。
2. LINE 服務在同一次 Google Sheets batch update 中：
   - 累加 `補貨追蹤` 的實到數量與狀態。
   - 寫入既有 `操作紀錄`。
   - 於新分頁 `飛鼠庫存回寫` 為每個 SKU 新增一筆事件。
3. API 回覆到貨成功；飛鼠故障不會讓已排入佇列的事件遺失。
4. `flyingmouse-inventory-writeback` Cloud Run Job 每 5 分鐘讀取可處理事件，依建立順序逐筆執行。
5. Job 以貨號查詢飛鼠最新貨品，計算 `更新後庫存 = 更新前庫存 + 本次到貨量`。
6. Job 先把更新前／後數量與狀態持久化為 `已準備`，再送出 PUT。
7. Job 重新 GET；只有精確等於預期庫存才標記 `已完成`，並更新 `SKU主檔` 的庫存快照。
8. 無法確定是否已成功的事件停止自動處理，標記 `需人工確認`，不再盲目重試。

## 4. 佇列資料結構

新增 Google Sheets 分頁 `飛鼠庫存回寫`：

| 欄 | 欄位 | 說明 |
|---|---|---|
| A | 事件ID | `${到貨冪等鍵}:${SKU}`，唯一且不可修改 |
| B | 建立時間 | 到貨確認時間 |
| C | 補貨單號 | 對應 LINE 補貨單 |
| D | SKU | 必須精確等於飛鼠貨號 |
| E | 本次到貨量 | 正整數增量 |
| F | 狀態 | `待處理`、`已準備`、`等待重試`、`已完成`、`需人工確認` |
| G | 嘗試次數 | 每次開始處理時累加 |
| H | 下次重試時間 | 可重試錯誤的延後時間 |
| I | 飛鼠貨品ID | GET 成功後保存 |
| J | 更新前庫存 | 準備階段保存 |
| K | 預期更新後庫存 | 準備階段保存 |
| L | 完成時間 | 驗證成功時間 |
| M | 最後錯誤 | 已截斷且不得含帳密／cookie |
| N | LINE 操作人ID | 稽核用途 |
| O | 最後處理時間 | 監控與逾時判斷 |

佇列不得保存飛鼠帳號、密碼、cookie、session 或完整 API 回應。

## 5. 冪等與模糊成功處理

### LINE 重送

- 到貨 API 沿用既有冪等鍵。
- 相同冪等鍵重送時直接回傳既有結果，不新增第二筆回寫事件。
- 每個 SKU 的事件 ID 由到貨冪等鍵與 SKU 組成；建立前再次檢查唯一性。

### 飛鼠更新

- `待處理`：重新 GET 最新庫存，保存 `before` 與 `target`，再進入 `已準備`。
- `已準備` 重跑時：
  - 飛鼠目前庫存等於 `target`：視為前次 PUT 已成功，只補登完成。
  - 飛鼠目前庫存等於 `before`：可安全重送同一個 PUT。
  - 其他數量：狀態改為 `需人工確認`，不再自動修改。
- PUT 成功但驗證 GET 失敗時保持 `已準備`，下次依上述規則判斷。
- 不使用「目前庫存大於等於 target」等模糊條件猜測成功。

這個設計能處理多數網路中斷與程序崩潰，但飛鼠沒有公開 API／條件式更新，因此無法提供資料庫等級的絕對 exactly-once；遇到同一瞬間人工改庫存時，以停止並人工確認為優先。

## 6. 飛鼠修改邊界

- 只允許 `https://ss-select.fslol.com`。
- 只呼叫貨品查詢及 `PUT /api/admin/part/id/{整數}`。
- PUT payload 從剛讀到的貨品資料建立白名單欄位，只變更 `stock`：
  `id`、`no`、`mpn`、`name`、`spec_y`、`spec_x`、`gtin`、`storage_location`、`stock`、`op_remark`。
- 送出前再次確認貨品 ID、貨號、更新前庫存及目標庫存都是合法值。
- 不修改名稱、規格、GTIN、儲位、備註、圖片或商品關聯。
- 缺少 SKU、重複查詢結果、負庫存、非整數庫存、欄位結構改變或 4xx 驗證錯誤一律停止該事件。

## 7. 重試與執行方式

- 使用獨立 Cloud Run Job，不在 LINE HTTP request 中啟動瀏覽器。
- 排程預設每 5 分鐘，單一 task，單次最多處理 20 筆，依建立時間及同 SKU 順序處理。
- Cloud Run 自動 retry 設為 0；應用程式自行決定是否重試，避免平台在模糊成功後立即重送。
- 暫時性登入、網路或 5xx 錯誤採 5、15、60 分鐘退避，最多 5 次；之後改為 `需人工確認`。
- 一次執行中任何事件失敗，不影響其他 SKU；但同一 SKU 的後續事件要等前一事件完成或人工處理。
- worker 需輸出結構化 Cloud Logging：事件 ID、補貨單號、SKU、狀態與錯誤類型；不得輸出機密或完整 payload。

## 8. 上線控制

- `FLYINGMOUSE_WRITEBACK_ENABLED` 預設為 `false`。
- `FLYINGMOUSE_WRITEBACK_MODE` 支援 `dry-run` 與 `live`，預設 `dry-run`。
- 部署順序：建立佇列分頁 → 部署 worker（dry-run）→ 部署 LINE enqueue 功能（仍 disabled）→ 測試 → 切換 live → 啟用 enqueue。
- 正式啟用與第一筆真實庫存修改需要使用者明確同意。
- 舊的每日 03:00 新品／圖片／庫存快照同步維持原排程，兩個 Job 分開部署及追蹤版本。

## 9. 不在本版範圍

- 不從報關 App 自動判斷到貨。
- 不處理退貨、取消到貨或負向扣庫存。
- 不自動修正飛鼠人工盤點差異。
- 不變更飛鼠商品資料及圖片。
- 不處理 LINE LIFF 公司／群組邊界強化（依先前決定暫緩）。

## 10. 測試策略

- 單元測試：事件 ID、佇列欄位、部分到貨、多 SKU、重送、不合法數量。
- repository 測試：追蹤表、操作紀錄、回寫事件在同一 batch；任何驗證失敗不得部分寫入。
- worker 測試：精確 SKU、正常加庫存、GET／PUT／驗證順序、白名單 payload。
- 模糊成功測試：`current == target` 補登成功、`current == before` 安全重送、其他數量轉人工確認。
- 失敗測試：登入失敗、API 結構改變、404、5xx、驗證 GET 不一致、最大重試。
- dry-run 整合測試：登入正式飛鼠並 GET 真實 SKU，但禁止 PUT。
- 正式驗收：由使用者選一筆實際到貨 SKU，以真實數量確認 LINE、佇列、飛鼠庫存歷史與 `SKU主檔` 快照一致。

## 11. 驗收條件

1. LINE 同一到貨事件無論重送幾次，每個 SKU 只產生一筆回寫事件。
2. 部分到貨每次只增加本次數量，不以累計到貨量重複增加。
3. 正常事件在排程後 5 分鐘級距內完成，飛鼠庫存增加正確數量。
4. worker 中斷後可依 `before/target` 恢復，不盲目重複加庫存。
5. 飛鼠庫存發生非預期變動時自動停止並留下可查的人工確認狀態。
6. 飛鼠故障不會遺失 LINE 已確認且已排入佇列的到貨事件。
7. 所有測試、lint、build 通過；dry-run 不產生任何 PUT。

## 12. 待核准的預設決策

- 到貨後不是同步等待飛鼠，而是排入佇列，每 5 分鐘處理。
- 新增 `飛鼠庫存回寫` 分頁作為稽核佇列。
- 飛鼠不可用時保留 LINE 到貨結果並重試，不讓到貨人員卡在頁面上。
- 不確定是否成功時停止自動處理，不猜測、不再次加庫存。
- 第一版不處理負向調整與 LINE 失敗通知。
