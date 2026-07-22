# 實作計畫：飛鼠商品完全自動同步與 LINE 指令

## 架構決策

- 在既有同步器新增明確 `auto` mode，不改變 `review` 與 `read-only` 的原行為。
- 先完成可獨立測試的 `SKU主檔` 自動同步，再把它接入 Cloud Run Job。
- LINE Webhook 只非同步啟動 Job；使用 Cloud Run v2 API 查詢 execution，不等待瀏覽器工作完成。
- 使用既有 Cloud Run 服務帳號與 Job 層級 `roles/run.invoker` + `roles/run.viewer`，不新增 npm 套件。

## Phase 1：商品主檔自動同步

- [x] Task 1：新增 `syncCatalogItems`
  - Acceptance：自動新增新 SKU、更新既有飛鼠 SKU B:H、保留 I:J/K/L:M/N 既有規則。
  - Verify：`node --test test/flyingmouse-operational.test.js`
  - Files：`src/flyingmouse/sheets-operational.js`、`test/flyingmouse-operational.test.js`

- [x] Task 2：接入 `auto` job mode
  - Acceptance：auto 不讀核准狀態；報告含 catalogSync；review 模式零回歸。
  - Verify：`node --test test/flyingmouse-sync.test.js test/flyingmouse-cloud.test.js`
  - Files：`scripts/flyingmouse-sync.mjs`、`scripts/deploy-flyingmouse-job.ps1`、相關測試

### Checkpoint 1

- [x] 飛鼠自動主檔測試通過。
- [x] review/read-only 行為維持。

## Phase 2：LINE 非同步指令

- [x] Task 3：建立 Cloud Run Job runner
  - Acceptance：能取得最新 execution、阻擋執行中重複觸發、啟動新 execution。
  - Verify：`node --test test/flyingmouse-catalog-job.test.js`
  - Files：`src/services/flyingmouse-catalog-job.js`、對應測試、`src/config.js`

- [x] Task 4：接入 LINE 指令與操作紀錄
  - Acceptance：管理員可執行 `同步飛鼠商品`／`查飛鼠同步`；權限、冪等與友善回覆完整。
  - Verify：`node --test test/group-commands.test.js test/webhook.test.js test/sheets-repository.test.js`
  - Files：指令服務、Webhook、Repository、Server 與測試

### Checkpoint 2

- [x] 單一 LINE 事件只會建立一個同步要求。
- [x] 非管理員、重送、已有執行中工作皆不重複啟動。

## Phase 3：文件與完整驗證

- [x] Task 5：更新 README、部署與維運文件。
- [x] Task 6：執行 `npm.cmd test`、`npm.cmd run lint`、`npm.cmd run build`、`git diff --check`。
- [x] Task 7：建立原子提交；正式部署與執行另行取得同意。

## 風險與緩解

| 風險 | 緩解 |
| --- | --- |
| 截斷或錯誤 Excel 汙染主檔 | 精確表頭、唯一 SKU、非負庫存與 90% 飛鼠主檔覆蓋率 |
| 覆寫人工商品 | 只允許 M=`飛鼠` 的既有列被來源覆寫；其他來源同 SKU 整批停止 |
| 重複登入或併發寫入 | LINE 冪等操作紀錄、runner 序列化、執行中 execution 阻擋 |
| 來源暫時缺漏 | 不刪除、不停用、不清空既有 SKU |
| Webhook 等待逾時 | 非同步啟動並另提供查詢指令 |
| 高頻排程與上一次執行重疊 | 每 5 分鐘執行，單次 timeout 4 分鐘，平台重試為 0 |
