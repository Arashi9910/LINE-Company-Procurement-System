# 實作計畫：到貨後立即觸發飛鼠庫存回寫

## Overview

在既有到貨交易完成後加入獨立 Cloud Run Job 觸發器，不改動庫存計算、回寫 queue 或每小時合併工作的責任。

## Architecture Decisions

- 使用現有 `flyingmouse-inventory-writeback`，避免每次到貨重跑商品 Excel、圖片與目錄同步。
- 先提交 Sheet 到貨與 queue，再呼叫 Cloud Run；外部觸發失敗不破壞已提交的業務資料。
- 既有 execution 尚未完成時合併觸發，不允許兩個 worker 同時處理相同 queue。

## Task List

### Phase 1：觸發基礎

- [x] Task 1：加入獨立回寫 Job 設定與 runner
  - Acceptance：runner 指向 `flyingmouse-inventory-writeback` 並保留執行中防重。
  - Verify：`node --test test/config.test.js test/flyingmouse-catalog-job.test.js`
  - Dependencies：None
  - Files：`src/config.js`、`src/services/flyingmouse-catalog-job.js`、相關測試

### Phase 2：到貨垂直流程

- [x] Task 2：到貨成功後立即啟動 Job
  - Acceptance：新操作啟動一次；重送不啟動；失敗時保留到貨並回報安全狀態。
  - Verify：`node --test test/api.test.js`
  - Dependencies：Task 1
  - Files：`src/app.js`、`src/routes/api.js`、`src/server.js`、`test/api.test.js`

### Checkpoint：核心流程

- [x] runner 與 API 測試通過。
- [x] 到貨回應不等待 Job 執行完成。

### Phase 3：部署契約與文件

- [x] Task 3：更新部署參數、IAM 驗證及操作文件
  - Acceptance：啟用回寫時部署腳本確認獨立 Job 存在、授予 invoker／viewer 並傳入 Job 名稱。
  - Verify：`node --test test/powershell-compatibility.test.js`
  - Dependencies：Task 1
  - Files：`scripts/deploy-gcp.ps1`、`.env.example`、`README.md`、部署測試

### Checkpoint：完成

- [x] `npm test`
- [x] `npm run lint`
- [x] `npm run build`
- [ ] 正式部署前取得使用者確認。

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| 重複 API 請求啟動多次 | 高 | 只對 `idempotentReplay=false` 觸發 |
| 同時執行兩個回寫 worker | 高 | runner 啟動前檢查現有 execution，執行中則合併 |
| Cloud Run API 暫時失敗 | 中 | 不回滾到貨；保留 queue，由整點工作補漏 |
| 正式 Job 不存在或缺 IAM | 高 | 部署腳本在啟用功能時 fail fast 並補上 invoker |

## Open Questions

無。
