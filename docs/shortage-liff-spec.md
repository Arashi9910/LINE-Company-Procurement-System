# 缺貨清單 LIFF 頁面規格

## 1. 問題

`查缺貨` 目前回純文字，每筆三行、每段最多 10 筆。採購反映難讀：沒有圖片認不出是哪支
商品，看到缺貨之後還得回「補貨表單」重新搜尋一次才能下單。

## 2. 目標

`查缺貨` 改回一則摘要訊息加一個按鈕，點進去是 LIFF 頁面，列出要叫貨的商品（含圖片），
可以直接勾選、填數量、送出建立補貨單。

不做的事：這個頁面不編輯庫存看板，看板仍然只由每小時同步寫入。

## 3. 現成可用的零件

- `createGroupContext(…, linkSigningSecret)` 與 `https://liff.line.me/{liffId}?ctx=…`：
  `補貨` 指令既有的進入方式，照用。
- `repository.listProductImages()`：已回傳每個貨號的 `variantImageUrl`／`mainImageUrl`／
  `listImageUrl`。
- `createDashboardReader()`：已回傳看板列、動銷清單與同步狀態。
- LIFF 前端的 `state.cart`（`Map<sku, { item, quantity }>`）與 `submit()`：
  送出時 POST `/api/requests`，格式為 `items: [{ sku, quantity }]`。
  **缺貨頁只負責把品項放進這個購物車，不另外做一套建單流程。**

## 4. 進入方式

`查缺貨` 的回覆由純文字改為 buttons template（比照 `replyReplenishmentLink`）：

```
要叫貨 27 個，其中 3 個需人工確認。
［開啟缺貨清單］
```

- 摘要只講數量，細節進頁面看。
- 連結為 `https://liff.line.me/{liffId}?ctx={token}&view=shortage`。
- 同步失敗時，摘要沿用 `inventoryFreshness` 的警告前綴。
- 看板功能關閉（`INVENTORY_DASHBOARD_ENABLED` 非 true）時維持現有文字回覆，不給按鈕。

## 5. API

`GET /api/inventory/shortage`，與既有 LIFF API 相同的驗證方式。

回傳：

```json
{
  "updatedAt": "2026-10-30 20:00:41",
  "syncStatus": { "status": "正常", "lastSuccessAt": "…" },
  "reorder": [ { … } ],
  "anomaly": [ { … } ],
  "quiet": 3
}
```

每一列：

```json
{
  "sku": "9E7A52-BTS應援棒底座",
  "displayName": "隔日到貨⚡️BTS防彈少年團應援棒收納盒｜底座",
  "imageUrl": "https://…",
  "unit": "件",
  "gap": 2,
  "unshipped": 2,
  "onOrder": 0,
  "flyingmouseStock": 21,
  "stockMode": "現貨",
  "note": ""
}
```

分組規則與文字版一致，不另立標準：

- `reorder`：`gap > 0` 且 `status === '要叫貨'`，依缺口由大到小。
- `anomaly`：`gap > 0` 但狀態不是「要叫貨」。缺口僅供參考。
- `quiet`：有缺口但近 30 天沒有訂單而被動銷清單篩掉的筆數，只回數量。
  動銷清單不可用時（時間戳與看板不一致）不篩，`quiet` 為 0。

圖片取用順序：`variantImageUrl`（規格圖，對得到實際規格）→ `mainImageUrl` → `listImageUrl`。
都沒有就回空字串，前端顯示佔位方塊，不讓版面塌掉。

看板功能關閉時回 409，訊息說明功能未啟用。

## 6. 頁面

新增 `#shortage-section`，在 `view=shortage` 時顯示，其餘區塊隱藏。

每一筆一張卡片：

- 左側商品圖（固定尺寸、`object-fit: cover`，載入失敗顯示佔位方塊）
- 商品名稱與貨號
- 缺口／未寄／叫貨中／飛鼠庫存四個數字
- 數量輸入框，**預設帶入缺口數**
- 勾選框

底部沿用既有的 cart dock 與送出按鈕：勾選的品項寫進 `state.cart`，送出走原本的
`submit()`。送出成功後回到補貨單結果畫面，與表單流程一致。

「⚠️ 異常」另成一段，**預設不勾選**，並顯示該列的備註說明原因。理由同文字版：
異常列的缺口照樣是正的，混在一起報會害人誤下單。

「近 30 天沒有訂單」的筆數只在頁尾以一行說明，不列出明細。

頁首顯示看板的更新時間；同步失敗時在最上方顯示警告列。

## 7. 驗收

- `npm test`、`npm run lint`、`npm run build` 全過。
- 新增測試涵蓋：
  - 端點的分組與排序與 `formatShortageReply` 一致（同一份資料，兩邊的
    reorder／anomaly／quiet 必須相同）。
  - 圖片取用的優先順序與全部缺漏時的行為。
  - 看板關閉時端點回 409，且 `查缺貨` 仍回純文字、不給按鈕。
  - 動銷清單不可用時不做篩選、`quiet` 為 0。
- 以正式資料實跑端點，確認回傳列數與 `查缺貨` 文字版一致。

## 8. 風險

- 商品圖片對照有約 72 筆綁定指向已刪除的銷售商品，圖片網址可能失效。
  前端一律要有載入失敗的佔位處理，不能假設網址可用。
- 這個頁面會讓人更容易一次送出大量補貨單。既有的 `MAX_ITEMS` 限制仍然適用，
  超過時要在頁面上講清楚，而不是送出後才失敗。
