# 庫存看板與叫貨提醒實作計畫

規格：`docs/inventory-dashboard-spec.md`｜原則：先寫測試再實作，只讀取飛鼠，不寫入飛鼠

## 步驟

1. **確認飛鼠訂單 API 的未知項目**（用乾跑腳本，只讀取）
   - 確認狀態代碼 0 和 2 分別是處理中和備貨中，算出來的筆數要跟後台分頁上的數字一致。
   - 確認 `part_list[].qty` 有沒有乘過購買數量：找一張買 2 件以上的訂單比對。
   - 確認每頁筆數上限，以及怎麼翻頁。
   - 結果記錄在規格的第 7 節。

2. **`src/flyingmouse/order-reader.js`**
   - 用已登入的頁面在瀏覽器裡呼叫 API，沿用 `inventory-writeback.js` 的 `pageRequest` 寫法。
   - 讀取狀態 0 和 2 的所有訂單並翻頁，回傳每個貨號的處理中數量和備貨中數量。
   - 回傳的筆數要跟 `data.total` 一致，不一致就丟出錯誤。
   - 測試：`test/flyingmouse-order-reader.test.js`，包含翻頁、數量相乘、筆數不符、HTTP 錯誤。

3. **`src/services/inventory-dashboard.js`**（純計算，不讀寫任何資料）
   - 輸入：SKU主檔的庫存快照、訂單統計、補貨追蹤（已叫貨未到）、預購額度。
   - 輸出：每個 SKU 的推算實際庫存、缺口、狀態，以及排序後的清單。
   - 測試：把規格第 3 節的商品 A 驗算表逐列寫成測試；另外測異常、共用貨號、修正後規格。

4. **`src/sheets/inventory-dashboard.js`**
   - 讀取「預購額度」分頁；寫入「庫存看板」分頁，整張覆寫。
   - 加一支腳本 `scripts/setup-inventory-dashboard.mjs`，用來建立這兩個分頁和表頭。
   - **不要動 SKU主檔的欄位**，因為它每次寫入前都會檢查欄位名稱。

5. **接進每小時的排程**
   - 在 `scripts/flyingmouse-combined-job.mjs` 的商品同步之後、回寫之前，加一個看板步驟。
   - 看板失敗不能影響原本的商品同步和回寫，只記錄錯誤。
   - 用環境變數 `INVENTORY_DASHBOARD_ENABLED` 控制開關，預設關閉。

6. **LINE 提醒和指令**
   - 在 `src/services/group-commands.js` 加 `查缺貨` 和 `查庫存`。
   - 叫貨提醒沿用 `reminders.js` 的機制（先預約、再推播，失敗就還原），不重複提醒的依據是「日期＋SKU＋缺口」。
   - 加一個 Scheduler 端點，推播時間等老闆決定。

7. **驗證**
   - `npm test`、`npm run lint`、`npm run build` 都要通過。
   - 用正式資料乾跑一次，產出看板預覽，人工抽查 5 個 SKU，跟飛鼠後台比對。

## 不在這次範圍

- 寫入飛鼠：關閉預購、自動算出可賣數量並回寫。
- 修改現有的到貨回寫邏輯。
- 搬到 Firestore 或其他資料庫。
- 包貨錄影站。

## 上線前要使用者確認

- 部署到正式環境、開啟排程或推播之前，都要先經過使用者同意。
