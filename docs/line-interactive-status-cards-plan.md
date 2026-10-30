# LINE 補貨狀態互動卡片實作計畫

## 概要

沿用現有補貨單彙總結果與 LIFF 深連結，將 Webhook 的純文字狀態回覆改成 Flex carousel；再為結案單新增唯讀 `detail` 模式。資料讀取與權限模型不變。

## 架構決策

- Flex carousel 一張 bubble 對應一張補貨單，每頁維持 10 筆上限。
- 每頁維持 10 張 bubble，導覽按鈕使用 Flex Message 下方的 quick reply，不占用 carousel 名額。
- quick reply 送出帶頁碼的同狀態查詢指令，例如 `查待確認 2`；服務層負責排序、切頁及修正超出範圍的頁碼。
- LINE 訊息建構集中在 `src/line/messenger.js`，Webhook 只負責取得彙總資料並分派。
- `order`、`receipt` 沿用既有權限檢查；`detail` 沿用已登入使用者可讀取單據的既有 API，不提供任何寫入控制元件。
- 前端模式與明細摘要抽成無 DOM 的純函式，避免為測試新增瀏覽器模擬套件。

## 任務清單

### 第一階段：LINE 卡片

- [x] 任務 1：建立狀態卡片與 LIFF 動作
  - 驗收：五種狀態都產生正確按鈕，最多 10 張 bubble，空結果回純文字。
  - 驗證：`npm.cmd test -- test/messenger.test.js`
  - 檔案：`src/line/messenger.js`、`test/messenger.test.js`
  - 相依：無

- [x] 任務 2：將狀態 Webhook 接到互動回覆
  - 驗收：狀態查詢呼叫卡片方法，不再輸出舊純文字清單；群組限制不變。
  - 驗證：`npm.cmd test -- test/webhook.test.js test/group-commands.test.js`
  - 檔案：`src/routes/webhook.js`、`test/webhook.test.js`
  - 相依：任務 1

### 檢查點：LINE 卡片

- [x] Messenger 與 Webhook 測試通過
- [x] Flex JSON 符合 carousel、bubble、URI action 結構

### 第二階段：LIFF 唯讀明細

- [x] 任務 3：加入 `detail` 模式與唯讀品項摘要
  - 驗收：所有品項皆顯示狀態、申請量、下單量與到貨量；沒有輸入框或送出按鈕。
  - 驗證：`npm.cmd test -- test/workflow-view.test.js`
  - 檔案：`public/workflow.js`、`public/app.js`、`test/workflow-view.test.js`
  - 相依：任務 1

### 檢查點：完整功能

- [x] `order` 與 `receipt` 行為未改變
- [x] `detail` URL 能以既有單據 API 載入整張單據
- [x] 完整 test、lint、build 通過（204/204）

### 第三階段：查詢分頁

- [x] 任務 4：補貨單彙總支援頁碼
  - 驗收：每頁 10 筆、維持新到舊排序、超出總頁數時停在最後一頁。
  - 驗證：`npm.cmd test -- test/group-commands.test.js test/webhook.test.js`
  - 檔案：`src/services/group-commands.js`、`src/routes/webhook.js`

- [x] 任務 5：卡片下方加入上一頁／下一頁
  - 驗收：第一頁只有下一頁，中間頁有兩個方向，最後一頁只有上一頁，單頁結果不顯示導覽。
  - 驗證：`npm.cmd test -- test/messenger.test.js`
  - 檔案：`src/line/messenger.js`、`test/messenger.test.js`

## 風險與緩解

| 風險 | 影響 | 緩解方式 |
| --- | --- | --- |
| 商品名稱過長造成 Flex JSON 或版面膨脹 | 中 | 卡片文字截短、開啟 wrap、維持 10 張上限 |
| 混合狀態的未結案查詢導向錯誤流程 | 高 | 動作由每張補貨單的彙總狀態決定並逐狀態測試 |
| 唯讀明細意外出現送出控制 | 高 | `detail` 分支在建立任何輸入欄位前返回，並由純函式與來源檢查測試驗證 |
| 非操作角色點擊卡片 | 低 | `order`、`receipt` 繼續使用既有 LIFF 角色拒絕訊息 |
| 分頁按鈕送出過期頁碼 | 低 | 每次重新讀取資料，並將超出範圍的頁碼修正到目前最後一頁 |

## 未決問題

無。正式部署仍需使用者另行確認。
