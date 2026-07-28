# 規格：到貨後立即觸發飛鼠庫存回寫

## Objective

到貨人員在 LIFF 完成到貨登記後，系統應在到貨資料與 `飛鼠庫存回寫` 事件成功寫入 Google Sheet 後，立即啟動既有的 `flyingmouse-inventory-writeback` Cloud Run Job。Job 沿用現有邏輯，以飛鼠目前庫存加上本次到貨量後回寫；每小時合併 Job 保留作失敗補漏。

使用者看到到貨成功不需要等待飛鼠登入與 PUT 完成，但 API 回應前必須先取得 Cloud Run 對啟動請求的接受結果。

## Tech Stack

- Node.js 22、Express 5。
- Google Sheets API 保存到貨與回寫事件。
- Google Cloud Run Jobs API 啟動獨立庫存回寫 Job。
- Node.js 內建 test runner 驗證路由、設定與 Job runner。

## Commands

- 單項測試：`node --test test/api.test.js test/config.test.js test/flyingmouse-catalog-job.test.js test/powershell-compatibility.test.js`
- 完整測試：`npm test`
- 靜態檢查：`npm run lint`
- 建置：`npm run build`

## Project Structure

- `src/routes/api.js`：到貨 API 與立即觸發結果。
- `src/services/flyingmouse-catalog-job.js`：Cloud Run Job 啟動及執行中防重。
- `src/config.js`、`src/server.js`：獨立回寫 Job 名稱與 runner 組裝。
- `scripts/deploy-gcp.ps1`：正式環境變數、Job 存在性及 invoker／viewer IAM 檢查。
- `test/`：路由、設定、runner 與部署契約測試。

## Code Style

沿用目前的 ESM、兩格縮排、單引號與相依注入方式：

```js
const trigger = await writebackRunner.start();
return { started: true, operation: trigger.operation, execution: trigger.execution };
```

回傳值只包含短資源名稱；日誌不得包含密碼、權杖或完整授權資料。

## Testing Strategy

- 路由測試：新到貨立即啟動一次 Job；冪等重送不得再次啟動。
- 降級測試：Job 已執行中或啟動 API 失敗時，到貨紀錄仍成功並回傳可辨識狀態。
- runner 測試：獨立回寫 runner 指向正確 Job，且沿用執行中防重。
- 部署測試：正式服務收到獨立 Job 名稱，啟用回寫時驗證 Job 並授予 invoker。
- 回歸：完整測試、lint 與 build 全部成功。

## Boundaries

- Always：先完成到貨及 queue 原子寫入，再觸發 Job；冪等重送不重觸發；保留每小時補漏。
- Ask first：部署 Cloud Run 正式 revision、修改正式 IAM、執行真實庫存回寫。
- Never：因 Job 觸發失敗回滾已完成的到貨；並行啟動同一回寫 Job；把完整雲端資源路徑或秘密回傳給前端。

## Success Criteria

1. 非冪等到貨成功後，API 立即呼叫 `flyingmouse-inventory-writeback` 的 `jobs.run`。
2. API 不等待 Job 完成，只等待啟動請求被接受，並回傳 `writebackTrigger` 摘要。
3. 同一到貨操作重送時不再啟動 Job。
4. 已有回寫執行中時不建立並行 execution，queue 仍由既有工作或整點補漏處理；正式服務帳號具備啟動與 execution 查詢權限。
5. 啟動失敗不遺失到貨與 queue，並輸出不含機密的結構化警告。
6. 所有測試、lint 與 build 通過。

## Open Questions

無。使用者已確認要在登記到貨後立即觸發獨立庫存回寫 Job。
