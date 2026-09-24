# data.html 技術文件

本文件說明 `data.html` 的內部設計：資料模型、儲存機制、合併引擎、`report.html` CSV 契約，以及測試方式。

- 檔案本體：`data.html`（單一檔案，CSS/JS 全內嵌，IIFE 包覆）
- 行數：約 1172 行；主 script 約 900 行
- 依賴：無（零外部函式庫、零網路）

---

## 1. 整體架構

```
data.html
├── <style>           佈景主題（CSS 變數，深/淺色）
├── <body>            UI 骨架（工具列 + 表格 + 6 個 modal + toast）
└── <script>          "use strict" 單一 IIFE
    ├── 常數與狀態       LS_PREFIX / META / SCHEMA / RECORDS / OWNER / TEMPLATE
    ├── 小工具          $ / el / uid / nowISO / strip / norm / fmtVal / dateStrOf
    ├── 資料層          分塊 localStorage（save/load/clear）
    ├── 紀錄操作        makeRec / addRecords / upsertRecord / delRecords / filtered
    ├── 渲染            renderAll / renderTable / renderPager
    ├── 對話框          openModal / modalYes / toast / showBanner
    ├── 欄位管理 / 範本
    ├── 紀錄編輯
    ├── 匯出            JSON / CSV / report.html CSV
    ├── 合併            parseImportJSON / dupDetection / doMerge
    ├── 匯入            JSON 覆蓋 / CSV 匯入
    ├── 初始化          init / boot
    └── 測試鉤子        window.__DT_TEST__（僅在旗標開啟時暴露）
```

設計原則：**無框架、無建置步驟、純 DOM 操作**。所有狀態存在模組區域變數，透過 `stateObj()` 匯出快照。

---

## 2. 資料模型

### 2.1 全域狀態

```js
var META    = { tool:"data.html", ver:1, exportedAt:null, sheet:"未命名資料表" };
var SCHEMA  = [];   // 欄位定義
var RECORDS = [];   // 資料紀錄
var OWNER   = "";   // 「我的名稱」
var FILTER  = { q:"", owner:"" };
var PAGE = 0, PAGE_SIZE = 100, SEL = {};
```

### 2.2 Schema 欄位定義

```js
{ key:"公司名稱", label:"公司名稱", type:"text", options:[], examples:[], hint:"", placeholder:"", default:"", required:false }
```

- `key` — 內部鍵值，同時是匯出 CSV 的欄名；不可含 `=` `;` `,`。
- `label` — 顯示名稱。
- `type` — `text | combobox | select | number | date | textarea | serial`。
- `options` — `select` 的固定選項。
- `examples` — 範例字串陣列；表單顯示為可點選的範例 Chip（文字／多行欄位另併入輸入建議）。
- `placeholder` — 空白欄位的**灰色範例提示**（只顯示、不預填值）。內建範本以 `FIELD_PLACEHOLDER` 對照表提供。
- `hint` — 欄位下方的提示文字（如格式說明）。
- 修改既有欄位 key 時，會將所有紀錄的舊 key 值搬移到新 key（函式 `feSave`）。

### 2.3 Record 記錄

```js
{ _id, _owner, _createdAt, _updatedAt, <各欄位 key>: string }
```

- 系統欄位 `SYSTEM_KEYS = ["_id","_owner","_createdAt","_updatedAt"]`（常數區）。
- `_id` 由 `uid()` 產生：`"id" + Date.now().toString(36) + Math.random().toString(36).slice(2,9)`。
- 所有欄位值以字串儲存（`makeRec` 對值做 `String(v)`）。
- `_createdAt` / `_updatedAt` 格式 `YYYY-MM-DD HH:mm`（`nowISO()`）。

### 2.4 快照

```js
function stateObj(){ return { meta:META, schema:SCHEMA, records:RECORDS, owner:OWNER }; }
```

---

## 3. 儲存機制

### 3.1 分塊 localStorage（`saveToStorage` / `loadFromStorage` / `clearChunks`）

前綴 `LS_PREFIX = "datahtml.v1."`。三種鍵：

| 鍵 | 用途 |
|---|---|
| `datahtml.v1.` | 小資料（單塊，≤ 180000 字元） |
| `datahtml.v1.n` | 分塊數量 |
| `datahtml.v1.<i>` | 第 i 塊內容 |
| `datahtml.v1.owner` | 我的名稱（獨立保存） |
| `datahtml.v1.theme` | 主題偏好 |

