# 飛鼠每小時合併同步 Cloud Run Job

> 現況摘要（2026-07-22）：正式 `flyingmouse-catalog-sync` 已使用 `scripts/flyingmouse-combined-job.mjs`，每小時整點依序執行商品／圖片同步與到貨庫存回寫。本文後半保留 2026-07-15 至 2026-07-21 的舊架構與驗收紀錄；遇到排程或 Job 說明衝突時，以「2026-07-22 每小時合併 Job 正式狀態」為準。

## 現行部署邊界

目前雲端工作會：

1. 使用 Secret Manager 帳密登入飛鼠。
2. 下載官方貨品 Excel。
3. 驗證來源資料。
4. 以 Google Sheet `SKU主檔` 作 baseline；正式 `auto` 模式新增飛鼠 SKU 並更新來源管理的 B:H 欄位。
5. 同步既有 SKU 庫存快照與 `商品圖片對照`，保留公式欄、人工圖片及來源缺漏列。
6. 商品與圖片階段成功後，讀取 `飛鼠庫存回寫`，正式 `live` 模式每次最多處理 20 筆事件。
7. 將 catalog 與 writeback 兩階段摘要輸出到 Cloud Logging 後結束。

商品同步不修改飛鼠；只有已完成驗收的到貨回寫階段會更新飛鼠庫存。來源缺漏列不會自動刪除，與非飛鼠供應商發生 SKU 衝突時會整批停止。容器內下載檔與 JSON 報告只存在單次執行期間。

## 安全設計

- Job 與現有 LINE Cloud Run Service 分開部署。
- 飛鼠帳密只存 `flyingmouse-username`、`flyingmouse-password` 兩個 Secret Manager secret。
- `read-only` 模式使用 `spreadsheets.readonly`；只有明確部署為 `review` 或 `auto` 時使用 `spreadsheets` 寫入 scope。
- 部署腳本安全預設為商品 `read-only`、庫存 `dry-run`；庫存切換為 `live` 時必須同時提供 `-ApproveLive`。
- 合併 Job 固定單 task、Cloud Run 平台 `maxRetries=0`；商品階段失敗時不會繼續庫存回寫。
- Cloud Build 使用 `.gcloudignore.flyingmouse` allow-list，不上傳 `.env`、`work/`、測試、文件或 Claude 橋接檔。
- Playwright 套件與 Docker image 固定為相同版本。
- 登入驗證碼、OTP、官方表頭變更、重複貨品編號或下載異常都會讓 Job 失敗。

## 建置前驗證

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

## 設定 Secret Manager

此命令會把本機忽略檔中的帳號與密碼新增為 Secret Manager 版本，不會把值輸出到終端：

```powershell
.\scripts\configure-flyingmouse-secrets.ps1 `
  -ProjectId 'line-restock-20260714'
```

既有 secret 預設保留；只有明確加上 `-Rotate` 才新增版本。

## 部署 Job

部署腳本預設排程為每小時整點，但資料模式維持安全的 `read-only/dry-run`：

```powershell
.\scripts\deploy-flyingmouse-job.ps1 `
  -ProjectId 'line-restock-20260714'
```

第一次部署或模式變更建議先不建立排程，手動執行並檢查日誌：

```powershell
.\scripts\deploy-flyingmouse-job.ps1 `
  -ProjectId 'line-restock-20260714' `
  -SkipSchedule `
  -ExecuteNow
```

正式現行模式必須明確指定可寫商品與庫存模式：

```powershell
.\scripts\deploy-flyingmouse-job.ps1 `
  -ProjectId 'line-restock-20260714' `
  -SheetMode 'auto' `
  -WritebackMode 'live' `
  -ApproveLive
```

手動驗收成功後，再以不含 `-SkipSchedule` 的命令建立每小時整點排程。單次 Job timeout 為 6 分鐘、Cloud Run 平台重試為 0；失敗時由下一個整點排程重試。Scheduler 資源名稱為了相容既有部署仍保留 `flyingmouse-catalog-sync-daily`。

## 成功訊號

Cloud Run Job 結束碼為 0，合併工作日誌應同時包含 catalog 與 writeback 階段。catalog 摘要至少應包含：

- `sheetMode`
- `readOnly: false`
- `mode: browser-export`
- `sourceRows`
- `referenceRows`
- `newItems`
- `changedItems`
- `sourceMissingKeys`
- `conflictGroups`
- `catalogSync`
- `inventorySync`
- `productImageSync`

writeback 摘要至少應包含 `mode`、`found`、`completed`、`failed` 與 `manualReview`。若 catalog 階段失敗，Job 必須直接失敗，且不應出現已開始 writeback 的紀錄。

2026-07-15 初次盤點的 `SKU主檔` 基準為 912 列、912 個唯一 SKU；這是歷史驗收值，不是目前筆數或永久硬編碼的驗證門檻。

## 審核模式

部署腳本預設仍是 `read-only`，只有人工指定下列參數才會開啟 Google Sheets 寫入：

```powershell
.\scripts\deploy-flyingmouse-job.ps1 `
  -ProjectId 'line-restock-20260714' `
  -SheetMode 'review'
