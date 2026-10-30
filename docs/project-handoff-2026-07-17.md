# LINE 公司補貨系統：專案進度交接

最後更新：2026-07-23（Asia/Taipei；LINE 查詢卡片分頁正式部署）

## 一句話狀態

LINE 補貨、老闆確認下單與追加商品、取消補貨、到貨登記、查詢卡片分頁、新品核准後一分鐘匯入均已上線；飛鼠商品／圖片同步與到貨庫存回寫已合併為每小時 Cloud Run Job，並完成正式切換與首筆回寫驗收。

## 正式環境

- GCP project：`line-restock-20260714`
- Region：`asia-east1`
- LINE Cloud Run service：`line-replenishment`
- URL：`https://line-replenishment-nskmggnorq-de.a.run.app`
- 最新有文件記錄的 LINE revision：`line-replenishment-00025-gfg`
- 該 revision 程式 commit：`582857462f984b46f72e6112001794cfec43c876`
- `/health`、`/ready`：2026-07-23 已驗證皆為 `ok: true`，commit 與 revision 相符，且新 revision 承接 100% 流量
- `FLYINGMOUSE_WRITEBACK_ENABLED=true`：LINE 確認到貨時會建立飛鼠回寫事件
- Google Sheet：`16ko37-omRLDxdKXOX-VRwsCG3VyMerAO4EPBX_T10M8`

## Git 狀態

- 2026-07-23 文件校正時的本機分支：`codex/auto-flyingmouse-catalog-sync`
- 每小時合併 Job 正式切換紀錄 commit：`97139bd`
- 首筆庫存回寫正式驗收使用的乾淨 commit：`4626336`
- PR #1 已由 merge commit `947a4d3` 進入 `main`；每小時合併 Job 位於後續分支，是否再合併回 `main` 應以 GitHub 最新狀態為準。

## 已完成功能

1. LINE LIFF 手機補貨申請、搜尋商品／規格、多品項送出；數量可使用減／加按鈕或直接輸入整數。
2. 老闆確認下單、調整原數量、從全部可補貨商品任意追加 SKU。
3. 部分到貨、多次到貨與完成到貨。
4. 原申請人或管理員用 `取消補貨 <補貨單號>` 取消仍為待確認的整張單。
5. LINE 群組查詢、授權與提醒功能；查詢超過 10 筆時可由卡片下方切換上一頁／下一頁。
6. 部署版本、Git commit、health／ready revision 追蹤。
7. 每小時整點執行飛鼠合併 Job：登入、下載官方 Excel、自動同步商品主檔／庫存快照／商品圖片，再處理到貨回寫佇列。
8. 人工在 `飛鼠目錄待確認` 設為 `核准匯入` 後，由每分鐘排程只匯入核准新品至 `SKU主檔`；不重新登入飛鼠、不重抓 Excel、不全量重匯。
9. 新品快速匯入首次正式自動執行於 2026-07-17 12:42，Cloud Run 回傳 `200`。
10. 到貨回寫 queue、冪等事件、錯誤退避、人工確認，以及 live PUT 前刷新飛鼠即時庫存的程式與測試已完成。
11. 到貨回寫已完成真實 SKU dry-run、首筆 live PUT、三方對帳；原本每 5 分鐘的獨立 Scheduler 驗收完成後，已由每小時合併 Job 取代。
12. `line-replenishment-reminders` 已於 2026-07-21、2026-07-22 10:00 自然執行並回傳 `200`；2026-07-22 另完成 `line-job-token` 輪替與每分鐘核准匯入自然排程驗證。
13. `flyingmouse-catalog-sync` 已改用合併入口，正式模式為商品 `auto`、庫存 `live`；舊庫存 Scheduler 已刪除，舊 Job 本體只保留作緊急回復。

2026-07-23 本機完整驗證：204 項測試、lint（66 個檔案）、build 全部通過。

## 正式排程

| Scheduler | 狀態 | 頻率 | 用途 |
| --- | --- | --- | --- |
| `flyingmouse-catalog-sync-daily` | ENABLED | 每小時整點，Asia/Taipei | 商品主檔、庫存快照、圖片同步成功後，再處理到貨回寫 |
| `line-replenishment-approved-imports` | ENABLED | 每分鐘 | 只匯入人工核准新品 |
| `line-replenishment-reminders` | ENABLED | 週一至週五 10:00 | 待確認與逾期到貨提醒 |