- `saveToStorage()`：序列化 `stateObj()`，先 `clearChunks()` 再依大小寫入。
- 分塊大小 `CH = 180000` 字元。
- 寫入失敗（配額）會顯示 danger banner，提示改用「存檔（含資料）」。
- `loadFromStorage()`：若 `n` 存在則依序取回所有塊後 `join("")`；任一塊缺漏即回傳 `false`。
- **注意**：`localStorage` 綁定瀏覽器與裝置（`file://` 為同源）。

### 3.2 自動存檔

```js
function scheduleSave(){ dirty=true; clearTimeout(saveTimer); saveTimer=setTimeout(saveToStorage, 350); }
```

任何異動呼叫 `scheduleSave()`，350 ms 去抖後寫入。

### 3.3 「存檔（含資料）」副本（`buildSelfCopyHTML()`）

流程：

1. `saveToStorage()` 先落地。
2. `clone = document.documentElement.cloneNode(true)`（以完整 DOM 為底）。
3. 移除所有 `[data-runtime]` 節點（執行期才插入的工具列控制項：搜尋框、建立者下拉），避免副本開啟後**重複插入**。
4. 清空動態容器（`#thead`/`#tbody`/`#pager`/`#fieldList`/`#recForm`/`#mergeBody`/`#mapTable`/`#mapExtra`/`#stats`/`#banner`/`#toast`）並關閉所有開啟中的 modal。
5. 將 `JSON.stringify(stateObj())` 寫入固定的 `#datahtml-data`（`<div hidden>`）之 `textContent`：序列化時瀏覽器會自動跳脫 `<` `>` `&`，因此資料含 `</script>`、`</div>`、U+2028 等皆安全。
6. 輸出 `"<!DOCTYPE html>\n" + clone.outerHTML` 並下載。

> **為何不直接序列化線上 DOM？** 線上 DOM 已含執行期插入的節點（建立者下拉、搜尋框），直接 `outerHTML` 會把它們寫進副本；副本開啟時程式又插入一次 → 控制項重複（曾發生「欄位管理左邊多出下拉選單」）。先 clone 並清除動態節點再序列化即可避免。
>
> 資料改存於 `#datahtml-data` 元素（而非 `//%%DATA%%` 標記替換）：一是避免上述重複，二是讓**副本再次存檔**時只需覆寫同一個元素的內容（舊標記法在副本內已無標記，再次存檔會寫到錯誤位置而失效）。

### 3.4 載入優先序（init）

1. 讀取 theme / owner 偏好。
2. 讀 `#datahtml-data` 的 `textContent` 並 `JSON.parse`（含資料副本）；若無則退回舊版 `window.EMBEDDED_DATA`。
3. `loadFromStorage()`（本機記憶）。
4. **若 emb 有 records → 以 emb 為準**，`backfillSerial()`、渲染、並 `scheduleSave()` 寫回本機。
5. 否則若本機記憶存在 → `backfillSerial()` 還原並顯示 banner。
6. 否則空表。

---

## 4. 欄位與範本

### 4.1 欄位型別

| type | UI 元件 |
|---|---|
| `text` | `<input type=text>` |
| `combobox` | `<input list=datalist>`（範例 + 收集既有值） |
| `select` | `<select>`（固定 options） |
| `number` | `<input type=number>` |
| `date` | `<input type=date>`，儲存為 `YYYY-MM-DD` |
| `textarea` | `<textarea>`（附範例 Chip 與提示） |
| `serial` | 唯讀文字框；新增時自動填入流水號 |

### 4.2 內建範本（`TEMPLATE` / `schemaFromTemplate`）

`TEMPLATE` 為 `customer.xlsx`（sheet `2026總表`）的 25 欄，**只建欄位、不含內容**。欄位型別與範例（範例取自目前 Excel 內容）：

```
序號(serial 自動流水號), 客代(text), 統編(combobox), 公司名稱(text), 收件地址(text),
聯絡窗口(text), 聯絡電話(text), 聯絡信箱(text), 開發者(combobox),
課別(select: 中課/北一課/北二課/北三課/南一課/南二課), 收貨站所(combobox),
日均量體(text), 預估營收/月(number), 商品類別(text),
填單日期~導入(date),
結案(textarea, 8 個 Excel 範例), 說明(textarea, 8 個 Excel 範例),
洽談內容(textarea, 5 個範例 + 提示「格式：3/13 說明，可用分號或換行分隔多筆」),
類別(select: 1P(SCM)/3P(MO+)/零擔), 甲指成功轉甲配(select: 是/否)
```

