# 實作計畫：LINE 補貨申請與到貨確認 MVP

## 架構決策

- 以 Cloud Run 承接 LINE Webhook，確保能讀取並驗證 `x-line-signature`。
- 以 Google Sheet 作為第一版資料庫，沿用已整理的 912 個 SKU。
- 以前端本地搜尋處理約 900 個 SKU，減少每次輸入都呼叫後端。
- 以 URI 連結開啟 LIFF 下單／到貨頁面；身分由 LINE ID token 驗證。
- 機密使用 Secret Manager；試算表只保存非機密設定與業務紀錄。

## 任務清單

### Phase 1：後台資料基礎

#### Task 1：建立 Sheet 技術欄位與權限表

**Acceptance**
- `補貨追蹤` 新增 N:S 技術欄位，不破壞 A:M 與既有示範資料。
- 新增 `授權人員`、`系統設定` 分頁與驗證規則。
- `品項類型` 分類文字從「訊息選項（待確認）」整理為「訊息選項」。

**Verify**
- 回讀表頭、公式、驗證規則與示範資料。
- 搜尋確認 `是否可補貨` 沒有待確認值。

**Dependencies**：規格核准。

**Files / data**：Google Sheet。

### Checkpoint：Sheet 基礎

- 現有資料未遺失。
- 新欄位、公式與分頁可用。

### Phase 2：可測試的核心服務

#### Task 2：建立專案骨架與設定驗證

**Acceptance**
- 建立 Node.js 專案、設定載入、錯誤類型與健康檢查。
- `.env.example` 不含真實機密。
- 啟動與設定測試通過。

**Verify**：`npm.cmd test`、`npm.cmd run build`。

**Dependencies**：Task 1。

**Files**：`package.json`、`src/config.js`、`src/app.js`、`test/config.test.js`、`.env.example`。

#### Task 3：建立 Google Sheets repository

**Acceptance**
- 可查詢可補貨 SKU、未結案紀錄與單張補貨單。
- 可冪等建立多品項申請並更新下單／到貨資料。
- 使用 Lock／操作金鑰語意避免重複寫入。

**Verify**：repository mock 測試涵蓋多品項、重送與部分到貨。

**Dependencies**：Task 2。

**Files**：`src/sheets/*`、`src/services/requests.js`、`test/requests.test.js`。

#### Task 4：建立 LINE 安全層

**Acceptance**
- Webhook 以原始 body 驗證簽章後才解析。
- LIFF ID token 經 LINE verify endpoint 驗證。
- 角色檢查拒絕未授權的下單／到貨操作。

**Verify**：有效／無效簽章、偽造 userId、角色不足測試。

**Dependencies**：Task 2。

**Files**：`src/line/*`、`test/line-security.test.js`。

### Checkpoint：核心服務

- 所有自動測試通過。
- 不需要真實 LINE／Google 機密即可用 mock 驗證。

### Phase 3：垂直功能切片

#### Task 5：補貨搜尋與申請切片

**Acceptance**
- 群組輸入「補貨」會收到 LIFF 入口。
- 手機頁面可搜尋、加入多項、調整數量與送出。
- 寫入成功後群組收到摘要，重送不產生重複單。

**Verify**：API 測試、瀏覽器手機尺寸測試、Sheet 測試資料回讀。

**Dependencies**：Tasks 3、4。

**Files**：`src/routes/webhook.js`、`src/routes/api.js`、`public/*`、相關測試。

#### Task 6：下單確認切片

**Acceptance**
- 採購角色可輸入下單量與預計到貨日。
- 未授權者不可更新。
- 群組收到下單摘要與到貨入口。

**Verify**：角色、數量與日期驗證；Sheet 狀態回讀。

**Dependencies**：Task 5。

**Files**：`src/services/orders.js`、API／頁面檔案與測試。

#### Task 7：到貨確認切片

**Acceptance**
- 支援多次部分到貨並累加。
- 實到未滿為 `部分到貨`，到齊為 `已完成`。
- 不允許實到總量超過下單量，除非管理員明確覆寫。

**Verify**：部分到貨、到齊、超收與重送測試。

**Dependencies**：Task 6。

**Files**：`src/services/receipts.js`、API／頁面檔案與測試。

### Checkpoint：端到端流程

- 申請 → 下單 → 部分到貨 → 完成可在測試環境跑通。
- Bot 訊息與 Sheet 狀態一致。

### Phase 4：提醒與部署

#### Task 8：建立提醒工作

**Acceptance**
- 找出超過門檻的待確認及逾期未到貨項目。
- 同一提醒週期不重複推送。
- 可由 Cloud Scheduler 安全呼叫。

**Verify**：時間邊界、重複提醒與無待辦情況測試。

**Dependencies**：Tasks 5–7。

**Files**：`src/services/reminders.js`、`src/routes/jobs.js`、測試。

#### Task 9：部署與 LINE Console 串接

**Acceptance**
- Cloud Run、Secret Manager、服務帳號與 Scheduler 完成設定。
- LINE Webhook Verify 成功，Bot 加入指定群組後能保存 groupId。
- LIFF Endpoint 可在 LINE 手機端開啟並通過登入。

**Verify**：健康檢查、Webhook Verify、手機端完整流程、Cloud 日誌無機密。

**Dependencies**：Task 8、帳務與帳號操作授權。

**Files / external state**：Google Cloud、LINE Developers Console。

## 風險與處理

| 風險 | 影響 | 處理方式 |
| --- | --- | --- |
| Cloud Run 需要帳務 | 無法部署群組 Bot | 部署前明確取得同意並設定預算警示 |
| 群組推播依成員數計入 LINE 訊息量 | 可能超過免費額度 | 合併訊息、限制提醒頻率、查詢剩餘額度 |
| 912 SKU 含平台訊息選項 | 搜尋結果混亂 | 只讀 `是否可補貨＝是`，保留人工顯示名稱 |
| Google Sheet 併發寫入 | 重複或覆寫 | 操作金鑰、版本檢查與批次更新 |
| LINE user ID 跨 channel 不一致 | 權限判斷失敗 | Login 與 Messaging channel 放在同一 Provider |
| 庫存是快照 | 使用者誤判 | 明確標示更新日，後續再串電商庫存 API |

## 已通過的 Checkpoint（2026-07-14）

- 已核准 `docs/replenishment-line-mvp-spec.md` 的假設與第一版範圍。
- 已同意啟用 Google Cloud 計費，角色、提醒與預設單位採建議值。
- 進入 Task 1：正式調整 Sheet，再依序建立可測試的垂直功能切片。