`flyingmouse-inventory-writeback-every-5-minutes` 已於 2026-07-22 刪除；舊 `flyingmouse-inventory-writeback` Cloud Run Job 保留但沒有排程。

提醒 Scheduler 已改用 `X-Job-Token`，並於 2026-07-21、2026-07-22 10:00 自然執行成功。2026-07-22 token 輪替後，兩個 HTTP Scheduler 均已確認與最新 Secret 一致；`line-replenishment-approved-imports` 於新 revision 的下一次自然排程回傳 `200`。

## 已完成：到貨後回寫飛鼠庫存

目前狀態：

- 現行 Cloud Run Job：`flyingmouse-catalog-sync`，入口為 `scripts/flyingmouse-combined-job.mjs`
- Mode：商品 `auto`、庫存 `live`
- 部署 image：`flyingmouse-sync:20260722112109`
- 正式合併驗收 execution：`flyingmouse-catalog-sync-5xlrb`，商品與圖片同步成功，queue `found=0`、錯誤 0
- Scheduler：沿用 `flyingmouse-catalog-sync-daily` 名稱，實際為每小時整點，`Asia/Taipei`
- 每次最多 20 筆、單 task、Cloud Run 平台 `maxRetries=0`。
- 舊 `flyingmouse-inventory-writeback` Job 暫時保留但沒有 Scheduler，不會自行執行。

首筆 live 回寫驗收紀錄：

- dry-run execution：`flyingmouse-inventory-writeback-k56wp`，`found=1`、`dryRun=1`、錯誤 0，沒有 PUT 或 Sheet 寫入。
- 首筆 live execution：`flyingmouse-inventory-writeback-r8556`，`found=1`、`completed=1`、錯誤 0。
- 驗收 SKU：`150E92-H2H應援棒收納包（無應援棒）`，飛鼠貨品 ID 175，到貨量 1，庫存 `20 → 21`。
- 三方對帳：飛鼠為 21、queue 為 `已完成` 且 before/target 20/21、`SKU主檔!E54` 為 21。
- 歷史 Scheduler 驗證 execution：`flyingmouse-inventory-writeback-xzr9r`，空 queue `found=0`、錯誤 0，成功結束；該 Scheduler 後續已刪除。

## 暫緩與後續項目

- 本次驗收證據由 GitHub PR #1 管理；是否已進入 `main` 以 PR merge 狀態為準。
- LIFF 公司／群組邊界強化：使用者先前明確決定暫緩。
- 報關 APP 自動撈資料核對：只有構想，尚未研究可取得的資料與自動化方式。
- 獨立 staging LINE Channel、Sheet、Cloud Run：尚未建立，屬後續維運強化。
- ERP：目前不做，等量體成長後再評估。

## 重要部署注意事項

- 部署 LINE service 必須帶 `-EnableFlyingmouseWriteback`，否則部署腳本預設會把入列功能設回 `false`。
- `line-job-token` 的舊 Secret 原始值尾端含 CR/LF；程式自 `e491ca0` 起會在載入 `JOB_TOKEN` 時移除前後空白。2026-07-22 已輪替為 Secret Manager version 3，內容為無 BOM、無換行的隨機 token；兩個 HTTP Scheduler 已同步，舊 versions 1、2 均為 disabled。
- 快速核准匯入只讀 `飛鼠目錄待確認` 與 `SKU主檔`，不可改成每分鐘登入飛鼠或重新下載 Excel。
- writeback 已通過首筆 live 驗收；未來若要改回 dry-run、重建 Job、變更重試／批次上限或人工修改 queue，仍需先確認正式資料影響。
- 飛鼠帳密只存在 Secret Manager／本機忽略檔，不可提交 GitHub 或輸出到日誌。

## 建議下次接續指令

「檢查飛鼠每小時合併 Job：查看 `flyingmouse-catalog-sync-daily` 最近一次 Scheduler／Cloud Run execution、商品與 writeback 兩階段摘要、`飛鼠庫存回寫` 的等待重試與人工確認事件，以及飛鼠與 `SKU主檔` 是否一致；先唯讀，不重跑已完成事件。」