- `統編` 用 combobox、`日均量體` 用 text，以保留前導零與範圍文字（如 `5~10件/天`）。

- `結案` 範例：`導入完成\n結案`、`客戶婉拒\n故先結案`、`客戶需求無法滿足\n故暫緩開發，\n結案` … 等 8 則。
- `說明` 範例：`平日8:30之後、13~17:30之間`、`希望先以mail聯繫，已mail牌價。` … 等。
- `洽談內容` 範例採 `3/13 說明` 格式（與 `report.html` 的時間線解析一致）。

套用範本會**取代**現有 SCHEMA（既有紀錄欄位資料仍留在 JSON 中，只是不再顯示）。

### 4.3 自動流水號（serial）

- `serialKey()` 找出型別為 `serial` 的欄位（通常為「序號」）。
- `nextSerial()` 取現有紀錄該欄位的最大整數 + 1。
- 新增紀錄時 `makeRec()` 自動填入；表單開啟時以唯讀欄位預覽下一個號碼，儲存時重新配發（避免開啟期間的競態）。
- 編輯既有紀錄時保留原序號。
- `backfillSerial()` 會在載入本機資料／含資料副本、以及套用範本時，為缺少序號的既有紀錄依序補號。

> 注意：各站所各自建檔時序號皆從 1 起算，**合併後可能出現重複序號**（合併以 `_id` 為準，序號僅為顯示標籤）。`report.html` 匯出時序號使用紀錄中儲存值。

---

## 5. 紀錄 CRUD 與渲染

- 新增／編輯：`openRecord` / `openNewRecord` / `renderRecForm` / `recSave`。
- 必填檢查：送出時檢查 `required` 欄位。
- 刪除：勾選後 `delRecords(ids)`。
- 渲染：`renderTable` 依 `PAGE_SIZE`（50/100/200/500 可切）分頁；`renderPager` 產生分頁列。
- 搜尋：`filtered()` 對所有 schema 欄位與 `_owner` 做不分大小寫子字串比對。

---

## 6. 匯出

### 6.1 JSON（`exportJSON`）

`stateObj()` 加上 `exportedAt` / `owner` / `tool` / `ver` 後下載。這是**合併與備份的標準格式**。

### 6.2 Excel 相容 CSV（`buildCSV` / `exportCSV`）

- 表頭：`_id,_owner,_createdAt,_updatedAt` + 所有 schema key。
- 使用 `csvEscape`（RFC4180 引號跳脫），前置 BOM、CRLF 換行。
- 給 Excel 開啟用，**不保證**能被 `report.html` 解析（引號欄位）。

### 6.3 report.html 專用 CSV（`buildReportCSV` / `sanitizeReport`）

見第 8 節。

---

## 7. 合併引擎

核心函式：`parseImportJSON` / `cloneRecord` / `recDiff` / `dupDetection` / `computeFileCounts` / `doMerge`。

### 7.1 解析

```js
parseImportJSON(text, fileName)
```

驗證：合法 JSON、含 `records` 陣列、含 `schema` 陣列；回傳 `{schema, records, meta, owner}`。

### 7.2 輔助函式

| 函式 | 說明 |
|---|---|
| `cloneRecord(r)` | 淺拷貝、剔除 `_raw`、補齊 `_id` / `_createdAt` / `_updatedAt` |
| `recDiff(a,b)` | 比較兩紀錄是否有任何欄位差異 |
| `dupDetection(rec, targetById, dedupKeys)` | 在現有 RECORDS 中找判重欄位全部相符、且 `_id` 不同的紀錄；空值不算重複 |

### 7.3 對話框計數

- `computeFileCounts(incoming)` — 以 `_id` 為鍵，統計每個檔案的 新增 / 更新 / 相同。
- `refreshDupCells()` — 依勾選的判重欄位，即時重算每個檔案的「疑似重複」數。

### 7.4 `doMerge(filings, ddk, ruleUpd, ruleDup, verbose)`

對每個匯入紀錄（先 `cloneRecord`）：

1. **同 `_id` 已存在**：呼叫 `recDiff`
   - 無差異 → `sameSkipped`
   - `ruleUpd === "mine"` → `sameSkipped`
   - `ruleUpd === "both"` → 複製為新 `_id` 後 push（`added`）
   - 否則（theirs）→ 以匯入檔覆寫欄位（**跳過 `_raw` / `_id` / `_createdAt`**）、更新 `_updatedAt`、`_owner`
