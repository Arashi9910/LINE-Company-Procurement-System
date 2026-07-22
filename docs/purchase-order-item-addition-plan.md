# 執行計畫：採購確認時追加任意商品規格

## Overview

沿用既有補貨單與 Google Sheets 欄位，在第一次確認下單時允許採購者從完整可補貨目錄追加 SKU。後端以原申請品項為必要集合，將合法追加品項附加為同一補貨單的新列，確保到貨與通知流程自然沿用既有資料流。

## Architecture Decisions

- 不新增 Sheet 欄位；以 `申請數量＝0` 表示採購者追加品項，`最後操作人ID` 保存採購者。
- 前端可載入完整商品目錄，但後端在送出時重新讀取 `SKU主檔` 驗證，避免停用或過期資料被加入。
- 原品項更新、追加品項與操作紀錄在單一 repository 佇列及同一批寫入中完成。
- 新列附加於最後使用列之後，不使用可能位於資料中間的第一個空白列。
- 第一次確認後維持不可編輯，避免到貨數量與採購內容失去一致性。

## Task List

### Phase 1：後端契約與資料安全

#### Task 1：擴充確認下單輸入驗證

**Description：** 讓服務層接受原品項加追加品項的唯一 SKU 清單，保留角色、數量、日期與冪等驗證，並加上 50 項上限。

**Acceptance criteria：**

- [x] 非採購角色仍被拒絕。
- [x] 重複 SKU、超過 50 項、無效數量或日期被拒絕。
- [x] 合法追加 SKU 可正規化後傳入 repository。

**Verification：** `node --test test/workflow.test.js test/api.test.js`

**Dependencies：** 無。

**Files likely touched：**

- `src/services/workflow.js`
- `test/workflow.test.js`
- `test/api.test.js`

**Estimated scope：** Medium。

#### Task 2：安全寫入追加品項

**Description：** 在 repository 中驗證原品項完整、追加 SKU 仍可補貨、容量足夠，接著更新原列、附加新列並記錄操作。

**Acceptance criteria：**

- [x] 原品項不可省略，追加品項必須存在且可補貨。
- [x] 新列沿用同一補貨單與原申請脈絡，申請量為 0、下單量與日期正確。
- [x] 冪等重送、已處理補貨單或表格容量不足不會部分寫入。

**Verification：** `node --test test/sheets-repository.test.js test/workflow.test.js`

**Dependencies：** Task 1。

**Files likely touched：**

- `src/sheets/repository.js`
- `test/sheets-repository.test.js`

**Estimated scope：** Medium。

### Checkpoint：後端資料流

- [x] 原品項與追加品項可在單次確認中安全寫入。
- [x] Repository 測試涵蓋成功、拒絕與冪等案例。
- [x] `npm.cmd test` 通過。

### Phase 2：手機採購介面

#### Task 3：建立可重用的採購追加選擇狀態

**Description：** 擴充純前端商品工具，支援排除已在補貨單內的 SKU、計算追加清單與搜尋完整目錄，先以單元測試固定行為。

**Acceptance criteria：**

- [x] 完整商品目錄可依商品、規格與 SKU 搜尋。
- [x] 已在原單或已追加的 SKU 不會重複加入。
- [x] 新增、改量與移除後的追加清單統計正確。

**Verification：** `node --test test/catalog.test.js`

**Dependencies：** Task 1。

**Files likely touched：**

- `public/catalog.js`
- `test/catalog.test.js`

**Estimated scope：** Small。

#### Task 4：整合確認下單頁的追加商品介面

**Description：** 在 order 模式載入完整商品目錄，加入搜尋、商品卡、規格選擇與「採購追加」列，並把原品項與追加品項一起送出。

**Acceptance criteria：**

- [x] 採購者可從全部可補貨商品選擇任意規格。
- [x] 追加列可改量、填預計到貨日及送出前移除。
- [x] 原品項與追加品項在手機寬度下清楚區分且不重複。

**Verification：**

- `node --check public/app.js`
- `npm.cmd run lint`
- 本機手機寬度手動操作確認下單流程。

**Dependencies：** Tasks 2、3。

**Files likely touched：**

- `public/app.js`
- `public/index.html`
- `public/styles.css`

**Estimated scope：** Medium。

### Checkpoint：完整操作流程

- [x] 原申請品項與任意追加品項可一起確認下單。
- [x] 手機版搜尋、選規格、改量、移除與送出可正常操作。
- [x] 不追加商品時的既有流程維持可用。

### Phase 3：通知與回歸驗證

#### Task 5：補強下單通知與端到端測試

**Description：** 確認 LINE 訊息會列出追加品項，API 可接受擴充 payload，且到貨頁自然讀回追加列。

**Acceptance criteria：**

- [x] 下單通知包含所有實際下單品項，不顯示數量 0 的取消品項。
- [x] 到貨頁顯示追加 SKU 及正確尚缺數量。
- [x] API、訊息與 repository 回歸測試通過。

**Verification：** `node --test test/api.test.js test/messenger.test.js test/sheets-repository.test.js`

**Dependencies：** Tasks 2、4。

**Files likely touched：**

- `src/line/messenger.js`
- `test/messenger.test.js`
- `test/api.test.js`

**Estimated scope：** Small。

#### Task 6：完整驗證與交接文件更新

**Description：** 執行完整測試、lint、build，更新交接文件的已完成功能與正式驗收步驟；不在此任務直接部署。

**Acceptance criteria：**

- [x] 所有自動驗證通過。
- [x] 文件記錄新增流程、限制及正式手機驗收項目。
- [x] 正式部署前列出預期變更與回復方式供使用者確認。

**Verification：**

- `npm.cmd test`
- `npm.cmd run lint`
- `npm.cmd run build`

**Dependencies：** Task 5。

**Files likely touched：**

- `docs/project-handoff-2026-07-17.md`
- `docs/purchase-order-item-addition-spec.md`
- `docs/purchase-order-item-addition-plan.md`

**Estimated scope：** Small。

## Checkpoint：完成

- [x] 規格全部成功標準已滿足。
- [x] 自動測試、lint、build 與本機手機操作均通過。
- [x] 未修改正式 Sheet 結構、飛鼠資料或正式 Cloud Run。
- [x] 已取得使用者部署同意並完成正式版本上線驗收（2026-07-17，見交接文件）。

## Risks and Mitigations

| 風險 | 影響 | 處理方式 |
| --- | --- | --- |
| 前端目錄載入後 SKU 被停用 | 加入不應採購品項 | 送出時由 repository 重讀 `SKU主檔` 驗證 |
| 雙擊確認造成追加列重複 | 採購與到貨數量錯誤 | 沿用操作金鑰與 `操作紀錄` 冪等檢查 |
| 追加列覆蓋既有 Sheet 資料 | 正式資料損毀 | 僅附加於最後使用列之後並先檢查 5000 列上限 |
| 原品項被前端省略 | 無法判斷取消或漏送 | 後端要求所有原 SKU 必須存在，取消需傳數量 0 |
| 同一 SKU 重複加入 | 同單兩列難以核對 | 前端禁用已加入 SKU，後端再次檢查唯一性 |
| 功能變成已下單後任意改單 | 到貨與稽核失去一致 | 本版只允許第一次確認前追加 |

## Open Questions

無。功能範圍已由使用者確認為可從全部可補貨商品中任意追加。
