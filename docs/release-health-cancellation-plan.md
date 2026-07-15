# 實作計畫：部署追蹤、服務就緒與補貨取消

## Architecture Decisions

- 部署來源必須是乾淨 Git commit；commit SHA 是可重現版本主鍵，Cloud Run revision 是執行環境主鍵。
- `/health` 只代表程序存活；`/ready` 透過唯讀 Sheet 請求代表核心資料相依可用，並同時作為 startup 與 readiness probe。
- 取消沿用現有 Google Sheets 寫入 queue、operation key 與 `操作紀錄`，不新增分頁或欄位。
- LINE Webhook 保持薄層；解析與權限在 service，狀態一致性及批次寫入在 repository。

## Task List

### Phase 1：版本與服務就緒

- [x] Task 1：加入部署版本 metadata
  - Acceptance：config 與 `/health` 提供 commit、revision、部署時間；本機有安全預設值。
  - Verify：`node --test test/config.test.js test/health.test.js`
  - Files：`src/config.js`、`src/app.js`、相關測試。

- [x] Task 2：核心相依 fail-fast 與 Sheet readiness
  - Acceptance：缺少核心相依直接失敗；`/ready` 依唯讀 Sheet 檢查回傳 200／503。
  - Verify：`node --test test/health.test.js test/sheets-repository.test.js`
  - Files：`src/app.js`、`src/sheets/repository.js`、相關測試。

- [x] Task 3：部署腳本綁定 Git 與 Cloud Run probes
  - Acceptance：dirty tree 拒絕部署；設定 env、label、startup/liveness/readiness probes；部署輸出 revision 與 commit。
  - Verify：`node --test test/powershell-compatibility.test.js`
  - Files：`scripts/deploy-gcp.ps1`、測試、`docs/deployment.md`。

### Checkpoint：版本與就緒

- [x] 健康與部署腳本測試通過。
- [x] 不呼叫正式 Google Cloud 或 Google Sheets。

### Phase 2：取消補貨垂直切片

- [x] Task 4：定義取消指令與權限服務
  - Acceptance：解析單號；只允許原申請人或已啟用管理員；狀態錯誤有明確訊息。
  - Verify：`node --test test/group-commands.test.js`
  - Files：`src/services/group-commands.js`、測試。

- [x] Task 5：實作 Sheet 原子取消與冪等
  - Acceptance：整張待確認補貨單改為取消；寫入最後操作者、時間、操作紀錄；重送不重複寫。
  - Verify：`node --test test/sheets-repository.test.js`
  - Files：`src/sheets/repository.js`、測試。

- [x] Task 6：串接 Webhook 回覆
  - Acceptance：只在公司群組處理；合法取消回覆摘要；可預期錯誤轉為友善文字。
  - Verify：`node --test test/webhook.test.js`
  - Files：`src/routes/webhook.js`、`test/webhook.test.js`、使用說明。

### Checkpoint：Complete

- [x] `npm.cmd test`
- [x] `npm.cmd run lint`
- [x] `npm.cmd run build`
- [x] `git diff --check`
- [x] 確認沒有 Claude 橋接或正式環境變更。

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Readiness probe 過度讀取 Sheet | 配額與延遲 | probe 週期設為 60 秒，請求只讀極小範圍 |
| 部署來源無法對應 commit | 無法回復與稽核 | dirty tree 直接拒絕部署 |
| 取消與下單同時發生 | 狀態競爭 | 沿用單一執行個體及 repository write queue，寫入前重新讀取狀態 |
| LINE 重送取消事件 | 重複操作紀錄 | 使用 webhook event ID 與操作紀錄冪等鍵 |
| 誤取消已進入物流流程的單 | 資料不一致 | 只允許整張仍為待確認的補貨單 |

## Open Questions

無。取消權限已確認為原申請人或已啟用管理員。
