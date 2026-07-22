# 規格：飛鼠商品完全自動同步與 LINE 指令

## 目標

讓飛鼠成為 LINE 補貨系統中飛鼠商品的主要商品資料來源。既有每日 03:00 工作與管理員手動觸發的同步都會：

1. 自動新增飛鼠的新商品與新規格到 `SKU主檔`。
2. 自動更新既有飛鼠 SKU 的商品名稱、規格、庫存、GTIN、儲位與補貨顯示名稱。
3. 同步商品圖片對照。
4. 不再要求人工把新品設為 `核准匯入`。

成功後重新整理或重開 LINE LIFF 即可看到最新目錄。正式飛鼠目錄同步最近五次約 28 至 39 秒完成；LINE 指令只負責非同步啟動，不能讓 Webhook 持續等待工作結束。

## 使用者指令

```text
同步飛鼠商品
查飛鼠同步
```

- `同步飛鼠商品`：僅已啟用的管理員可執行。立即啟動 `flyingmouse-catalog-sync` Cloud Run Job，回覆 execution 名稱與查詢方式。
- `查飛鼠同步`：僅已啟用的管理員可執行。回覆最新 execution 的執行中、成功或失敗狀態及時間。
- LINE 重送同一 `webhookEventId` 不得重複啟動。
- 已有 execution 執行中時不得再啟動第二份同步工作。
- 每次觸發要求寫入既有 `操作紀錄`，不得新增秘密或帳密欄位。

## 商品欄位所有權

`SKU主檔` 仍使用 A:N 既有表頭，不新增或搬動欄位。

| 欄位 | 完全自動規則 |
| --- | --- |
| A SKU | 飛鼠貨品編號；既有列不可改鍵 |
| B 商品名稱 | 每輪以飛鼠官方 Excel 覆寫 |
| C:D 規格 | 每輪以飛鼠官方 Excel 覆寫 |
| E 庫存快照 | 每輪以飛鼠官方 Excel 覆寫 |
| F GTIN | 每輪以飛鼠官方 Excel 覆寫 |
| G 儲位 | 每輪以飛鼠官方 Excel 覆寫 |
| H 補貨顯示名稱 | 每輪以商品名稱與非空規格用 `｜` 重建，人工值也會被覆寫 |
| I 品項類型 | 新品寫入 `一般SKU`；既有列保留 |
| J 是否可補貨 | 新品寫入 `是`；既有列保留 |
| K 搜尋關鍵字 | 不寫入，保留既有陣列公式 |
| L 單位 | 新品寫入 `件`；既有列保留 |
| M 主要供應商 | 新品寫入 `飛鼠`；既有列必須為 `飛鼠` 才允許來源覆寫 |
| N 資料更新日 | 不寫入，保留既有陣列公式 |

若同一 SKU 已存在但主要供應商不是 `飛鼠`，整批商品主檔寫入停止，不猜測資料所有權。

## 自動同步模式

新增 `auto` sheet mode，保留既有 `read-only` 與 `review` 模式作為回復與診斷工具。

1. 登入飛鼠、下載並完整驗證官方 Excel。
2. 擷取並驗證貨品圖片清單。
3. 讀取並驗證 `SKU主檔` A:N 表頭、SKU 唯一性與主要供應商所有權。
4. 來源必須覆蓋至少 90% 的既有飛鼠管理 SKU，否則整批主檔寫入停止。
5. 同一個 `values.batchUpdate` 新增新 SKU 並更新既有飛鼠 SKU。
6. 再同步商品圖片對照；來源缺漏只留在差異報告，不自動刪除、停用或清空主檔列。

`飛鼠目錄待確認` 保留歷史資料，但 `auto` 模式不讀取核准狀態，也不把它當成匯入門檻。

## 技術堆疊與專案結構

- Node.js 22、ES Modules、Express 5。
- `googleapis` 159：Google Sheets 與 Cloud Run v2 Jobs API。
- Playwright 1.61：飛鼠登入、官方 Excel 與圖片清單。
- `src/flyingmouse/sheets-operational.js`：完全自動主檔同步。
- `scripts/flyingmouse-sync.mjs`：`auto` 工作協調。
- `src/services/flyingmouse-catalog-job.js`：Cloud Run Job 啟動與狀態查詢。
- `src/services/group-commands.js`、`src/routes/webhook.js`：LINE 指令、權限、回覆與冪等。
- `src/sheets/repository.js`：操作紀錄保留。
- `scripts/deploy-flyingmouse-job.ps1`：部署時允許並設定 `auto` mode。

沿用現有程式風格：純函式處理正規化與狀態轉換；外部依賴由建構參數注入以便測試；Google Sheet 寫入使用明確範圍，不寫整張工作表。

## 指令與驗證

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

測試必須涵蓋：

- 新 SKU 自動新增並設定 I/J/L/M 預設值。
- 既有飛鼠 SKU B:H 全部隨來源更新，包含人工修改過的 H。
- K/N 不出現在寫入範圍。
- 非飛鼠供應商衝突、來源低覆蓋率、重複 SKU、表頭不符及容量不足時零主檔寫入。
- 來源缺漏不刪除或停用。
- `auto` mode 不讀取人工核准狀態。
- 只有管理員能啟動／查詢；重送事件與執行中工作不重複啟動。
- Cloud Run Job API 錯誤回傳友善訊息，不暴露 Google 回應或秘密。

## 邊界

- Always：先驗證完整來源與目標結構，再寫主檔；保留冪等與操作紀錄；完整測試後才提交。
- Ask first：正式部署、正式 Job mode 切換、實際執行同步、修改正式 Sheet 或 IAM。
- Never：自動刪除來源缺漏 SKU、寫入飛鼠、覆寫 K/N 公式、輸出帳密或 token、同時執行兩份目錄同步。

## 成功標準

1. 管理員輸入 `同步飛鼠商品` 後在數秒內收到已接受回覆，Cloud Run 只建立一個 execution。
2. execution 成功後，新商品、新規格與既有商品欄位變更直接反映在 `SKU主檔`，重新整理 LINE 即可使用。
3. 每日 03:00 排程與手動指令都使用相同 `auto` 工作，不產生兩套規則。
4. `查飛鼠同步` 能辨識尚未執行、執行中、成功及失敗。
5. 所有既有測試、lint、build 通過，正式環境切換前另行取得使用者同意。

## 已確認決策

- 採用完全自動匯入，不保留人工核准門檻。
- 飛鼠會覆寫既有飛鼠 SKU 的補貨顯示名稱。
- 飛鼠來源缺漏不自動刪除或停用。
