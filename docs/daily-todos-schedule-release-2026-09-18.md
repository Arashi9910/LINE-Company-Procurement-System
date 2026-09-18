# 每日待辦自動排程啟用

使用者於 2026-09-18 明確同意啟用。

- 時區：Asia/Taipei。
- `line-replenishment-todos-noon`：週一至週五 12:00，ENABLED；首次預定 2026-09-21 12:00。
- `line-replenishment-todos-evening`：週一至週五 19:30，ENABLED；首次預定 2026-09-18 19:30。
- 兩者 POST 至既有 Cloud Run 對應 `/jobs/daily-todos/noon|evening`，沿用既有排程密鑰；未手動觸發推播。
- 正式 revision：`line-replenishment-00042-gwh`，commit `ac9b8eaf4578a3fb37c593ff20f30a3ce1259d9e`；100% 流量，ready 回傳版本相符。
- 部署自動流量切換等待過久；確認新版 startup probe 成功後，明確更新 traffic 至新 revision 完成切換。
- 發布版本 257 項測試、82 檔語法檢查及 build 通過。
- 排程推播改用深色負責人分組 carousel，容量超限才分批；每批持久化快照與重試識別碼，保留防重送。
- 已完成單次工作隔天隱藏，已完成固定工作於下一平日產生新紀錄；未完成舊工作持續列出。週末不產生新的固定工作、不推播。
- 既有商品同步、核准匯入、補貨提醒三個排程保持原設定。

驗證範圍：已核對 Scheduler 啟用狀態及下一次時間、正式服務健康檢查；首次自然推播尚未發生，未宣稱已驗收實際送達。
