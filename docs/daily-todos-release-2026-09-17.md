# 每日待辦手動版正式上線

2026-09-17 使用者已同意部署可手動使用版本，暫不開啟待辦自動排程。

## 正式版本

- Cloud Run revision：`line-replenishment-00035-n4h`
- 部署 commit：`7f346ab7e643a603864e7f9b5c05a979e931e42f`
- 發布分支：`codex/daily-todos-release`
- 發布目錄：`work/daily-todos-release`
- 基準為原正式 commit `5d7653a8e01c7590cfcfa21696998708f03c9532`，只套用待辦兩筆提交與部署上傳白名單，未部署原開發分支上的其他變更。
- `DAILY_TODOS_ENABLED=true`，既有飛鼠回寫仍為 true。
- 新 revision 已接收 100% 流量，`/ready` 回傳 ok 且 commit 相符。

## 正式資料

在原補貨追蹤試算表新增四個分頁：每日待辦範本、每日待辦紀錄、待辦推播紀錄、待辦操作紀錄。
初始六個範本 F-initial-1 至 F-initial-6：發貨、缺貨採購、取退貨、選品、上架、活動策劃，全部待指派。
初始化使用已連接的 Google Drive／Sheets 工具；本機服務帳號 impersonation 權限不足，沒有為此新增 IAM 權限。

## 驗證

- 發布分支 241 項測試通過、79 檔語法檢查通過、build 通過。
- LINE `/v2/bot/message/validate/reply` 對六項、含完成按鈕與分頁的卡片回傳 200；沒有發送群組測試訊息。
- 四個新分頁表頭、六個範本與格式已回讀確認。
- Cloud Run readiness 確認執行時服務帳號可讀待辦資料。
- Scheduler 仍只有原有飛鼠同步、核准匯入與補貨提醒三項；沒有 noon/evening 待辦排程。
- 實際 LINE 成員新增／指派／完成由使用者在公司群組驗收，尚未宣稱端到端人工驗收完成。

## 下一步

在公司群組輸入「固定待辦」「今日待辦」「待辦指令」。管理員可新增單次測試工作、指派本人，然後確認完成。
使用者確認手動驗收完成且同意後，才啟用平日 12:00、19:30 待辦 Scheduler。
