# Google Cloud 與 LINE 部署手冊

## 必要資料

- Google Cloud 專案 ID 與可用的計費帳戶 ID。
- LINE Messaging API 的 Channel Secret 與 Channel Access Token。
- 與 Messaging API 位於同一 Provider 的 LINE Login Channel ID 與 LIFF ID。
- Google Sheet ID：`16ko37-omRLDxdKXOX-VRwsCG3VyMerAO4EPBX_T10M8`。

任何 Channel Secret、Access Token 或自動產生的簽章金鑰都不得貼進對話、Git 或 Sheet。

## 部署順序

1. 安裝 Google Cloud CLI 並執行 `gcloud auth login`。
2. 啟用專案計費；若要由腳本連結計費，傳入 `BillingAccountId`。
3. 以安全提示建立 Secret Manager 版本：

   ```powershell
   .\scripts\configure-secrets.ps1 -ProjectId '<PROJECT_ID>'
   ```

4. 執行部署：

   ```powershell
   .\scripts\deploy-gcp.ps1 `
     -ProjectId '<PROJECT_ID>' `
     -BillingAccountId '<BILLING_ACCOUNT_ID>' `
     -LineLoginChannelId '<LINE_LOGIN_CHANNEL_ID>' `
     -LiffId '<LIFF_ID>'
   ```

5. 將腳本輸出的 Cloud Run 服務帳號 Email 以「編輯者」分享至補貨 Google Sheet。服務帳號不需要取得整個 Drive 的存取權。
6. 將 Cloud Run URL 設為 LIFF Endpoint URL；LINE Webhook URL 設為 `<CLOUD_RUN_URL>/webhook`，再執行 Verify。
7. 邀請 Bot 進入工作群組，輸入「補貨」，確認 `系統設定` 的 `NOTIFICATION_GROUP_ID` 已自動寫入。
8. 在 `授權人員` 分頁把實際採購與到貨人員的角色改為 `採購確認`、`到貨確認` 或 `管理員`。

## 預設雲端設定

- Region：`asia-east1`。
- Cloud Run：最多 1 個執行個體、並行數 20；搭配程式內寫入佇列降低 Sheet 競爭寫入。
- Scheduler：週一至週五 10:00，時區 `Asia/Taipei`。
- 預算警示：預設每月 `300TWD`，於 50%、90%、100% 通知；預算不會自動停止支出。
- Secret Manager：Cloud Run 服務帳號僅取得四個指定秘密的 `roles/secretmanager.secretAccessor`。

## 驗收

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

- `GET <CLOUD_RUN_URL>/healthz` 回傳 `ok: true`。
- LINE Developers Console 的 Webhook Verify 成功。
- 手機 LINE 開啟 LIFF，搜尋 SKU、建立多品項申請。
- 採購角色確認下單；到貨角色執行部分到貨與完成。
- 手動執行 Scheduler job，確認群組只收到一次提醒。

## 官方依據

- Cloud Run 從原始碼部署：https://cloud.google.com/run/docs/deploying-source-code
- Cloud Run 掛載 Secret Manager：https://cloud.google.com/run/docs/configuring/services/secrets
- Cloud Scheduler HTTP job：https://cloud.google.com/sdk/gcloud/reference/scheduler/jobs/create/http
- Cloud Billing budget：https://cloud.google.com/sdk/gcloud/reference/billing/budgets/create
