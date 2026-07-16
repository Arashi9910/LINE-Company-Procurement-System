# 執行計畫：飛鼠新品目錄唯讀同步

## Phase 1：離線資料契約

### Task 1：解析並驗證官方 Excel

**Acceptance**

- 嚴格驗證七個固定表頭。
- 產生正規化貨品列並拒絕空白、重複貨品編號與無效庫存。
- 保留來源檔雜湊與列數供稽核。

**Verification**

- 單元測試涵蓋正常檔案、錯誤表頭、重複鍵及無效庫存。
- 對 2026-07-15 官方匯出檔得到 912 列。

### Task 2：產生差異預覽

**Acceptance**

- 分類新增、變更、未變、來源缺漏與既有目錄衝突。
- 不因庫存變化把商品標成描述變更。
- 報告只寫入 Git 忽略的 `work/`。

**Verification**

- 純函式測試覆蓋所有分類。
- 對現有兩份 Excel 執行後，統計可由人工抽查。

## Checkpoint：離線 PoC

- `npm test` 通過。
- 真實匯出檔資料契約通過。
- 沒有任何外部寫入。

## Phase 2：官方匯出自動化

### Task 3：Playwright 唯讀匯出器

**Acceptance**

- 從忽略檔讀取登入資訊且不記錄秘密。
- 只允許指定的飛鼠 HTTPS 主機。
- 登入後觸發官方 Excel 匯出，使用原子方式保存完成的下載檔。
- 驗證碼、OTP、登入失敗或找不到匯出控制項時安全停止。

**Verification**

- 用假頁面測試登入與下載控制流程。
- 實站執行一次唯讀下載並再次解析為 912 列。

### Task 4：命令列整合

**Acceptance**

- `--input` 支援離線 Excel，不啟動瀏覽器。
- 未指定 `--input` 時執行登入與官方匯出。
- `--baseline` 選填；指定後產生差異報告。
- 成功只輸出非機密摘要，失敗回傳非零結束碼。

**Verification**

- 命令列參數與報告路徑測試通過。
- 本機完整唯讀流程成功。

## Checkpoint：本機完整 PoC

- `npm test`、`npm run lint`、`npm run build` 通過。
- 實際下載檔與離線測試結果一致。
- 飛鼠與 Google Sheet 均未被修改。

## Phase 3：雲端排程（PoC 通過後）

### Task 5：獨立 Cloud Run Job

**Acceptance**

- 使用獨立容器與服務帳號，不改目前 LINE Cloud Run Service。
- 飛鼠帳密來自 Secret Manager。
- 工作只產生差異預覽，執行完成即退出。

### Task 6：Cloud Scheduler 與失敗通知

**Acceptance**

- 使用 `Asia/Taipei` 時區排程。
- 失敗留下可追查但不含秘密的記錄。
- 重跑不覆蓋既有報告，也不造成外部資料寫入。

## 風險

| 風險 | 處理方式 |
| --- | --- |
| 飛鼠頁面結構改版 | 使用語意與備援選擇器；找不到時停止並保留失敗證據 |
| 驗證碼或 OTP | 不繞過，停止並通知人工處理 |
| 雲端 IP 被限制 | 先在本機 PoC 驗證，再以雲端唯讀試跑確認 |
| 下載到不完整檔案 | 等待 Playwright download 完成後再原子改名 |
| 來源誤刪 | `sourceMissingItems` 永遠只作預覽，不自動刪除 |

## Phase 4：Google Sheet 審核與新品匯入

此階段採獨立規格與計畫，見：

- `docs/flyingmouse-sheet-review-spec.md`
- `docs/flyingmouse-sheet-review-plan.md`

部署腳本預設仍為 `read-only`；只有明確指定 `-SheetMode review` 才會寫入審核分頁並處理人工核准的新品。
