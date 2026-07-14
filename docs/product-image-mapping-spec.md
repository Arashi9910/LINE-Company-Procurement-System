# 規格：飛鼠商品圖片對照資料

## 目標

從已登入的飛鼠「庫存管理 > 貨品列表」唯讀擷取 912 筆貨品資料，在既有補貨追蹤 Google Sheet 新增獨立的 `商品圖片對照` 分頁，供後續 LIFF 卡片式商品表單使用。

本次不修改飛鼠後台、不改寫 `SKU主檔`，也不在這一階段改動正式 LIFF 程式。

使用者已於 2026-07-14 確認以下顯示規則：

1. 商品卡片優先使用商品首圖。
2. 規格選項優先使用該規格圖片。
3. 缺少商品首圖時，以第一張可用規格圖替補。
4. 主圖與規格圖都不存在時，使用系統預設圖。

## 資料欄位

`商品圖片對照` 分頁使用下列欄位：

| 欄 | 欄位 | 說明 |
| --- | --- | --- |
| A | 飛鼠貨品ID | `/admin/part/edit/{id}` 的內部 ID |
| B | 貨品編號 | 飛鼠貨品列表的貨品編號 |
| C | 銷售商品ID | `/admin/product/edit/{id}` 的內部 ID，未綁定時留空 |
| D | 銷售商品編號 | 飛鼠列表顯示的 SPU／銷售商品編號 |
| E | 商品名稱 | 不含規格文字的商品名稱 |
| F | 規格 | 列表顯示的規格文字 |
| G | 商品首圖網址 | 有銷售商品編號時組成 `https://img.fslol.com/pic/ss-select/{銷售商品編號}/cover.jpg` |
| H | 規格圖片網址 | 飛鼠貨品列表實際顯示的圖片；若僅為首圖或預設圖則留空 |
| I | 列表圖片網址 | 保留飛鼠列表實際圖片來源，供稽核與替補 |
| J | 圖片採用類型 | `規格圖`、`商品首圖` 或 `預設圖` |
| K | 圖片狀態 | `正常`、`待補主圖`、`待補圖片` |
| L | 綁定狀態 | `已綁定銷售商品` 或 `未綁定銷售商品` |
| M | SKU主檔配對 | `已配對`、`重複SKU` 或 `未配對` |
| N | 資料來源 | 固定為 `飛鼠貨品列表` |
| O | 擷取時間 | Asia/Taipei 時區的擷取時間 |

## 技術環境

- 飛鼠資料來源：已登入的 `https://ss-select.fslol.com/admin/part/list/*`
- 目的地：既有 Google Sheet `補貨追蹤系統（MVP）`
- 瀏覽器擷取：Codex 內建瀏覽器，僅讀取 DOM，不提交表單
- Sheet 寫入：Google Sheets API `batchUpdate`
- 專案：Node.js 22+、Express、Google APIs

## 指令

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
git status --short
```

## 專案結構

```text
docs/
  product-image-mapping-spec.md   本規格
  product-image-mapping-plan.md   執行計畫
public/                           後續卡片式 LIFF 介面，這一階段不修改
src/sheets/                       後續讀取圖片對照資料，這一階段不修改
```

## 資料轉換風格

保持來源資料可追溯，不因 SKU 重複或未綁定銷售商品而刪除來源列。

```js
const mappingRow = {
  partId,
  sku,
  productId: productId || '',
  productCode: productCode || '',
  mainImageUrl: productCode ? buildCoverUrl(productCode) : '',
  variantImageUrl: isVariantImage(listImageUrl) ? listImageUrl : '',
  imageStatus: deriveImageStatus({ productCode, listImageUrl }),
};
```

## 驗證策略

1. 使用 `pageSize=1000` 單頁讀取，驗證合計為 912 筆且飛鼠貨品 ID 不重複；避免相同更新時間的資料在分頁邊界重複或遺漏。
2. 以飛鼠貨品 ID 保留來源列；另行標示重複 SKU，不直接去重。
3. 讀取 `SKU主檔` 的 SKU 欄後進行精確配對，回報未配對與重複結果。
4. Sheet 寫入後回讀表頭、首筆、末筆及總列數。
5. 回讀圖片狀態欄，確認預設圖與未綁定商品皆被標示。

## 邊界

- 一定執行：唯讀飛鼠、保留來源列、批次寫入獨立分頁、寫後回讀驗證。
- 需要另行確認：改寫 `SKU主檔`、下載或搬移圖片、部署 LIFF 卡片介面、自動排程登入飛鼠。
- 絕不執行：提交飛鼠表單、刪除貨品、繞過驗證、保存帳號密碼或登入憑證、把機密寫入 Git 或 Sheet。

## 成功標準

- `商品圖片對照` 分頁存在且表頭為上述 15 欄。
- 分頁包含 912 筆來源資料加 1 列表頭。
- 每列保留飛鼠貨品 ID 與貨品編號。
- 685 筆規格圖、223 筆商品首圖及 4 筆預設圖的單頁盤點可被資料分類重現；若重新擷取結果不同，必須回報差異。
- 16 筆未綁定銷售商品不被靜默刪除；本次來源 912 個 SKU 均不重複。
- 寫入後回讀驗證通過，飛鼠後台與 `SKU主檔` 未被修改。

## 未決問題

無。卡片式 LIFF 程式與自動同步排程屬下一階段，需在本次資料底稿驗證後再進行。