2. **`_id` 不存在**：`dupDetection` 找疑似重複
   - 無 → push（`added`）
   - `ruleDup === "both"` → 新 `_id` push（`added`）
   - `ruleDup === "mine"` → `sameSkipped`
   - `theirs` 或（`newer` 且匯入較新）→ 以匯入檔內容覆寫 `dup`（**保留我方 `_id` / `_createdAt`**）
   - 更新 `dup._updatedAt`
3. 回傳 `{added, updated, sameSkipped, merged, report, summary, verbose}`。

**關鍵設計**：覆寫迴圈一律跳過 `_id` 與 `_createdAt`：

```js
Object.keys(rec).forEach(function(k){
  if(k==="_raw"||k==="_id"||k==="_createdAt") return;
  if(rec[k]===undefined) return;
  t[k] = String(rec[k]);
});
```

這確保「更新」是更新而非「換一筆」，且避免同一業務再次匯出被誤判為新紀錄。

---

## 8. report.html CSV 契約

`crm/report.html` 的解析器特性：

- 僅接受 `.xlsx` / `.csv`。
- CSV **以純逗號分欄，不處理引號欄位**（`parseCsv`）。
- 依表頭**精確名稱**取值；`DATE_COLS = {填單日期, 初步接洽, 需求確認, 報價, 簽約, 導入}` 會被轉成日期。
- `isTemplateRow` 會丟棄僅有「序號」的列。
- `洽談內容` 時間線以換行／全形分號分段；`收貨站所` 以換行／斜線分段。

因此 `buildReportCSV(mapping)`：

- 固定表頭 `REPORT_HEADERS`（25 欄）。
- `mapping[header]` 對應到本工具欄位 key；未對應則輸出空白。
- `序號` 若未對應則自動填入序號（1-based）。
- 日期欄用 `dateStrOf` 正規化為 `YYYY-MM-DD`。
- 每格經 `sanitizeReport(v, header)`：

```js
if(header==="收貨站所") s=s.replace(/\r\n|\r|\n/g,"/");
else                     s=s.replace(/\r\n|\r|\n/g,"；");
s=s.replace(/,/g,"，").replace(/"/g,"”");
return s.replace(/\s+/g," ").trim();
```

輸出：`\uFEFF` BOM + CRLF、純逗號分欄。

> 呼叫 `buildReportCSV()` 不帶參數時，`mapping` 預設為 `{}`（避免讀取 `mapping["序號"]` 崩潰）。

---

## 9. 匯入

### 9.1 JSON 覆蓋（`startRestore`）

`startRestore()`：讀檔 → `parseImportJSON` → 二次確認 → 以匯入檔覆蓋 `SCHEMA` / `RECORDS` / `META` / `OWNER`。

### 9.2 CSV 匯入（`startCsvImport` / `parseCSVText` / `openCsvMapModal`）

`parseCSVText(text)`：完整支援引號與 `""` 跳脫的 CSV 解析。

`openCsvMapModal()`：逐欄讓使用者對應到本工具欄位（自動以 label/key 猜測），可勾「跳過整列皆空」。匯入為**新增**紀錄。

---

## 10. 測試

### 10.1 測試鉤子

僅當外部先設 `window.__DT_TEST__ = true`（於主 script 之前注入）時，才在 IIFE 尾端覆寫為測試 API：

`state, saveState, loadState, clearStorage, applyTemplate, setOwner, getOwner, makeRec, addRec, pushRec, getRecords, setRecords, reportCSV, parseJSON, sanitize, csvParse, csvEscape, clone, diff, dedup, doMerge, render, dateStamp`

> 生產環境不設旗標時，此區塊不執行，零成本。

### 10.2 單元／整合測試（headless Chromium）

測試產生器 `gen_test.py`（在 `/tmp/opencode`，非版控）：

1. 讀 `data.html`，在主 script 前插入 `<script>window.__DT_TEST__ = true;</script>`。
2. 在 `</body>` 前插入測試腳本與 `<div id="testresult">`。
3. 以 headless Chromium `--dump-dom` 執行，解析 `<div class="t">` 結果。

涵蓋：範本欄位、CSV 引號解析／跳脫、`_owner` 標記、JSON roundtrip、report CSV（表頭／日期／淨化／站所斜線）、2500 筆分塊儲存還原、合併（新增／疑似重複併單並保留 `_id`／同 `_id` 更新／相同略過／`both` 規則）、**存檔含資料副本**（`selfCopy()` 產出的殼層不含 `[data-runtime]` 節點、無重複控制項，且 `#datahtml-data` 內嵌資料可還原）、**欄位型別與範例**（`serial` 自動流水號／`統編` combobox／`日均量體` text／`預估營收` number／`甲指成功轉甲配` 是/否／`結案`・`說明`・`洽談內容` 範例／序號自動配發與補號），以及**真實 UI 點擊測試**（新增紀錄表單完整渲染、儲存、點列編輯）。

