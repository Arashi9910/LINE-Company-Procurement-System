# 規格：下單後於補貨追蹤修正規格

## Objective

採購人員確認下單後，若發現選錯同一商品的規格，可在 Google Sheet `補貨追蹤` 以搜尋式 SKU 下拉選擇正確規格。系統在尚未到貨時使用修正後 SKU 顯示、登記到貨並回寫飛鼠；第一次到貨時將修正結果鎖定，並保留原始 SKU 供稽核。

成功條件：

1. 只有狀態為 `已下單` 且實到數量為 `0` 的品項可提出規格修正。
2. 目標 SKU 必須存在、可補貨，並與目前 SKU 的 `商品名稱` 相同。
3. 修正後的 LINE 明細、到貨頁、提醒與飛鼠回寫都使用正確 SKU／顯示名稱。
4. 第一次登記到貨時，修正與到貨資料在同一批 Sheet 寫入中鎖定；後續不得再換規格。
5. 已部分到貨、已完成、已取消、不同商品、停用 SKU 或重複有效 SKU 都不得套用。

## Tech Stack

- Node.js 22、ES modules
- Express 5
- Google Sheets API v4（`googleapis`）
- Node.js 內建 test runner
- Google Cloud Run

## Commands

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
node scripts/configure-order-spec-correction.mjs --spreadsheet-id <ID>
```

## Project Structure

```text
src/sheets/order-spec-correction.js  規格修正欄位契約、驗證及 Sheet 遷移
src/sheets/repository.js              追蹤資料解析、到貨鎖定與飛鼠事件協調
public/workflow.js                    到貨／明細顯示修正提示
scripts/                              正式 Sheet 遷移入口
test/                                 純函式、Repository、UI 與遷移測試
docs/                                 規格、計畫與部署說明
```

## Data Contract

`補貨追蹤` 保留既有 A:S，於右側新增：

| 欄 | 欄名 | 用途 |
| --- | --- | --- |
| T | 修正後規格（SKU） | 人工下拉；來源為可持續擴充的 `SKU主檔!A2:A` |
| U | 修正狀態 | 陣列公式顯示可套用、已套用或拒絕原因 |
| V | 原始SKU（系統） | 第一次到貨套用修正時保存舊 N 欄，預設隱藏 |

N 欄仍為目前正式 SKU。第一次到貨前，服務可暫時以有效 T 欄作為 effective SKU；第一次到貨時會同批更新 D、N、V，再以修正後 SKU 建立飛鼠回寫事件。E 欄既有整欄公式會依 N 欄自動重算單位，不可直接寫入。

## Code Style

沿用專案兩格縮排、單引號、顯式驗證與 dependency injection：

```js
const correction = resolveOrderSpecCorrection({ row, catalogBySku });
if (correction.error) {
  throw new ConflictError(correction.error);
}
```

不信任 Sheet 公式結果；U 欄只供人員閱讀。服務端必須重新驗證 T 欄、商品、狀態、到貨量與可補貨狀態。

## Testing Strategy

- 純函式：未修正、合法待套用、已套用、不同商品、不可補貨、已有到貨、重複目標。
- Repository：讀取時顯示修正後規格；首次到貨同批保存原始 SKU、改寫正式 SKU 並建立正確飛鼠事件；重送不重複套用。
- Sheet 遷移：可重跑、拒絕衝突表頭、保留既有 A:S、建立驗證／公式／格式並隱藏 V 欄。
- UI：明細與到貨頁清楚標示規格已修正。
- 回歸：完整 `npm.cmd test`、lint、build。

## Boundaries

- Always：保留原始 SKU；服務端重驗；到貨與修正鎖定同批寫入；失敗時不建立飛鼠事件。
- Ask first：執行正式 Sheet 遷移、部署 Cloud Run、處理已部分到貨的人工庫存更正。
- Never：自動沖銷舊 SKU 庫存；允許換成不同商品；以顯示名稱作唯一鍵；覆寫 `SKU主檔` A:N 契約。

## Success Criteria

1. Google Sheet 可從 T 欄搜尋並選擇 SKU，U 欄立即顯示結果。
2. 合法修正的到貨頁顯示新規格，第一次到貨後 N 為新 SKU、V 為舊 SKU。
3. 飛鼠 queue 的事件 SKU 為新 SKU，且只增加本次到貨量一次。
4. 非法修正會阻止到貨並回傳可理解的錯誤，不更動庫存。
5. 既有未使用 T:V 的資料與流程保持相容。

## Open Questions

無。使用者已確認：只允許未到貨、同商品、可補貨規格；第一次到貨後鎖定。
