# 實作計畫：核准新品一分鐘內匯入

## 架構決策

- 保留 03:00 `flyingmouse-catalog-sync` 全量工作，不調高飛鼠登入與 Excel 下載頻率。
- 快速 importer 放在既有 LINE Cloud Run Service，只使用 Sheets API。
- Scheduler 每分鐘呼叫受 `JOB_TOKEN` 保護的路由；匯入函式維持冪等。

## Task 1：從審核列安全重建新品快照

**Files：** `src/flyingmouse/sheets-review.js`、`test/flyingmouse-review.test.js`

**Acceptance：**

- 只處理待處理／新增／核准匯入列。
- 同步鍵、來源指紋、必要欄位與庫存皆通過才可寫入主檔。
- 無核准零寫入；重跑相同 SKU 冪等；異常列改為需重新確認。

**Verify：** `node --test test/flyingmouse-review.test.js`

## Task 2：加入受保護的快速匯入路由

**Files：** `src/sheets/repository.js`、`src/routes/jobs.js`、`test/api.test.js`

**Acceptance：**

- 正確 token 回傳匯入摘要，缺少／錯誤 token 回傳 401。
- 匯入走既有 repository 寫入序列，避免同一服務內寫入交錯。

**Verify：** `node --test test/api.test.js test/sheets-repository.test.js`

## Checkpoint：核心流程

- Sheet 與 API 測試通過。
- 不存在任何 Playwright、飛鼠 URL 或 Excel 呼叫。

## Task 3：建立每分鐘 Scheduler 部署設定

**Files：** `scripts/deploy-gcp.ps1`、`test/powershell-compatibility.test.js`、`docs/deployment.md`

**Acceptance：**

- 建立／更新 `line-replenishment-approved-imports`。
- 排程為 `* * * * *`、Asia/Taipei，呼叫 `/jobs/flyingmouse-approved-imports`。
- 使用既有 `JOB_TOKEN`，不新增或輸出 secret。

**Verify：** `node --test test/powershell-compatibility.test.js`

## Task 4：完整驗證與部署準備

**Files：** `docs/flyingmouse-cloud-job.md`

**Acceptance：**

- `npm.cmd test`、lint、build 全部通過。
- Git commit 與正式部署前後狀態有紀錄。
- 正式部署及 Scheduler 建立前取得使用者確認。

## 風險與緩解

| 風險 | 緩解 |
|---|---|
| 待確認列被人工改壞 | 驗證同步鍵、指紋、欄位與庫存；失敗轉需重新確認 |
| Scheduler 重送 | 主檔 SKU 唯一與一致性判斷，已匯入視為冪等 |
| 與 03:00 同時執行 | 使用整批寫入；同一 SKU 寫入結果一致，後續執行補登狀態 |
| 每分鐘成本 | 無核准時只做兩個 Sheet range 的讀取，不啟動瀏覽器或新 Job |

