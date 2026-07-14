# 規格：LINE 補貨申請與到貨確認 MVP

## 開始前假設

1. 申請入口是 LINE 裡的 LIFF 手機網頁，不讓一般申請人直接編輯 Google Sheet。
2. 商品主檔沿用現有 `SKU主檔`，只有 `是否可補貨＝是` 的 SKU 可被搜尋與申請。
3. 同一張申請可包含多個 SKU；每個 SKU 在 `補貨追蹤` 佔一列，並共用同一個補貨單號。
4. 任何通過 LINE 身分驗證的員工可申請；下單與到貨確認依 `授權人員` 分頁的角色限制。
5. LINE Login／LIFF channel 與 Messaging API channel 必須放在同一個 Provider，讓兩邊的 LINE user ID 可以對應。
6. 第一版採 Cloud Run 承接 Webhook 與 LIFF 網頁，Google Sheet 作為資料庫；Cloud Run 專案需啟用帳務，但正常的小型內部使用通常可控制在免費額度附近，實際仍以 Google Cloud 帳單為準。
7. 未填單位的 SKU，申請時暫以「件」顯示與寫入。
8. 預設每個工作日上午 10:00 提醒超過 24 小時仍待確認的補貨單，並提醒已超過預計到貨日但仍有未到數量的項目。

## 目標

建立一套適合約 900 個以上 SKU 的內部補貨流程：

- 員工在 LINE 工作群組輸入「補貨」即可取得申請入口。
- 申請人以商品名稱、SKU 或蝦皮規格原文搜尋商品，加入多個品項後一次送出。
- 送出前顯示同 SKU 是否已有待確認、已下單或未完全到貨的紀錄。
- 送出後寫入 `補貨追蹤`，並由 Bot 在指定工作群組通知。
- 採購角色可在 LINE 頁面確認下單數量與預計到貨日。
- 到貨角色可輸入實到數量，支援部分到貨並自動計算未到數量。
- 系統依時間條件自動提醒未確認與逾期未到貨項目。
- 所有重要操作記錄 LINE 使用者、時間與操作內容，避免責任不清。

## 第一版使用流程

### 1. 補貨申請

1. 員工在指定 LINE 群組輸入「補貨」。
2. Bot 驗證 Webhook 後回覆「開啟補貨表單」按鈕。
3. LIFF 驗證員工 LINE 身分。
4. 員工搜尋並加入一個或多個 SKU，填寫數量與備註。
5. 系統再次檢查 SKU 是否可補貨、數量是否為正整數、是否有相同 SKU 未結案。
6. 寫入 `補貨追蹤`，同一批項目共用補貨單號。
7. Bot 在群組推播申請摘要與「確認下單」連結。

### 2. 確認下單

1. 有 `採購確認` 或 `管理員` 角色的人開啟通知連結。
2. 頁面顯示申請品項、申請量、目前庫存快照與未結案警示。
3. 採購者填寫各 SKU 的下單數量及預計到貨日。
4. 系統更新所有對應列的狀態，並記錄操作人與時間。
5. Bot 在群組推播下單結果。

### 3. 到貨確認

1. 有 `到貨確認` 或 `管理員` 角色的人開啟到貨連結。
2. 填寫本次實到數量；已到數量採累加方式。
3. 若實到小於下單量，狀態為 `部分到貨`；全部到齊時為 `已完成`。
4. Bot 在群組推播到貨摘要與剩餘未到數量。

## 資料結構

### 現有 `SKU主檔`

- `A SKU`：唯一識別碼。
- `B:D`：蝦皮商品與規格原文，不解析成標準化規格。
- `H 補貨顯示名稱`：LINE 搜尋結果顯示文字，可人工整理。
- `J 是否可補貨`：只有 `是` 進入申請搜尋。
- `K 搜尋關鍵字`：由商品名稱、規格與 SKU 組合。
- `L 單位`：空白時第一版預設為「件」。
- `M 主要供應商`：選填。

### 調整 `補貨追蹤`

保留現有 A:M，新增技術欄位：

| 欄位 | 用途 |
| --- | --- |
| N `SKU` | 重複檢查、查詢與更新的主鍵 |
| O `LINE使用者ID` | 申請人身分稽核 |
| P `來源群組ID` | 確認申請來自設定的工作群組 |
| Q `最後操作人ID` | 最近一次下單／到貨操作人 |
| R `最後更新時間` | 最近狀態變更時間 |
| S `操作金鑰` | 防止雙擊、重送或 Webhook 重送造成重複資料 |

現有示範資料保留；新資料以 SKU 為主。`重複警示` 改為優先比較 SKU，舊資料沒有 SKU 時才比較品項文字。

### 新增 `授權人員`

| 欄位 | 用途 |
| --- | --- |
| LINE使用者ID | 與 LINE Login 驗證結果比對 |
| 顯示名稱 | 方便管理者辨識 |
| 角色 | `申請人`、`採購確認`、`到貨確認`、`管理員` |
| 是否啟用 | `是`／`否` |
| 最後登入時間 | 稽核與清理不用帳號 |

### 新增 `系統設定`

僅放非機密設定，例如工作群組 ID、提醒時間與預設單位。LINE Channel Secret、Access Token 等機密只存 Google Secret Manager，不寫入 Sheet 或 Git。

## 技術架構

