# 飛鼠目錄同步 Cloud Run Job

## 現行部署邊界

目前雲端工作會：

1. 使用 Secret Manager 帳密登入飛鼠。
2. 下載官方貨品 Excel。
3. 驗證來源資料。
4. 以 Google Sheet `SKU主檔!A:D` 作 baseline。
5. 將差異 upsert 至 `飛鼠目錄待確認`。
6. 只匯入人工設為 `核准匯入` 且來源指紋仍一致的新品。
7. 將摘要輸出到 Cloud Logging 後結束。

不修改飛鼠；描述變更、來源缺漏與衝突不會自動修改或刪除 `SKU主檔`。容器內下載檔與 JSON 報告只存在單次執行期間。

## 安全設計

- Job 與現有 LINE Cloud Run Service 分開部署。
- 飛鼠帳密只存 `flyingmouse-username`、`flyingmouse-password` 兩個 Secret Manager secret。
- `read-only` 模式使用 `spreadsheets.readonly`；只有明確部署為 `review` 時使用 `spreadsheets` 寫入 scope。
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

預設排程為每天台北時間 03:00：

```powershell
.\scripts\deploy-flyingmouse-job.ps1 `
  -ProjectId 'line-restock-20260714'
```

第一次部署建議先不建立排程，手動執行並檢查日誌：

```powershell
.\scripts\deploy-flyingmouse-job.ps1 `
  -ProjectId 'line-restock-20260714' `
  -SkipSchedule `
  -ExecuteNow
```

手動驗收成功後，再以不含 `-SkipSchedule` 的命令建立每日排程。

## 成功訊號

Cloud Run Job 結束碼為 0，日誌摘要應包含：

- `sheetMode: review`
- `readOnly: false`
- `mode: browser-export`
- `sourceRows`
- `referenceRows`
- `newItems`
- `changedItems`
- `sourceMissingKeys`
- `conflictGroups`
- `reviewSync.review`
- `reviewSync.approvals`

目前正式 `SKU主檔` 基準為 912 列、912 個唯一 SKU；這是本次盤點值，不是永久硬編碼的驗證門檻。

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

## 目前部署狀態（2026-07-15）

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
- 審核分頁：`飛鼠目錄待確認`（sheetId `592816291`），建立成功且目前只有表頭

## 到貨庫存回寫 Job（尚未部署）

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

目前狀態：程式、測試與部署資產已建立，但尚未建立正式 queue 分頁、尚未部署 writeback Job、尚未發送任何正式飛鼠 PUT。
