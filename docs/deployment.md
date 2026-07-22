# Google Cloud 與 LINE 部署手冊

## 必要資料

- Google Cloud 專案 ID 與可用的計費帳戶 ID。
- LINE Messaging API 的 Channel Secret 與 Channel Access Token。
- 與 Messaging API 位於同一 Provider 的 LINE Login Channel ID 與 LIFF ID。
- Google Sheet ID：`16ko37-omRLDxdKXOX-VRwsCG3VyMerAO4EPBX_T10M8`。

任何 Channel Secret、Access Token 或自動產生的簽章金鑰都不得貼進對話、Git 或 Sheet。

## 部署順序

1. 安裝 Git 與 Google Cloud CLI，執行 `gcloud auth login`。
2. 確認要部署的 commit 已完成測試並且工作區乾淨；腳本會拒絕任何 tracked 或 untracked 變更：

   ```powershell
   git status --short
   git rev-parse HEAD
   ```

3. 啟用專案計費；若要由腳本連結計費，傳入 `BillingAccountId`。
4. 以安全提示建立 Secret Manager 版本：

   ```powershell
   .\scripts\configure-secrets.ps1 -ProjectId '<PROJECT_ID>'
   ```

5. 執行部署：

   ```powershell
   .\scripts\deploy-gcp.ps1 `
     -ProjectId '<PROJECT_ID>' `
     -BillingAccountId '<BILLING_ACCOUNT_ID>' `
     -LineLoginChannelId '<LINE_LOGIN_CHANNEL_ID>' `
     -LiffId '<LIFF_ID>'
   ```

   部署腳本預設 `FLYINGMOUSE_WRITEBACK_ENABLED=false`。只有在庫存回寫 queue 與 dry-run Job 已完成驗收後，才可明確加入下列開關，讓確認到貨同步建立回寫事件：

   ```powershell
   .\scripts\deploy-gcp.ps1 `
     -ProjectId '<PROJECT_ID>' `
     -LineLoginChannelId '<LINE_LOGIN_CHANNEL_ID>' `
     -LiffId '<LIFF_ID>' `
     -EnableFlyingmouseWriteback
   ```

   此開關只控制 LINE 服務是否入列；飛鼠是否允許 PUT 仍由獨立 writeback Job 的 `dry-run`／`live` 模式控制。

6. 記錄腳本輸出的 Application version、Git commit、Ready revision 與 Cloud Run URL。部署腳本會確認 `/ready` 回傳同一個 commit，否則部署視為失敗。
7. 將腳本輸出的 Cloud Run 服務帳號 Email 以「編輯者」分享至補貨 Google Sheet。服務帳號不需要取得整個 Drive 的存取權。
8. 將 Cloud Run URL 設為 LIFF Endpoint URL；LINE Webhook URL 設為 `<CLOUD_RUN_URL>/webhook`，再執行 Verify。
9. 邀請 Bot 進入工作群組，輸入「補貨」，確認 `系統設定` 的 `NOTIFICATION_GROUP_ID` 已自動寫入。
10. 在 `授權人員` 分頁把實際採購與到貨人員的角色改為 `採購確認`、`到貨確認` 或 `管理員`。

## 預設雲端設定

- Region：`asia-east1`。
- Cloud Run：最多 1 個執行個體、並行數 20；搭配程式內寫入佇列降低 Sheet 競爭寫入。
- 提醒 Scheduler：週一至週五 10:00，時區 `Asia/Taipei`。
- 新品核准 Scheduler：每分鐘呼叫 `/jobs/flyingmouse-approved-imports`；只讀取 `飛鼠目錄待確認` 與 `SKU主檔`，不登入飛鼠、不下載 Excel，也不執行圖片或全量庫存同步。
- 兩個 HTTP Scheduler 均以自訂 `X-Job-Token` header 傳送 `line-job-token`。Secret 不應包含前後空白或換行；服務端仍會在載入 `JOB_TOKEN` 時移除意外的前後空白，以相容早期建立的 Secret 版本。
- 預算警示：預設每月 `300TWD`，於 50%、90%、100% 通知；預算不會自動停止支出。
- Secret Manager：Cloud Run 服務帳號僅取得四個指定秘密的 `roles/secretmanager.secretAccessor`。
- Startup／readiness probe：`/ready`，確認 Sheet 可讀後才接收流量；liveness probe：`/health`，只判斷程序是否仍存活。持續 readiness 每 60 秒唯讀檢查 `系統設定` 表頭。
- Revision metadata：`APP_VERSION`、`GIT_COMMIT`、`DEPLOYED_AT` 環境變數、`git-commit` Cloud Run label，以及 Cloud Run 自動提供的 `K_REVISION`。

## 驗收

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

- `GET <CLOUD_RUN_URL>/health` 回傳 `ok: true`、正確的 `commit` 與 `revision`。此路徑只代表程序存活；Cloud Run 保留部分以 `z` 結尾的路徑，因此不要使用 `/healthz`。
- `GET <CLOUD_RUN_URL>/ready` 回傳 `ok: true`，且 `commit` 必須與部署 commit 相同；Sheet 無法讀取時應回傳 `503`。
- LINE Developers Console 的 Webhook Verify 成功。
- 手機 LINE 開啟 LIFF，搜尋 SKU、建立多品項申請。
- 採購角色確認下單；到貨角色執行部分到貨與完成。
- 原申請人輸入 `取消補貨 <補貨單號>` 可取消待確認案件；非原申請人、非管理員或已下單案件會被拒絕。
- 採購確認角色輸入 `取消採購 <補貨單號>` 可取消尚未到貨的已下單案件；申請人、部分到貨或已完成案件會被拒絕，且不建立飛鼠回寫事件。
- 手動執行 Scheduler job，確認群組只收到一次提醒。
- 管理員輸入 `同步飛鼠商品`，確認收到已受理回覆，且同一 Webhook 事件不重複啟動。
- 管理員輸入 `查飛鼠同步`，確認能讀取最新 execution 的執行中、成功或失敗狀態。
- 在正式 Job 已明確切換為 `-SheetMode 'auto'` 後，確認飛鼠新品與新規格無需人工核准即寫入 `SKU主檔`，且同一 SKU 重跑不會重複新增。

既有手機端「申請 → 下單 → 部分到貨 → 完成」流程已由使用者於 2026-07-15 完成一輪驗收。新 revision 上線後仍需核對 `/ready`、版本資訊與取消指令。

唯讀核對範例：

```powershell
$health = Invoke-RestMethod '<CLOUD_RUN_URL>/health'
$ready = Invoke-RestMethod '<CLOUD_RUN_URL>/ready'
$health | Select-Object service, version, commit, revision, deployedAt
$ready | Select-Object ok, commit, revision
```

## 官方依據

- Cloud Run 從原始碼部署：https://cloud.google.com/run/docs/deploying-source-code
- Cloud Run 掛載 Secret Manager：https://cloud.google.com/run/docs/configuring/services/secrets
- Cloud Run 健康檢查：https://cloud.google.com/run/docs/configuring/healthchecks
- Cloud Scheduler HTTP job：https://cloud.google.com/sdk/gcloud/reference/scheduler/jobs/create/http
- Cloud Billing budget：https://cloud.google.com/sdk/gcloud/reference/billing/budgets/create
