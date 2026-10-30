# 飛鼠每小時合併同步 Job 規格

## Objective

將「飛鼠商品主檔與圖片同步」及「到貨庫存正式回寫」合併到同一個 Cloud Run Job，降低每次最少一分鐘的重複計費。正式環境每小時整點執行一次；LINE 管理員原有的「同步飛鼠商品」指令仍啟動同一個 Job。

成功條件：

- 單次 execution 依序完成商品同步及庫存回寫。
- 商品同步失敗時不執行庫存回寫，execution 以失敗結束。
- 任一階段失敗時不得回報整體成功。
- 正式 Scheduler 使用 `0 * * * *` 與 `Asia/Taipei`。
- 新 Job 手動驗收成功後，才停止舊的五分鐘庫存回寫 Scheduler。
- 合併後正式環境只保留一個會登入飛鼠的排程。

## Tech Stack

- Node.js 22，ES Modules。
- Playwright 1.61.0。
- Google Sheets API、Cloud Run Jobs、Cloud Scheduler、Secret Manager。
- 沿用 `scripts/flyingmouse-sync.mjs` 與 `scripts/flyingmouse-inventory-writeback.mjs`，不新增套件。

## Commands

```powershell
node --test test/flyingmouse-combined-job.test.js test/flyingmouse-cloud.test.js
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

正式部署：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy-flyingmouse-job.ps1 `
  -ProjectId line-restock-20260714 `
  -SheetMode auto `
  -WritebackMode live `
  -ApproveLive `
  -ExecuteNow
```

## Project Structure

- `scripts/flyingmouse-combined-job.mjs`：合併入口及階段協調。
- `scripts/flyingmouse-sync.mjs`：商品、圖片與主檔同步。
- `scripts/flyingmouse-inventory-writeback.mjs`：庫存回寫 queue worker。
- `scripts/deploy-flyingmouse-job.ps1`：合併 Job 與整點 Scheduler 部署。
- `test/`：入口順序、失敗短路及雲端設定測試。
- `docs/`：正式操作與驗收紀錄。

## Code Style

沿用現有 ESM、camelCase 與 dependency injection：

```js
export async function runFlyingMouseCombinedJob(options, dependencies = {}) {
  const catalog = await dependencies.runCatalog(options.catalog);
  const writeback = await dependencies.runWriteback(options.writeback);
  return Object.freeze({ catalog, writeback });
}
```

## Testing Strategy

- 單元測試：驗證商品先於庫存、成功摘要與失敗短路。
- 靜態部署測試：驗證映像包含合併入口、每小時 cron、`auto/live` 環境及零平台重試。
- 完整回歸：全套 Node 測試、Lint、Build。
- 正式驗收：手動 execution 成功，log 同時包含 `catalog` 與 `writeback` 結果，再切換 Scheduler。

## Boundaries

- Always：帳密只由 Secret Manager 注入；正式回寫需要 `-ApproveLive`；新流程成功後才停用舊排程。
- Ask first：變更 Sheet schema、刪除舊 Cloud Run Job、輪替正式 Token、改為更高執行頻率。
- Never：把密碼或 Token 寫入程式、文件或 Git；開啟 Cloud Run 平台重試；在驗收前同時啟用兩個飛鼠登入排程。

## Success Criteria

1. 合併入口的順序與失敗行為有測試保護。
2. 所有測試、Lint、Build 通過。
3. 正式合併 execution 成功，商品與圖片同步完成，庫存 queue 無錯誤。
4. `flyingmouse-catalog-sync-daily` 改為每小時整點且啟用。
5. `flyingmouse-inventory-writeback-every-5-minutes` 已刪除，舊 Job 本體保留供回復。

## Open Questions

無。執行頻率及合併方向已由使用者確認。
