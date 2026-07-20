# LINE 補貨狀態互動卡片規格

## 目標

將公司 LINE 群組中的六個補貨查詢指令，由純文字清單改成可操作的 Flex Message 卡片。使用者能看見符合狀態的補貨單，並從卡片按鈕直接開啟同一套 LIFF，繼續確認下單、登記到貨或唯讀查看明細。

狀態與動作固定如下：

| 補貨單狀態 | 卡片按鈕 | LIFF 模式 |
| --- | --- | --- |
| 待確認 | 確認下單 | `order` |
| 已下單 | 登記到貨 | `receipt` |
| 部分到貨 | 繼續登記 | `receipt` |
| 已完成 | 查看明細 | `detail` |
| 取消 | 查看明細 | `detail` |

`查未結案` 可以同時包含前三種狀態，每張卡片依自身狀態顯示對應按鈕。每次最多顯示最近 10 張補貨單；沒有符合資料時維持簡短文字回覆。

## 技術堆疊

- Node.js 22、ES Modules、Express 5
- `@line/bot-sdk` 10.2
- 原生 HTML、CSS、JavaScript 與 LIFF SDK
- Google Sheets API v4
- Node.js 內建 `node:test`

不新增資料庫欄位、不新增 npm 套件。

## 指令

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
npm.cmd run dev
```

## 專案結構

```text
src/line/messenger.js          # Flex Message、LIFF URI 與 LINE 回覆
src/routes/webhook.js          # 狀態指令查詢與訊息分派
src/services/group-commands.js # 指令解析、補貨單彙總與最近 10 筆限制
public/app.js                  # LIFF request/order/receipt/detail 畫面控制
public/workflow.js             # 可測試的 LIFF 模式與明細文字邏輯
test/                          # Messenger、Webhook、前端純函式測試
docs/                          # 功能規格與實作計畫
```

## 程式風格

沿用既有 ES Modules、兩格縮排、單引號與小型純函式。LINE 訊息結構先由純函式建立，再交由 client 傳送，例如：

```js
export function statusCardAction(status, requestId, workflowUrl) {
  if (status === '待確認') {
    return { label: '確認下單', uri: workflowUrl('order', requestId) };
  }
  return { label: '查看明細', uri: workflowUrl('detail', requestId) };
}
```

## 測試策略

- Messenger 單元測試：驗證五種狀態的按鈕標籤、LIFF 模式與 Flex carousel 結構。
- Webhook 整合測試：驗證六個狀態指令改呼叫互動卡片回覆，未授權群組不讀取資料。
- LIFF 純函式測試：驗證 `detail` 模式可用、所有品項產生唯讀數量與狀態摘要。
- 回歸驗證：完整執行 `npm.cmd test`、`npm.cmd run lint`、`npm.cmd run build`。

## 邊界

- 一定執行：保留最近 10 筆限制、使用 URI action、沿用 LIFF ID token 與既有操作權限、對使用者文字做長度限制。
- 需要先確認：部署正式 Cloud Run、變更 Google Sheet 結構、增加查詢分頁或超過 10 筆的入口。
- 絕不執行：在 LINE 訊息或 URL 放入憑證、繞過下單／到貨角色驗證、讓唯讀明細提交資料。

## 成功標準

1. 六個查詢指令有資料時回覆一則 Flex carousel，最多 10 張卡片。
2. 卡片顯示補貨單號、狀態、申請人、品項數與首項商品。
3. 卡片按鈕依狀態開啟正確 `order`、`receipt` 或 `detail` LIFF URL。
4. `detail` 模式顯示整張補貨單所有品項與申請／下單／到貨數量，但沒有輸入欄位與送出按鈕。
5. 無資料、未授權群組與既有下單／到貨功能行為維持正確。

## 未決問題

無。互動與狀態對應已於 2026-07-20 由使用者確認。
