# 飛鼠每小時合併同步 Job 實作計畫

## Architecture Decisions

- 沿用 `flyingmouse-catalog-sync` Job 名稱，避免變更 LINE 指令與服務設定。
- 新增薄型協調入口，不複製既有商品或庫存商業邏輯。
- 商品階段成功後才進入庫存階段；錯誤直接由 execution 呈現。
- 部署時先暫停既有商品 Scheduler，手動驗收成功後才恢復每小時排程並移除舊庫存 Scheduler。

## Task List

### Phase 1: Contract

- [x] 新增合併入口失敗優先測試。
  - Acceptance：驗證執行順序、成功摘要與商品失敗時不回寫庫存。
  - Verify：`node --test test/flyingmouse-combined-job.test.js`
  - Files：`test/flyingmouse-combined-job.test.js`

- [x] 更新雲端部署契約測試。
  - Acceptance：驗證每小時 cron、合併入口、live 明確核准及兩階段環境設定。
  - Verify：`node --test test/flyingmouse-cloud.test.js`
  - Files：`test/flyingmouse-cloud.test.js`

### Phase 2: Implementation

- [x] 實作合併入口並加入映像 allow-list。
  - Acceptance：沿用既有兩個 runner，輸出結構化總結。
  - Verify：兩個目標測試通過。
  - Files：`scripts/flyingmouse-combined-job.mjs`、`Dockerfile.flyingmouse-job`、`.gcloudignore.flyingmouse`

- [x] 將部署腳本切換為每小時合併 Job。
  - Acceptance：`auto/live` 可明確部署、重試為 0、timeout 足以完成兩階段。
  - Verify：雲端部署契約測試通過。
  - Files：`scripts/deploy-flyingmouse-job.ps1`

### Checkpoint: Local

- [x] `npm.cmd test`、`npm.cmd run lint`、`npm.cmd run build` 全部通過。
- [x] Git diff 不包含憑證或無關變更。

### Phase 3: Production Cutover

- [ ] 暫停商品 Scheduler，部署並手動執行合併 Job。
- [ ] 驗證 execution 與 Cloud Logging 的兩階段結果。
- [ ] 將商品 Scheduler 設為整點每小時並恢復。
- [ ] 刪除舊庫存五分鐘 Scheduler，保留舊 Job 本體。
- [ ] 回讀正式 Job、Scheduler、LINE health 與 Git 狀態。

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| 合併流程部署失敗 | 商品同步短暫停止 | 庫存舊排程在新 execution 成功前保持啟用 |
| 重複執行造成飛鼠登入壓力 | 多次登入或重複 Sheet 寫入 | 切換期間暫停商品 Scheduler；驗收後才刪舊排程 |
| 商品同步錯誤後仍寫庫存 | 可能使用不完整主檔 | 合併入口 fail-fast，測試保護 |
| queue 過大導致逾時 | 到貨回寫延後 | 保留每次上限 20，合併 timeout 設為 6 分鐘，平台重試 0 |