```

`review` 模式會：

1. 建立或驗證 `飛鼠目錄待確認` 分頁。
2. 以同步鍵更新差異，保留審核備註與有效的人工作業狀態。
3. 只處理人工設為 `核准匯入` 且來源指紋仍一致的新品。
4. 新品加入 `SKU主檔` 時預設 `是否可補貨 = 是`，核准後立即可補貨，並避開 K、N 陣列公式欄。

描述變更、來源缺漏與衝突仍只供審核，不自動修改或刪除主檔。完整資料契約見 `docs/flyingmouse-sheet-review-spec.md`。

## 完全自動模式

`自動同步` 功能部署時必須明確指定可寫模式：

```powershell
.\scripts\deploy-flyingmouse-job.ps1 `
  -ProjectId 'line-restock-20260714' `
  -SheetMode 'auto'
```

`auto` 模式會將飛鼠作為飛鼠 SKU 的主要資料來源：新品直接加入 `SKU主檔`，既有飛鼠 SKU 更新 B:H，並保留 K/N 公式與來源缺漏列。服務帳號在 Job 層級需要 `roles/run.invoker` 以啟動 Job，以及 `roles/run.viewer` 以查詢 execution；部署腳本會同時設定。

切換 `auto`、首次執行及正式 Sheet 驗收都是獨立的正式環境關卡，不會因程式合併而自動執行。

## 歷史：正式 auto 初次上線（2026-07-22，合併前）

- LINE Cloud Run revision：`line-replenishment-00024-2lv`
- Git commit：`3e6964b067f6eb8c7a976c3775062ef8606dff7e`
- 目錄 Job mode：`auto`
- 首次成功 execution：`flyingmouse-catalog-sync-vjkbn`（32.65 秒）
- 來源 959 個 SKU；正式主檔新增 5、更新 11，圖片 959／959 全部配對。
- 舊基準 912 個 SKU 的 `主要供應商` 空白已一次性識別為 `飛鼠`；不同供應商的未來衝突仍會整批停止。
- 上線當下自動排程：每 5 分鐘，`Asia/Taipei`；此設定已於同日後續的每小時合併 Job 切換中取代。

## 歷史：首次部署狀態（2026-07-15）

- GCP project：`line-restock-20260714`
- Region：`asia-east1`
- Artifact Registry：`line-automation`
- Cloud Run Job：`flyingmouse-catalog-sync`
- 首次 image：`flyingmouse-sync:20260715110503`
- 首次 execution：`flyingmouse-catalog-sync-txk66`
- 首次 execution 結果：18.29 秒完成，912 個來源 SKU 與 912 個 `SKU主檔` SKU 全部吻合
- Cloud Scheduler：`flyingmouse-catalog-sync-daily`
- 排程：每天 `03:00`，時區 `Asia/Taipei`
- 第一次排程執行：2026-07-16 03:00（Asia/Taipei）
- 目前線上模式：`review`
- Review image：`flyingmouse-sync:20260715112800`
- Review image digest：`sha256:6a2e9108b48e1b4d43601553a2a6a25125e582250cab84882b1d46a981352cb5`
- Review execution：`flyingmouse-catalog-sync-nkgdv`
- Review execution 結果：24.63 秒完成，912 對 912，零差異、零核准、零匯入
- 審核分頁：`飛鼠目錄待確認`（sheetId `592816291`），首次驗收時建立成功且只有表頭

## 歷史：03:00 自動同步結果（2026-07-17）

- Scheduler：`flyingmouse-catalog-sync-daily`，狀態 `ENABLED`
- 實際啟動：2026-07-17 03:00:05（Asia/Taipei）
- Execution：`flyingmouse-catalog-sync-wms8j`
- 結果：30.76 秒完成，`succeededCount: 1`
- 飛鼠來源：933 筆；`SKU主檔`：932 筆；成功配對 932 筆
- 新品：1 筆，已新增至 `飛鼠目錄待確認`，尚未核准或匯入
- 描述變更／來源缺漏／衝突：皆為 0
- 庫存快照：更新 29 筆、未變 903 筆、配對率 100%
- 圖片：新增 1 筆、更新 3 筆、未變 929 筆；未覆蓋人工保護資料
- 下一次排程：2026-07-18 03:00（Asia/Taipei）

## 歷史：獨立到貨庫存回寫 Job（已由合併 Job 取代）

庫存回寫使用獨立的 `flyingmouse-inventory-writeback` Cloud Run Job，與每日 03:00 的目錄同步分開。它會讀取 `飛鼠庫存回寫` 分頁，依序處理到貨事件；LINE 服務的 `FLYINGMOUSE_WRITEBACK_ENABLED` 預設為 `false`，在分頁與 worker 驗收完成前不得開啟。

部署腳本預設為 `dry-run`、每 5 分鐘、單 task、Cloud Run 平台 retry 0：

```powershell
.\scripts\deploy-flyingmouse-writeback-job.ps1 `
  -ProjectId 'line-restock-20260714' `
  -SkipSchedule `
  -ExecuteNow
```