目前：**49 / 49 PASS**（純函式 + 11 範本功能 + 8 UI + 5 存檔副本）。

> **重要**：純函式測試（走 `__DT_TEST__` 鉤子）不會觸發 UI 事件處理器，因此 2026-09 曾遺漏一個只在真實表單渲染時才會發生的錯誤（見第 11 節）。凡涉及 DOM 屬性的邏輯，務必以真實點擊補測。

### 10.3 report.html 端到端驗證（Node）

因 `report.html` 內嵌約 200 KB 單一 script，headless `--dump-dom` 對其執行時序不穩，故改以 Node + DOM stub 執行 `report.html` 的主 script，取用其**真實函式**驗證契約：

- 以本工具產生 40 筆範例 → `reportCSV(identity mapping)` → 41 行 CSV。
- 餵給 `report.html` 的 `parseCsv → computeStats / computeMilestones`。
- 驗證：40 列、25 表頭、`填單日期` 皆為 `2026-*`、里程碑計數 `[40,13,8,5,3,3]`、6 個課別群組、時間線／站所淨化正確。

目前：**11 / 11 PASS**。

---

## 11. 已知限制與注意事項

- **localStorage 容量**：總量有限（各瀏覽器不同）；資料量大請用「存檔（含資料）」。
- **單一資料表**：一個檔案一份 schema，不支援多表。
- **無網路／無後端**：合併靠人工傳檔（JSON）。
- **report.html 相容性**取決於淨化規則；若有新欄位含逗號／引號／換行，匯出時會自動處理。
- 手機瀏覽器的檔案下載行為可能依作業系統而異。

### 開發踩雷記錄

- **`input.list` 是唯讀屬性**：combobox 欄位原本寫 `inp.list = dl.id`，在 `"use strict"` 下會拋 `TypeError: Cannot set property list … which has only a getter`，導致新增／編輯紀錄的表單在渲染到第一個 combobox（如「開發者」）時中斷、modal 打不開 → **無法新增資料**。修正：改用 `inp.setAttribute("list", dl.id)`（函式 `inputFor`）。同理，`input.list` / `form.elements` / `element.children` 等唯讀 DOM 屬性不可用 `=` 賦值。
- **建立者下拉選項誤把 option 元素當值**：`renderOwnerFilter` 迴圈變數 `o`（`<option>` 元素）被當成 owner 值使用（`o.value=o; o.textContent=o`），導致選項顯示 `[object HTMLOptionElement]`。修正：改用 `ov=owns[i]`（函式 `renderOwnerFilter`）。其餘選項建立處（pgsel／欄位選項／datalist／CSV 與 report 對應）皆正確使用值變數。
- **存檔副本務必序列化「清除執行期節點後」的 clone**：`document.documentElement.outerHTML` 會把執行期插入的建立者下拉、搜尋框寫進副本，副本開啟時程式再插入一次 → 控制項重複（欄位管理左邊多出下拉選單）。修正：`buildSelfCopyHTML()` 先 `cloneNode(true)`、移除 `[data-runtime]`、清空動態容器再序列化。
- **資料以 `#datahtml-data`（div）承載，不要用 `//%%DATA%%` 標記替換**：標記法在副本內已無標記，再次存檔會替換到錯誤位置而寫入舊資料；div 法每次覆寫同一元素，且序列化自動跳脫 HTML 字元，安全。
- 以正規表達式把 `</script>` 寫成 `<\/script>` 時，**HTML tokenizer 不認得**（反斜線使其不是結束標籤）；在產生獨立 HTML 檔時必須用真正的 `</script>`，否則整段 script 會被吞掉並在稍後報 `Unexpected token '<'`。
- `EMBEDDED_DATA` 必須延遲到 `init()` 讀取。
- 合併覆寫務必跳過 `_id` / `_createdAt`，否則會造成連鎖的「更新變新增」錯誤。

---

## 12. 版本與鍵名

- 儲存前綴 `datahtml.v1.`（結構若不相容需升版至 `v2`）。
- JSON `meta.ver = 1`。
- `report.html` 契約以 `REPORT_HEADERS`（25 欄精確名稱）為準，若 `report.html` 表頭變更需同步更新 `TEMPLATE` 與 `REPORT_HEADERS`。
