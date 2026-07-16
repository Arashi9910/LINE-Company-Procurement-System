# 實作計畫：到貨後自動回寫飛鼠庫存

## 前置條件

- 規格 `docs/flyingmouse-inventory-writeback-spec.md` 已由使用者核准。
- 既有 `codex/purchase-order-additions-release` 分支與飛鼠每日同步備份可重建。
- 實作前不在正式飛鼠送出 PUT；正式啟用另行確認。

## Task 1：建立回寫事件模型與 Sheets 佇列

**Files：**

- `src/flyingmouse/sheets-writeback.js`
- `test/flyingmouse-writeback-sheets.test.js`
- `docs/flyingmouse-inventory-writeback-spec.md`

**內容：**

- 定義分頁名稱、欄位、狀態與 row parser。
- 建立／驗證分頁標題、篩選、凍結列及狀態驗證。
- 實作待處理事件讀取、準備、完成、重試及人工確認更新。
- 所有錯誤訊息截斷並移除敏感資訊。

**Acceptance：**

- 佇列 parser 拒絕重複事件 ID、不合法數量與未知狀態。
- 每次寫入只修改目標列及允許欄位。
- 測試涵蓋空表、既有事件、重試及人工確認。

**Verify：** `node --test test/flyingmouse-writeback-sheets.test.js`

## Task 2：到貨確認時建立 outbox 事件

**Files：**

- `src/config.js`
- `src/server.js`
- `src/sheets/repository.js`
- `test/sheets-repository.test.js`
- `test/config.test.js`

**內容：**

- 新增 `FLYINGMOUSE_WRITEBACK_ENABLED`，預設關閉。
- 到貨確認依「本次到貨量」為每個 SKU 建立事件 ID。
- 將追蹤列、操作紀錄及佇列事件放入同一 batch update。
- 冪等重送不重複排入事件。

**Acceptance：**

- 部分到貨 2 件只排入 `+2`，下次再到 3 件另建 `+3`。
- 多 SKU 到貨建立多筆事件。
- 佇列缺失／欄位錯誤時不產生部分 receipt 更新。
- 功能旗標關閉時維持現有行為。

**Verify：** `node --test test/config.test.js test/sheets-repository.test.js`

## Task 3：實作飛鼠安全庫存更新器

**Files：**

- `src/flyingmouse/inventory-writeback.js`
- `src/flyingmouse/exporter.js`
- `test/flyingmouse-inventory-writeback.test.js`

**內容：**

- 沿用既有登入流程建立同源 session。
- 實作貨號 GET、完整欄位白名單、PUT 與驗證 GET。
- 實作 dry-run，保證該模式不發出 PUT。
- 實作 `before/target` 恢復規則與結構化錯誤分類。

**Acceptance：**

- 精確貨號與數字庫存才可進入更新。
- payload 只允許規格列出的欄位，且除 stock 外值來自同次最新 GET。
- 模糊狀態不執行 PUT，回傳人工確認結果。
- dry-run 測試明確斷言 PUT 呼叫次數為 0。

**Verify：** `node --test test/flyingmouse-inventory-writeback.test.js`

## Task 4：建立批次 worker 與可控重試

**Files：**

- `scripts/flyingmouse-inventory-writeback.mjs`
- `src/flyingmouse/sheets-writeback.js`
- `test/flyingmouse-writeback-worker.test.js`

**內容：**

- 每次讀取最多 20 筆，按時間及同 SKU 順序處理。
- 每筆先持久化準備狀態，再呼叫飛鼠。
- 成功後更新 queue 與 `SKU主檔` 快照。
- 暫時錯誤採退避；結構錯誤與模糊成功轉人工確認。

**Acceptance：**

- 單筆失敗不阻塞其他 SKU；同 SKU 保持先後順序。
- 最多嘗試 5 次，之後不再自動修改。
- 日誌不含帳密、cookie 或完整 payload。

**Verify：** `node --test test/flyingmouse-writeback-worker.test.js`

## Task 5：部署資產與版本追蹤

**Files：**

- `Dockerfile.flyingmouse-job`
- `.gcloudignore.flyingmouse`
- `scripts/deploy-flyingmouse-writeback-job.ps1`
- `test/flyingmouse-cloud.test.js`
- `docs/flyingmouse-cloud-job.md`

**內容：**

- 同一映像加入 writeback worker，但建立獨立 Cloud Run Job。
- 設定每 5 分鐘、單 task、平台 retry 0、dry-run 預設值。
- 沿用 Secret Manager 帳密及服務帳號。
- 寫入 image tag／Git commit 等部署版本資訊。

**Acceptance：**

- catalog sync 與 writeback 使用不同 Job／Scheduler 名稱。
- 部署腳本預設 dry-run，切 live 需明確參數。
- build context 不包含 `.env.flyingmouse-login.txt` 或下載檔。

**Verify：** `node --test test/flyingmouse-cloud.test.js && npm run lint && npm run build`

## Task 6：本機與雲端 dry-run 驗收

**Files：**

- `docs/flyingmouse-cloud-job.md`
- `docs/PROJECT-HANDOFF-2026-07-15.md`

**內容：**

- 建立並驗證 `飛鼠庫存回寫` 分頁。
- 本機 dry-run 對真實 SKU 執行 GET 與計算，但禁止 PUT。
- 部署 dry-run Job，手動執行並檢查 Cloud Logging。
- 記錄 Job、Scheduler、image、commit 與驗證時間。

**Acceptance：**

- dry-run 可登入、精確找到 SKU、算出 target 並留下安全日誌。
- 飛鼠庫存及 stock history 完全未改變。
- 正式 LINE 服務在功能旗標開啟前維持原行為。

**Verify：** 比對飛鼠 GET 前後資料、Cloud Run execution、Cloud Logging 與 Git commit。

## Task 7：經核准後 live 驗收與正式啟用

**Files：** 無預期程式碼修改；只變更已核准的雲端設定與正式資料。

**內容：**

- 使用者指定一筆真實到貨 SKU 與數量。
- 將 worker 切為 live，仍先保持 enqueue flag 關閉。
- 以受控事件驗證 queue → PUT → GET → 完成。
- 確認正確後才開啟 LINE enqueue flag 與排程。

**Acceptance：**

- 指定 SKU 庫存只增加一次且數量正確。
- queue、飛鼠 stock history、`SKU主檔` 與 Cloud Logging 可互相核對。
- 重跑同事件不再次增加。

**Verify：** 使用者實際驗收並明確同意正式啟用。

## 風險與緩解

| 風險 | 影響 | 緩解 |
|---|---|---|
| 飛鼠內部 API 改版 | worker 停止 | 嚴格欄位驗證、dry-run、4xx 不盲目重試 |
| PUT 成功後斷線 | 可能不確定是否已加庫存 | 先持久化 before/target，重跑時三態判斷 |
| 同時人工改庫存 | 覆蓋或重複 | 每次最新 GET、快速 PUT/GET、數量不符轉人工確認 |
| LINE 重送 | 重複加庫存 | 到貨冪等鍵 + SKU 的唯一事件 ID |
| worker 暫時故障 | 到貨已登記但飛鼠未更新 | queue 保留、退避重試、狀態可稽核 |
| 兩個 worker 重疊 | 同事件競爭 | 單 task、平台 retry 0、短批次；後續如量增再加具條件寫入的外部鎖 |

## 完成定義

- Task 1–5 程式與測試完成。
- Task 6 dry-run 無任何正式庫存異動。
- Task 7 經使用者明確核准並完成一筆真實到貨驗收。
- 所有部署版本、Job、Scheduler 與 commit 已更新交接文件並推送 GitHub。
