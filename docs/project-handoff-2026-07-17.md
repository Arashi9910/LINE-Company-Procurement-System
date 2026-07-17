# LINE 公司補貨系統：專案進度交接

最後更新：2026-07-17（Asia/Taipei）

## 一句話狀態

LINE 補貨、老闆確認下單與追加商品、取消補貨、到貨登記、飛鼠每日目錄／庫存／圖片同步，以及新品核准後一分鐘匯入均已上線。主要未完成項目是「到貨後正式回寫飛鼠庫存」的真實 SKU dry-run、live 首筆驗收與自動排程。

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

- 發布分支：`codex/purchase-order-additions-release`
- 本文件建立前分支 head：`a111fcd`
- GitHub `main`：`fa91748`
- 發布分支領先 `main` 29 個 commits，且 `main` 是發布分支祖先；功能已備份但尚未合併回 `main`。
- 使用乾淨 worktree：`work/release-purchase-order-additions`，不要從有其他未提交檔案的根工作區部署。

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

最後一次完整驗證：160 項測試、lint、build 全部通過。

## 正式排程

| Scheduler | 狀態 | 頻率 | 用途 |
| --- | --- | --- | --- |
| `flyingmouse-catalog-sync-daily` | ENABLED | 每天 03:00，Asia/Taipei | Excel、目錄差異、庫存快照、圖片同步 |
| `line-replenishment-approved-imports` | ENABLED | 每分鐘 | 只匯入人工核准新品 |
| `line-replenishment-reminders` | ENABLED | 週一至週五 10:00 | 待確認與逾期到貨提醒 |

提醒 Scheduler 已改用 `X-Job-Token`，但修正後尚未等到下一個工作日 10:00 自然驗收。不要為了測試直接手動觸發，除非接受 LINE 群組可能立即收到提醒。

## 主要未完成：到貨後回寫飛鼠庫存

目前狀態：

- Cloud Run Job：`flyingmouse-inventory-writeback`
- Mode：`dry-run`
- 部署 image：`flyingmouse-sync:20260716114701`
- 這是 2026-07-16 的舊 dry-run image，尚未包含 2026-07-17 完成的「寫入前刷新 SKU主檔快照」最新版。
- 只有一次空 queue 成功執行紀錄：`flyingmouse-inventory-writeback-qhp9m`
- 尚未建立 writeback Scheduler。
- `飛鼠庫存回寫!F1:F5000` 目前只有表頭，事件數 0。
- 正式 PUT 次數 0。

建議依序完成：

1. 把最新版 worker 部署為 dry-run。
2. 建立一張受控測試補貨單並確認到貨，產生一筆 queue 事件。
3. 手動執行 dry-run，確認登入、精確 SKU、`beforeStock` 與 `targetStock`，並確認 PUT 仍為 0。
4. 再次取得使用者同意，才部署 `live -ApproveLive`。
5. 執行第一筆正式 PUT，核對飛鼠、queue 與 `SKU主檔` 一致。
6. 成功後建立每 5 分鐘 Scheduler，平台 retry 維持 0，由 worker 自己管理重試與人工確認。

## 其他待辦與暫緩項目

- GitHub 發布分支尚未合併回 `main`；建議庫存回寫完成後一次整理。
- 10:00 提醒修正待下一個工作日自然驗收。
- LIFF 公司／群組邊界強化：使用者先前明確決定暫緩。
- 報關 APP 自動撈資料核對：只有構想，尚未研究可取得的資料與自動化方式。
- 獨立 staging LINE Channel、Sheet、Cloud Run：尚未建立，屬後續維運強化。
- ERP：目前不做，等量體成長後再評估。

## 重要部署注意事項

- 部署 LINE service 必須帶 `-EnableFlyingmouseWriteback`，否則部署腳本預設會把入列功能設回 `false`。
- `line-job-token` 的舊 Secret 原始值尾端含 CR/LF；程式自 `e491ca0` 起會在載入 `JOB_TOKEN` 時移除前後空白。未來若旋轉 Secret，應寫入無 BOM、無換行的純 token。
- 快速核准匯入只讀 `飛鼠目錄待確認` 與 `SKU主檔`，不可改成每分鐘登入飛鼠或重新下載 Excel。
- 未經明確同意，不可切換 writeback live、建立正式 PUT、修改正式庫存或刪除 queue 資料。
- 飛鼠帳密只存在 Secret Manager／本機忽略檔，不可提交 GitHub 或輸出到日誌。

## 建議下次接續指令

「繼續到貨庫存回寫：先把最新版 worker 部署為 dry-run，建立受控測試到貨事件，驗證飛鼠 GET 與目標庫存；禁止 PUT。」
