# 實作計畫：下單後於補貨追蹤修正規格

## Overview

在既有 `補貨追蹤` A:S 右側新增可搜尋的規格 SKU 下拉與稽核欄位。服務端不信任公式，會以 `SKU主檔` 重新驗證；合法修正在第一次到貨時與到貨、操作紀錄及飛鼠 queue 同批寫入並鎖定。

## Architecture Decisions

- 保留 N 欄作正式 SKU，以 T 欄作待套用修正；避免直接人工覆寫正式識別值。
- 以 SKU 作下拉值，因正式主檔有 14 組重複顯示名稱，顯示名稱不能作唯一鍵。
- V 欄保存原始 SKU；第一次到貨後 D、E、N 成為修正後顯示名稱、單位與 SKU，防止後續到貨回到舊規格。
- U 欄公式只提供即時操作提示；所有安全判斷在 Node.js 重做。
- Sheet 結構透過可重跑遷移函式建立，不在一般 HTTP 請求中自動改表。

## Task List

### Phase 1：資料契約與驗證

- [x] Task 1：建立規格修正純函式與欄位契約
  - Acceptance：可區分未修正、待套用、已套用與拒絕原因；只接受同商品且可補貨 SKU。
  - Verify：`node --test test/order-spec-correction.test.js`
  - Files：`src/sheets/order-spec-correction.js`、`test/order-spec-correction.test.js`
  - Dependencies：無

- [x] Task 2：將有效修正接入讀取與到貨交易
  - Acceptance：LINE／到貨頁使用 effective SKU；首次到貨同批更新 D/E/N/V；queue 使用新 SKU；非法修正不寫入。
  - Verify：`node --test test/sheets-repository.test.js test/api.test.js`
  - Files：`src/sheets/repository.js`、`test/sheets-repository.test.js`
  - Dependencies：Task 1

### Checkpoint：核心流程

- [x] 合法與非法修正整合測試通過。
- [x] 既有到貨、部分到貨、冪等與飛鼠 queue 測試不退步。

### Phase 2：Google Sheet 與使用者提示

- [x] Task 3：建立可重跑 Sheet 遷移
  - Acceptance：新增 T:V、下拉、公式、狀態色與隱藏稽核欄；既有 A:S 不變；表頭衝突時停止。
  - Verify：`node --test test/order-spec-correction-sheet.test.js`
  - Files：`src/sheets/order-spec-correction.js`、`scripts/configure-order-spec-correction.mjs`、`test/order-spec-correction-sheet.test.js`
  - Dependencies：Task 1

- [x] Task 4：在明細與到貨頁顯示修正提示
  - Acceptance：待套用或已套用的品項顯示「規格已修正」；錯誤修正可讀且不誤導為已生效。
  - Verify：`node --test test/workflow-view.test.js`
  - Files：`public/workflow.js`、`test/workflow-view.test.js`
  - Dependencies：Task 2

### Checkpoint：完整驗證

- [x] `npm.cmd test`
- [x] `npm.cmd run lint`
- [x] `npm.cmd run build`
- [x] `git diff --check`

### Phase 3：正式環境（另行確認）

- [ ] Task 5：先遷移正式 Google Sheet，再部署 Cloud Run
  - Acceptance：T:V 結構與驗證正確；新 revision `/ready` 成功；既有飛鼠即時與每小時補漏設定不變。
  - Verify：讀回 T1:V3 metadata、Cloud Run 100% 流量、`/ready` commit 相符。
  - Dependencies：Tasks 1–4 與使用者部署確認

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| 顯示名稱重複導致錯 SKU | 高 | 下拉與服務端一律用唯一 SKU |
| 已到貨後再換規格 | 高 | V 鎖定正式修正；後續異動拒絕 |
| 人工改寫 U 欄公式 | 中 | 服務端不信任 U，重新讀取主檔驗證 |
| 修正後與同單其他品項撞 SKU | 高 | 服務端檢查 effective SKU 唯一性並阻止到貨 |
| 新服務先於 Sheet 遷移上線 | 高 | 正式順序固定為 Sheet 遷移後再部署；readiness 驗證表頭 |

## Open Questions

無。
