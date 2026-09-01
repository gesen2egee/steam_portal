# 開發與建置

## 建置

在專案根目錄執行：

```powershell
python build_portal.py
```

建置會產生線上版所需的 `steam_portal/index.html`、版本化 `assets/` 與 `data/`，以及完整離線用的 `steam_portal/steam_portal.html`。

需要快速檢查資料來源時，可以限制讀取數量：

```powershell
python build_portal.py --limit 100
```

正式建置會先驗證輸出，確認遊戲數量與版本識別一致後才更新發布目錄。

## 測試

```powershell
python -m unittest tests.test_build_portal
node --check src/steam_portal/portal.js
git diff --check
```

## 程式位置

- `src/steam_portal/template.html`：頁面骨架與設定頁面。
- `src/steam_portal/portal.css`：桌面版與手機版樣式。
- `src/steam_portal/portal.js`：河道、清單、匯入、同步與網址狀態。
- `steam_portal/`：建置後的發布目錄。

## 保存格式

目前資料以 `savedRivers` 統一保存清單與搜尋河道，清單類型由 `kind` 表示。探索河道只在工作階段建立；下一次探索預取資料是獨立的本機快取，不會進入清單、JSON 備份或跨裝置同步。

版本更新時只接受目前保存格式，不保留舊格式的相容路徑。若要搬移資料，請使用目前版本匯出的 JSON。
