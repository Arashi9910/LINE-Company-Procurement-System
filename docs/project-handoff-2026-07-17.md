# LINE 公司補貨系統：專案進度交接

最後更新：2026-07-21（Asia/Taipei）

## 一句話狀態

LINE 補貨、老闆確認下單與追加商品、取消補貨、到貨登記、飛鼠每日目錄／庫存／圖片同步、新品核准後一分鐘匯入，以及到貨後正式回寫飛鼠庫存均已上線並完成首筆驗收。

## 正式環境

- GCP project：`line-restock-20260714`
- Region：`asia-east1`
- LINE Cloud Run service：`line-replenishment`
- URL：`https://line-replenishment-nskmggnorq-de.a.run.app`
- 正式 revision：`line-replenishment-00018-9sc`
- 正式程式 commit：`e491ca0acd2d99e67787a83c4d6a0486b194ff83`
- `/health`、`/ready`：2026-07-17 部署驗收均為正常
- `FLYINGMOUSE_WRITEBACK_ENABLED=true`：LINE 確認到貨時會建立飛鼠回寫事件
- Google Sheet：`16ko37-omRLDxdKXOX-VRwsCG3VyMerAO4EPBX_T10M8`

## Git 狀態

- 目前分支：`codex/workspace-cleanup-20260721`
- 本次正式驗收使用的乾淨 commit：`4626336`
- GitHub `main`：`431e15b`
- 部署時工作樹乾淨；正式驗收完成後只修改本交接文件與 Cloud Job 文件以保存證據。

## 已完成功能

1. LINE LIFF 手機補貨申請、搜尋商品／規格、多品項送出。
2. 老闆確認下單、調整原數量、從全部可補貨商品任意追加 SKU。
3. 部分到貨、多次到貨與完成到貨。
4. 原申請人或管理員用 `取消補貨 <補貨單號>` 取消仍為待確認的整張單。
5. LINE 群組查詢、授權與提醒功能。
6. 部署版本、Git commit、health／ready revision 追蹤。
7. 每天 03:00 登入飛鼠、下載官方 Excel、同步新品差異、既有 SKU 庫存快照與商品圖片。
8. 人工在 `飛鼠目錄待確認` 設為 `核准匯入` 後，由每分鐘排程只匯入核准新品至 `SKU主檔`；不重新登入飛鼠、不重抓 Excel、不全量重匯。
9. 新品快速匯入首次正式自動執行於 2026-07-17 12:42，Cloud Run 回傳 `200`。
10. 到貨回寫 queue、冪等事件、錯誤退避、人工確認，以及 live PUT 前刷新飛鼠即時庫存的程式與測試已完成。
11. 到貨回寫已完成真實 SKU dry-run、首筆 live PUT、三方對帳與每 5 分鐘 Scheduler 驗收。

最後一次完整驗證：169 項測試、lint、build 全部通過。

## 正式排程

| Scheduler | 狀態 | 頻率 | 用途 |
| --- | --- | --- | --- |
| `flyingmouse-catalog-sync-daily` | ENABLED | 每天 03:00，Asia/Taipei | Excel、目錄差異、庫存快照、圖片同步 |
| `flyingmouse-inventory-writeback-every-5-minutes` | ENABLED | 每 5 分鐘，Asia/Taipei | 將到貨事件回寫飛鼠庫存 |
| `line-replenishment-approved-imports` | ENABLED | 每分鐘 | 只匯入人工核准新品 |
| `line-replenishment-reminders` | ENABLED | 週一至週五 10:00 | 待確認與逾期到貨提醒 |

提醒 Scheduler 已改用 `X-Job-Token`，但修正後尚未等到下一個工作日 10:00 自然驗收。不要為了測試直接手動觸發，除非接受 LINE 群組可能立即收到提醒。

## 已完成：到貨後回寫飛鼠庫存

目前狀態：

- Cloud Run Job：`flyingmouse-inventory-writeback`
- Mode：`live`
- 部署 image：`flyingmouse-sync:20260721103733`
- Image digest：`sha256:a2ca92e27286f68c847769ff3b84a087c1dafe89f89fae9ef0ed7bd4f97deb72`
- 每次最多 20 筆、單 task、Cloud Run 平台 `maxRetries=0`。
- dry-run execution：`flyingmouse-inventory-writeback-k56wp`，`found=1`、`dryRun=1`、錯誤 0，沒有 PUT 或 Sheet 寫入。
- 首筆 live execution：`flyingmouse-inventory-writeback-r8556`，`found=1`、`completed=1`、錯誤 0。
- 驗收 SKU：`150E92-H2H應援棒收納包（無應援棒）`，飛鼠貨品 ID 175，到貨量 1，庫存 `20 → 21`。
- 三方對帳：飛鼠為 21、queue 為 `已完成` 且 before/target 20/21、`SKU主檔!E54` 為 21。
- Scheduler：`flyingmouse-inventory-writeback-every-5-minutes`，`ENABLED`，每 5 分鐘，`Asia/Taipei`。
- Scheduler 手動驗證 execution：`flyingmouse-inventory-writeback-xzr9r`，空 queue `found=0`、錯誤 0，成功結束。

## 其他待辦與暫緩項目

- 本次驗收後的兩份文件更新尚待提交或合併回 `main`。
- 10:00 提醒修正待下一個工作日自然驗收。
- LIFF 公司／群組邊界強化：使用者先前明確決定暫緩。
- 報關 APP 自動撈資料核對：只有構想，尚未研究可取得的資料與自動化方式。
- 獨立 staging LINE Channel、Sheet、Cloud Run：尚未建立，屬後續維運強化。
- ERP：目前不做，等量體成長後再評估。

## 重要部署注意事項

- 部署 LINE service 必須帶 `-EnableFlyingmouseWriteback`，否則部署腳本預設會把入列功能設回 `false`。
- `line-job-token` 的舊 Secret 原始值尾端含 CR/LF；程式自 `e491ca0` 起會在載入 `JOB_TOKEN` 時移除前後空白。未來若旋轉 Secret，應寫入無 BOM、無換行的純 token。
- 快速核准匯入只讀 `飛鼠目錄待確認` 與 `SKU主檔`，不可改成每分鐘登入飛鼠或重新下載 Excel。
- writeback 已通過首筆 live 驗收；未來若要改回 dry-run、重建 Job、變更重試／批次上限或人工修改 queue，仍需先確認正式資料影響。
- 飛鼠帳密只存在 Secret Manager／本機忽略檔，不可提交 GitHub 或輸出到日誌。

## 建議下次接續指令

「檢查飛鼠庫存回寫：查看最近 Scheduler／Cloud Run execution、`飛鼠庫存回寫` 的等待重試與人工確認事件，以及飛鼠與 `SKU主檔` 是否一致；先唯讀，不重跑已完成事件。」