- Runtime：Node.js 22+，Cloud Run。
- HTTP：Express。
- LINE：`@line/bot-sdk`，Webhook 先以原始 request body 驗證 `x-line-signature` 再解析 JSON。
- Google：`googleapis` 使用 Cloud Run 服務帳號存取指定 Google Sheet。
- 前端：原生 HTML、CSS、JavaScript 與 LIFF SDK；手機優先，不建立大型前端框架。
- 排程：Cloud Scheduler 呼叫受保護的提醒端點。
- 測試：Node.js 內建 `node:test`，模擬 LINE Webhook、ID token 驗證與 Sheets repository。

## 指令

```powershell
# 開發
npm.cmd install
npm.cmd run dev

# 驗證
npm.cmd test
npm.cmd run lint
npm.cmd run build

# 建立容器
docker build -t line-replenishment .

# 部署（帳務與專案確認後）
gcloud run deploy line-replenishment --source . --region asia-east1 --allow-unauthenticated
```

## 專案結構

```text
line-replenishment/
  src/
    app.js                  HTTP 應用程式
    config.js               環境變數驗證
    line/                   Webhook、訊息與 LIFF 身分驗證
    sheets/                 Google Sheet repository
    routes/                 Webhook、表單 API、提醒工作
    services/               申請、下單、到貨與提醒規則
  public/                   LIFF 手機頁面
  test/                     單元與整合測試
  Dockerfile
  package.json
```

## 程式風格

```js
export async function submitRequest({ actor, items, note }, repositories) {
  if (!actor?.userId) throw new ValidationError('缺少已驗證的 LINE 身分');
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError('至少需要一個補貨品項');
  }

  return repositories.requests.create({ actor, items, note });
}
```

- ES modules、2 空格縮排、單引號。
- 業務邏輯與 LINE／Google API adapter 分離。
- 所有外部輸入先驗證；錯誤訊息對使用者可讀，記錄中不輸出機密。
- request ID、操作金鑰與 Webhook event ID 用於冪等處理。

## 測試策略

- 單元測試：數量、角色、狀態轉換、重複警示、部分到貨與冪等。
- Repository 測試：模擬 Sheets API，確認一張多品項申請產生正確列數。
- Webhook 測試：有效／無效簽章、空事件、群組訊息、重送事件。
- 手動驗收：手機 LINE 內搜尋、送出、群組通知、下單、部分到貨、完成與提醒。

## 邊界

### 一定會做

- 驗證 Webhook 簽章及 LIFF ID token。
- 保留原始蝦皮欄位，不把平台顯示文字自動視為標準規格。
- 所有寫入採冪等設計，避免重複補貨單。
- 機密放 Secret Manager，不寫入 Sheet、程式碼或對話。
- 對現有試算表先讀後寫，並於修改後回讀驗證。

### 需要先詢問

- 啟用 Google Cloud 帳務、建立 Cloud Run／Scheduler／Secret Manager 資源。
- 變更正式 LINE Webhook URL 或啟用群組加入。
- 新增或刪除授權人員。
- 修改提醒頻率、訊息量或可能影響 LINE 月度訊息額度的設定。

### 不會做

- 不要求使用者在對話中貼 Channel Secret 或長效 Access Token。
- 不使用未驗證簽章的 Apps Script Webhook。
- 不刪除原始 Excel、`SKU主檔` 或現有示範資料。
- 不自動將庫存快照視為即時庫存。

## 成功標準

1. 指定群組輸入「補貨」後，Bot 在 LINE 要求的時限內回覆可用入口。
2. 表單能在約 900 個 SKU 中以 SKU、名稱或規格文字搜尋，且只顯示可補貨項目。
3. 一張多品項申請只產生一個補貨單號，每個 SKU 一列，雙擊送出不會重複。
4. 相同 SKU 有未結案紀錄時，送出前與後台都會顯示警示。
5. 未授權者不能執行下單或到貨確認。
6. 下單、部分到貨、全部到貨的數量與狀態計算正確。
7. 待確認及逾期未到貨提醒可按排程送到指定群組。
8. Channel Secret、Access Token 與服務帳號金鑰不出現在 Git、Sheet 或日誌。
9. 自動測試通過，Cloud Run 健康檢查、LINE Webhook Verify 與手機端完整流程均驗收成功。

## 已核准決策（2026-07-14）

1. 同意啟用 Google Cloud 計費，使用 Cloud Run、Cloud Scheduler 與 Secret Manager；部署時一併建立預算警示。
2. 任何已驗證員工可申請；`採購確認`／`管理員` 可確認下單，`到貨確認`／`管理員` 可確認到貨。
3. 提醒採 Asia/Taipei 時區，工作日上午 10:00 執行；待確認超過 24 小時與逾期未到貨項目每日提醒一次。
4. SKU 未填單位時預設為「件」。
5. 其餘第一版架構、資料欄位與安全限制照本規格執行。

## 官方依據

- LINE Webhook 必須驗證簽章：https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
- LINE 群組 ID 從 Webhook event 取得：https://developers.line.biz/en/docs/messaging-api/group-chats
- LIFF 已停止提供 groupId：https://developers.line.biz/en/reference/liff
- LIFF ID token 需由伺服器驗證：https://developers.line.biz/en/docs/liff/using-user-profile/
- Cloud Run 部署需確認帳務：https://docs.cloud.google.com/run/docs/quickstarts/build-and-deploy/deploy-nodejs-service