第一次 dry-run 會建立或驗證 `飛鼠庫存回寫` 分頁；即使 queue 有事件，也只會登入、GET、計算目標庫存，不會發送 PUT，也不會變更 queue 狀態。

只有完成 dry-run 與真實 SKU 驗收準備、並再次取得使用者同意後，才可執行：

```powershell
.\scripts\deploy-flyingmouse-writeback-job.ps1 `
  -ProjectId 'line-restock-20260714' `
  -Mode 'live' `
  -ApproveLive
```

正式啟用順序：

1. 部署 dry-run Job 並建立 queue 分頁。
2. 手動執行，確認 Cloud Logging、GET 與計算結果。
3. 經核准後以 `-Mode live -ApproveLive` 更新 worker。
4. 選定一筆真實到貨事件驗證只增加一次。
5. 最後才部署 LINE Service 的 `FLYINGMOUSE_WRITEBACK_ENABLED=true`。

## 歷史：庫存回寫 dry-run 部署狀態（2026-07-16）

> 歷史快照：本節與其後的 2026-07-17 補充保留當時的部署狀態。`Cloud Scheduler 尚未建立`、`正式 PUT 為 0` 等敘述已由下方「庫存回寫正式驗收狀態（2026-07-21）」取代，不代表目前正式環境。

- GCP project：`line-restock-20260714`
- Region：`asia-east1`
- Cloud Run Job：`flyingmouse-inventory-writeback`
- Mode：`dry-run`
- Image：`flyingmouse-sync:20260716114701`
- Image digest：`sha256:872b7c1870017e1ef360c8073af778808078a78445e85bb4dc60e670db71dc63`
- 首次 execution：`flyingmouse-inventory-writeback-qhp9m`
- 首次 execution 結果：14.69 秒完成，`sheetCreated: true`、`found: 0`、錯誤 0
- 回寫分頁：`飛鼠庫存回寫`，已建立成功
- Cloud Scheduler：尚未建立；首次驗收維持手動執行
- LINE Service revision：`line-replenishment-00015-v6t`
- LINE Service commit：`942327f5c73b255db302097a27d0617717b451d2`
- LINE Service：`FLYINGMOUSE_WRITEBACK_ENABLED=true`；2026-07-16 19:56（Asia/Taipei）後的新到貨確認會建立回寫事件
- 飛鼠庫存 PUT：0 次

當時 dry-run 部署、空 queue 驗收與 LINE 入列功能均已完成，`/health`、`/ready` 皆正常。當時的下一階段是以一筆新到貨事件手動執行 dry-run，驗證飛鼠 GET 與目標庫存計算；切換 live 前仍需再次取得使用者同意。

2026-07-17 當時已完成「寫入前先刷新本次到貨 SKU」程式：新 live 事件會先把 queue `已準備` 與飛鼠即時 `beforeStock` 原子寫入 `SKU主檔`，再次 GET 未變動才允許 PUT。154 項測試、lint 與 build 已通過；當時此版本尚未重新部署至 writeback Job，正式 PUT 仍為 0 次。

## 歷史：庫存回寫正式驗收狀態（2026-07-21）

- 驗收來源：乾淨工作樹 commit `4626336`；169 項測試、lint、build 全部通過。
- 正式 image：`flyingmouse-sync:20260721103733`。
- 正式 image digest：`sha256:a2ca92e27286f68c847769ff3b84a087c1dafe89f89fae9ef0ed7bd4f97deb72`。
- Job mode：`live`；每次最多 20 筆；單 task；Cloud Run 平台 `maxRetries=0`。
- dry-run execution：`flyingmouse-inventory-writeback-k56wp`，`found=1`、`dryRun=1`、錯誤 0，Sheet 與飛鼠 PUT 均為 0 次。
- 首筆 live execution：`flyingmouse-inventory-writeback-r8556`，`found=1`、`completed=1`、錯誤／重試／人工確認均為 0。
- 驗收 SKU：`150E92-H2H應援棒收納包（無應援棒）`，飛鼠貨品 ID 175，本次到貨量 1，庫存 `20 → 21`。
- 三方對帳：飛鼠 GET 為 21、`飛鼠庫存回寫` 為 `已完成` 且 before/target 為 20/21、`SKU主檔` 庫存快照為 21。
- Cloud Scheduler：`flyingmouse-inventory-writeback-every-5-minutes`，`ENABLED`，`*/5 * * * *`，`Asia/Taipei`。
- Scheduler 驗證 execution：`flyingmouse-inventory-writeback-xzr9r`，空 queue 結果 `found=0`、錯誤 0，執行成功。

庫存回寫在當時已完成首筆正式 PUT 與每 5 分鐘排程驗收；該排程後續已由每小時合併 Job 取代。現行 worker 若發現即時庫存不再等於 queue 的 before/target，仍會停止 PUT 並轉為人工確認。

## 新品核准後一分鐘匯入（2026-07-17）

- 03:00 的 `flyingmouse-catalog-sync-daily` 維持原流程，仍負責下載 Excel、比對新品、更新既有 SKU 庫存快照及同步圖片。
- LINE Service 新增受 `JOB_TOKEN` 保護的 `/jobs/flyingmouse-approved-imports` 路由。
- `line-replenishment-approved-imports` Scheduler 設定為每分鐘執行，只從 `飛鼠目錄待確認` 讀取 `核准匯入` 的新品快照並寫入 `SKU主檔`。
- 快速匯入不登入飛鼠、不下載 Excel、不重跑圖片，也不全量重匯 SKU；沒有核准列時不寫入 Sheet。
- 正式 Cloud Run revision：`line-replenishment-00018-9sc`
- 正式 Git commit：`e491ca0acd2d99e67787a83c4d6a0486b194ff83`
- `line-replenishment-approved-imports`：`ENABLED`，排程 `* * * * *`，時區 `Asia/Taipei`
- 首次確認成功：2026-07-17 12:42（Asia/Taipei），Cloud Run 請求狀態 `200`
- 部署驗收時發現舊 `line-job-token` Secret 尾端含 CR/LF；服務載入設定時已正規化前後空白，並以回歸測試防止相同問題再次造成 Scheduler `401`。
- `line-replenishment-reminders` 已於 2026-07-21、2026-07-22 10:00 自然執行並回傳 `200`，不需再以人工觸發驗收。
- 2026-07-22 已將 `line-job-token` 輪替為 Secret Manager version 3（無 BOM、無換行），舊 versions 1、2 均已 disabled；Cloud Run 更新為 `line-replenishment-00022-hgt`，兩個 HTTP Scheduler header 均與最新 Secret 一致。
- 輪替後 `line-replenishment-approved-imports` 在 2026-07-22 13:02（Asia/Taipei）由新 revision 自然執行並回傳 `200`；`/health`、`/ready` 亦正常。

## 2026-07-22 每小時合併 Job 正式狀態

- 正式 Job：`flyingmouse-catalog-sync`，入口改為 `scripts/flyingmouse-combined-job.mjs`。
- 執行順序：商品主檔與圖片同步成功後，才執行庫存正式回寫。
- 模式：商品 `auto`、庫存 `live`、每次庫存上限 20、平台重試 0、timeout 6 分鐘。
- Scheduler：沿用 `flyingmouse-catalog-sync-daily` 資源名稱，實際排程為 `0 * * * *`、`Asia/Taipei`。
- 正式 image：`flyingmouse-sync:20260722112109`。
- 驗收 execution：`flyingmouse-catalog-sync-5xlrb`，35.33 秒，`succeededCount=1`。
- 商品驗收：959 項全數吻合，新增 0、更新 0、缺漏 0、衝突 0；圖片 959 項全數吻合。
- 庫存驗收：live mode，queue found 0、failed 0、manual review 0。
- 舊 Scheduler `flyingmouse-inventory-writeback-every-5-minutes` 已刪除，避免重複登入及額外最低一分鐘計費。
- 舊 Cloud Run Job `flyingmouse-inventory-writeback` 暫時保留但沒有排程，供緊急回復使用，不會自行執行或產生運算費。
- 本節取代文件內較早的 5 分鐘商品／庫存排程記錄；舊段落保留為歷史驗收資料。
