# 規格：核准新品一分鐘內匯入 LINE 補貨系統

## 目標

每天 03:00 的飛鼠目錄同步維持原流程：下載官方 Excel、找出新品、更新既有 SKU 庫存快照及商品圖片，並把差異寫入 `飛鼠目錄待確認`。

使用者將新品的審核狀態改為 `核准匯入` 後，系統應在一分鐘級距內只讀取待確認表的核准列，將通過驗證的新品寫入 `SKU主檔`，使其立即出現在 LINE 補貨系統。此流程不得重新登入飛鼠、下載 Excel、重跑圖片或全量庫存同步。

## 技術棧

- Node.js 22、ES modules、Express 5。
- Google Sheets API 與既有 `SheetsRepository` 寫入序列。
- 既有 LINE Cloud Run Service。
- Cloud Scheduler 每分鐘呼叫受 `JOB_TOKEN` 保護的內部路由。

## 指令

- 單項測試：`node --test test/flyingmouse-review.test.js test/api.test.js test/powershell-compatibility.test.js`
- 全部測試：`npm.cmd test`
- lint：`npm.cmd run lint`
- build：`npm.cmd run build`

## 專案結構

- `src/flyingmouse/sheets-review.js`：解析核准列、來源指紋驗證及原子匯入。
- `src/sheets/repository.js`：將快速匯入放入既有寫入序列。
- `src/routes/jobs.js`：提供 Scheduler 專用受保護路由。
- `scripts/deploy-gcp.ps1`：建立／更新每分鐘 Scheduler。
- `test/`：核准資料、路由驗證、部署設定測試。

## 程式風格

沿用現有 ESM、dependency injection、明確結果摘要與整批寫入：

```js
const result = await repository.importApprovedCatalogSnapshots({ at: new Date() });
// { approved: 1, imported: 1, idempotent: 0, stale: 0 }
```

- 不把 Sheet 欄位當成可信輸入；所有文字、整數、表頭、同步鍵與指紋都需驗證。
- 無核准項目時只讀取 Sheet，回傳零摘要，不寫入任何儲存格。
- 匯入與審核狀態更新使用同一個 `values.batchUpdate`。

## 流程與資料邊界

1. 03:00 全量同步把新品資料、圖片及來源指紋寫入 `飛鼠目錄待確認`。
2. 使用者只修改審核狀態為 `核准匯入`。
3. Cloud Scheduler 每分鐘呼叫 `/jobs/flyingmouse-approved-imports`。
4. 路由使用既有 `JOB_TOKEN` 驗證，未授權請求回傳 401。
5. importer 只處理：偵測狀態 `待處理`、差異類型 `新增`、審核狀態 `核准匯入`。
6. importer 由該列 E:K 重建新品快照，驗證：
   - 同步鍵精確等於 `新增:${SKU}`。
   - SKU 與商品名稱不可空白。
   - 庫存為非負安全整數。
   - 來源指紋與名稱、規格、GTIN、儲位一致。
   - `SKU主檔` 沒有重複 SKU 且有可用空列。
7. 通過後以同一個 batch 寫入 `SKU主檔` 安全欄位，並把審核狀態更新為 `已匯入`。
8. 已存在且資料一致時視為冪等成功，只把狀態補成 `已匯入`。
9. 指紋、欄位或既有 SKU 不一致時改為 `需重新確認`，不新增主檔。

## 測試策略

- Sheet 單元測試：正常匯入、無核准零寫入、指紋失效、非法庫存、既有 SKU 冪等與衝突。
- API 測試：無 token 401、正確 token 200、回傳匯入摘要。
- 部署測試：Scheduler 名稱、`* * * * *`、Asia/Taipei、受保護路由與既有 secret header。
- 回歸測試：03:00 的 browser export、庫存與圖片同步行為不得改變。

## 邊界

- 一律執行：來源指紋與主檔表頭驗證、同批寫入、冪等處理、完整測試。
- 需要先詢問：部署 LINE 正式 revision、建立每分鐘 Scheduler、變更頻率。
- 絕不執行：快速 importer 登入飛鼠、下載 Excel、更新圖片、全量庫存同步、匯入未核准或非新品列。

## 驗收條件

1. `核准匯入` 後最慢在下一個每分鐘排程加上單次請求時間內出現在 `SKU主檔` 與 LINE 補貨系統。
2. 無核准資料時不產生 Sheet 寫入，也不接觸飛鼠。
3. 一筆核准資料重跑不會建立重複 SKU。
4. 指紋或欄位異常時不匯入，狀態改為 `需重新確認`。
5. 03:00 全量同步排程、庫存更新與圖片同步維持原狀。
6. 全部測試、lint、build 通過，正式部署資訊可追溯至 Git commit。

## 已確認決策

- 使用者核准的是待確認表中的 03:00 資料快照；快速匯入不重新向飛鼠抓取同一商品。
- 目標延遲為一分鐘級距，不採 Google Apps Script onEdit。
- 每分鐘工作沿用 LINE Cloud Run Service 與 `JOB_TOKEN`，不新增另一套帳密。

