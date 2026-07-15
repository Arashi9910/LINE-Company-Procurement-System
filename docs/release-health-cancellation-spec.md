# 規格：部署追蹤、服務就緒與補貨取消

## Objective

本次修改讓正式 Cloud Run revision 可以追溯到唯一 Git commit，避免服務僅有 `/health` 正常但核心路由或 Google Sheets 不可用，並在 LINE 公司群組提供安全、可稽核的整張補貨單取消指令。

成功時：

- 每次部署都拒絕不可重現的 dirty Git 工作區，並把 commit SHA、部署時間與 Cloud Run revision 暴露於健康資訊。
- 應用缺少核心相依物件時直接啟動失敗；`/ready` 在 Google Sheets 不可讀時回傳 `503`。
- 公司群組可輸入 `取消補貨 <補貨單號>` 取消仍完全處於 `待確認` 的補貨單。

## Tech Stack

- Node.js 22、Express 5、ES Modules
- Google Sheets API
- LINE Messaging API Webhook
- Google Cloud Run、PowerShell 5.1 部署腳本
- Node.js 內建 test runner

## Commands

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
git diff --check
```

正式部署仍由使用者另外同意後執行：

```powershell
.\scripts\deploy-gcp.ps1 `
  -ProjectId '<PROJECT_ID>' `
  -LineLoginChannelId '<LINE_LOGIN_CHANNEL_ID>' `
  -LiffId '<LIFF_ID>'
```

## Project Structure

```text
src/config.js                    # 版本與 Cloud Run revision 設定
src/app.js                       # liveness、readiness、路由掛載與 fail-fast
src/sheets/repository.js         # Sheet readiness 與取消交易
src/services/group-commands.js   # 取消指令解析、權限與回覆
src/routes/webhook.js            # LINE 取消指令協調
scripts/deploy-gcp.ps1           # Git 版本擷取、標籤、環境變數與 probes
test/                            # 單元、整合及部署腳本契約測試
docs/                            # 規格、部署與操作文件
```

## Code Style

沿用具名匯出、依賴注入及薄路由；業務規則放在 service／repository 並以明確錯誤拒絕非法狀態：

```js
export async function executeCancellationCommand(input, { repository }) {
  const request = await repository.getRequestForCancellation(input.command.requestId);
  if (request.requesterUserId !== input.actorUserId) throw new AuthorizationError();
  return repository.cancelRequest({ requestId: request.requestId });
}
```

## Testing Strategy

- `test/health.test.js`：缺少相依物件會 fail-fast、liveness 保持正常、readiness 成功與失敗。
- `test/config.test.js`：版本、commit、revision 與部署時間設定。
- `test/powershell-compatibility.test.js`：部署必須讀取乾淨 Git commit、設定 Cloud Run label／env、配置 probes。
- `test/group-commands.test.js`：取消指令格式、原申請人／管理員權限與非法狀態。
- `test/webhook.test.js`：公司群組取消成功、其他群組拒絕、LINE 重送冪等。
- `test/sheets-repository.test.js`：整張狀態更新、操作紀錄、非待確認拒絕及重送不重複寫入。
- 完成後執行完整 test、lint、build 與 diff check。

## Cancellation Rules

- 指令格式：`取消補貨 <補貨單號>`；補貨單號忽略英文字母大小寫，並正規化為大寫 `RQ` 前綴與小寫 UUID 尾碼。
- 只能整張取消，不提供單一 SKU 取消。
- 所有品項都仍為 `待確認` 時才能取消；任何品項已下單、部分到貨、完成或已取消都拒絕。
- 原申請人或已啟用的管理員可取消；其他人拒絕。
- 使用 LINE `webhookEventId` 產生 operation key，同一事件重送回傳既有結果，不重複寫入。
- 更新每一列的狀態、最後操作人與時間，並在「操作紀錄」寫入一筆 `取消補貨`。
- 成功後在原群組回覆補貨單號、操作人與品項數。

## Boundaries

- Always：保留現有 Sheet 欄位；所有寫入經 repository queue；驗證 Webhook 簽章、公司群組、權限、狀態與冪等。
- Ask first：正式部署、正式 Sheet 寫入、LINE Console 設定、取消規則或權限的產品決策變更。
- Never：不修改正式資料；不部署；不實作本次已明確延後的 LIFF 公司／群組成員邊界；不混入 Claude 橋接檔案。

## Success Criteria

1. Dirty Git 工作區不能執行正式部署；乾淨工作區會把完整 commit SHA、短版版本與 UTC 部署時間送進 Cloud Run，並更新 `git-commit` label。
2. `/health` 回傳 liveness 與版本資訊；`/ready` 實際讀取指定 Sheet，失敗時回傳 `503` 且不洩漏底層錯誤。
3. Cloud Run 使用 `/ready` startup/readiness probe 與 `/health` liveness probe，避免首次 readiness 前接收流量。
4. 缺少 repository、identity verifier 或 messenger 時，`createApp` 直接拋錯，不再靜默略過核心路由。
5. 符合取消規則的 LINE 指令會原子更新整張補貨單並留下操作紀錄；非法權限、狀態、格式或重送皆有測試。
6. 全部自動測試、lint、build 與 diff check 通過。

## Open Questions

無。使用者於 2026-07-15 同意採「原申請人或已啟用管理員」。
