# 採購草稿與轉單上線紀錄（2026-09-29）

使用者已授權正式部署與必要的試算表初始化。

## 版本

- 功能 commit：`97ab25b`。
- 部署 commit：`9f231222b1c1d14bf68f2fcbc3022e5152e565b9`，另含短暫暫停寫入的維護模式。
- 原正式 revision：`line-replenishment-00042-gwh`。
- 維護 revision：`line-replenishment-draft-hold-9f23122`。
- 目標正式 revision：`line-replenishment-draft-live-9f23122`。
- 從提交版本匯出部署包，未包含先前未提交的 `flyingmouse-catalog-job.js` 與相關測試修改。
- 部署包完整測試 272 項通過；數量與工作區不同，因排除了上述未提交修改的七項測試，另新增一項維護模式測試。

## 試算表

- 正式表：`16ko37-omRLDxdKXOX-VRwsCG3VyMerAO4EPBX_T10M8`。
- 上線前完整備份：[補貨追蹤系統－轉單草稿上線前備份](https://docs.google.com/spreadsheets/d/1TDMD4aP95ZZ_8qmrWLTb5Fceqb1gSUZBpsOFN0IRMaU/edit)。備份內另附「轉單公式驗證」分頁，原分頁不變。
- 新增「採購草稿」1710000000、「採購草稿品項」1710000001、「轉單關聯」1710000002。每頁 20000 列、凍結表頭，欄名與程式一致。
- `補貨追蹤!G2:G5000`：保留既有五種狀態及嚴格下拉規則，增加已轉單。
- `補貨追蹤!K2`：沿用原未到量計算，已轉單來源回傳 0。
- `補貨追蹤!L2`：來源自身為已轉單不警示；重複數量統計也排除已轉單。
- 公式先在備份的獨立測試區驗證五種代表案例，再套用正式兩個公式儲存格。既有訂單值未被改寫。
- 表頭、公式、下拉規則均已透過 API 回讀；三個新分頁亦已在 Google Sheets 畫面檢查。

## 切換策略

- 保留每日待辦及飛鼠庫存回寫原有 true 設定，啟用 `PURCHASE_DRAFTS_ENABLED=true`。
- 服務與 revision 的最大 instance 設為 1，並行數保留 20。
- 建置新版時不切流量；先切至拒絕所有寫入的維護 revision，保留健康及靜態讀取。
- 維護流量於 11:36:55 UTC 生效；正式 `/ready` 200、測試 POST 回 503 MAINTENANCE，未建立任何訂單。
- 原先預留原服務 300 秒請求上限；實際確認舊 revision 已 Retired，11:36:59 UTC 記錄 SIGTERM 關閉，經過三分鐘以上後才啟用新 writer。Google 官方說明 SIGTERM 後有 10 秒關閉緩衝，詳見 [Cloud Run runtime contract](https://docs.cloud.google.com/run/docs/container-contract#instance-shutdown)。

## 最終驗證

- 2026-09-29 19:41:16（Asia/Taipei）目標 revision 已承接 100% 流量，Ready／ConfigurationsReady／RoutesReady 均為 True。
- `/health`、`/ready` 均 200，回傳 commit `9f231222b1c1d14bf68f2fcbc3022e5152e565b9` 與 `line-replenishment-draft-live-9f23122`。
- 新版 `PURCHASE_DRAFTS_ENABLED=true`、`MAINTENANCE_MODE=false`、`DAILY_TODOS_ENABLED=true`、`FLYINGMOUSE_WRITEBACK_ENABLED=true`。
- 服務及 revision 最大 instance 都是 1。
- 未登入的草稿讀取／送出端點回傳 401，未建立測試訂單、未發送測試 LINE 通知。
- 前端 `app.js` 與 `purchase-drafts.js` 的正式回傳內容雜湊與部署包一致。
- 新表頭、狀態驗證與公式回讀正常。真實手機 LINE 內的登入與下單操作留給使用者首次使用驗收，本次沒有冒用人員身分測試。

## 回復方式

若上線後有問題，先切至維護 revision 阻止寫入並等待處理中請求結束，再決定回復程式。若已產生新草稿或已轉單資料，不可直接覆蓋整份試算表備份，必須先核對新紀錄。正常保留新增分頁與向下相容的公式／下拉更新即可。
