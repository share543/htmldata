# data.html 技術文件

本文件說明 `data.html` 的內部設計：資料模型、儲存機制、合併引擎、`report.html` CSV 契約，以及測試方式。

- 檔案本體：`data.html`（單一檔案，CSS/JS 全內嵌，IIFE 包覆）
- 行數：約 1386 行；主 script 約 1092 行（自第 292 行起）
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
    ├── 資料層          世代式分塊 localStorage（save/load/clear）
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

### 3.1 分塊 localStorage：世代指標（`saveToStorage` / `loadFromStorage` / `clearChunks`）

前綴 `LS_PREFIX = "datahtml.v1."`。鍵的配置：

| 鍵 | 用途 |
|---|---|
| `datahtml.v1.gen` | **目前世代的指標（提交點）** |
| `datahtml.v1.g<gen>.n` | 該世代的分塊數量 |
| `datahtml.v1.g<gen>.<i>` | 該世代的第 i 塊內容 |
| `datahtml.v1.owner` | 我的名稱（獨立保存） |
| `datahtml.v1.theme` | 主題偏好 |

`<gen>` 為 `Date.now().toString(36)` + 4 位隨機字元，**每次存檔都是一個新世代**。

**為何用世代指標而不是直接覆寫？** 舊寫法是先 `clearChunks()` 再寫入新資料；一旦中途失敗（例如配額爆掉），舊的完整備份已經被刪掉，且 `n` 已寫入但分塊不全，`loadFromStorage()` 因缺塊回傳 `false` —— 使用者下次開啟會判定為「沒有記憶」，資料等於**無聲消失**。

現在的順序：

```
1. 把完整內容寫成新世代： g<gen>.n、g<gen>.0 … g<gen>.k
2. 全部寫入成功後，才把 datahtml.v1.gen 指向新世代   ← 提交點
3. 清掉前一個世代；順手清掉舊格式殘骸（dropLegacy）
```

任何在第 2 步之前發生的失敗，指標都還指著舊世代，舊資料完好無損；寫不完整的新世代由 `dropGen()` 清掉，並顯示 danger banner 提示改用「存檔（含資料）」。

- 分塊大小 `CH = 180000` 字元；`n = max(1, ceil(len / CH))`。
- **已知取捨**：寫入期間新舊世代並存，需要約 **2 倍** localStorage 空間。極端情況（幾乎存滿）會寫不進去，但**不會遺失既有資料**。
- `loadFromStorage()`：優先讀 `gen` 指向的世代；任一塊缺漏即回傳 `false`。
- **向下相容**：沒有 `gen` 時改用舊格式（單塊 `datahtml.v1.`，或 `datahtml.v1.n` + `datahtml.v1.<i>`），因此升版後舊資料仍可讀取；升版後第一次存檔會由 `dropLegacy()` 清掉舊格式殘骸。
- **注意**：`localStorage` 綁定瀏覽器與裝置（`file://` 為同源）。

### 3.2 自動存檔

```js
function scheduleSave(){ dirty=true; clearTimeout(saveTimer); saveTimer=setTimeout(saveToStorage, 350); }
```

任何異動呼叫 `scheduleSave()`，350 ms 去抖後寫入。

**離開頁面前會補寫**：去抖動期間若關閉／切換分頁，這 350 ms 內的最後一筆異動會遺失，因此 `beforeunload`（桌面）與 `pagehide`（行動瀏覽器較可靠）都呼叫 `flushPendingSave()`；它只在 `dirty` 時取消計時器並直接 `saveToStorage()`。

存檔成功時呼叫 `clearErrorBanner()`（只清 danger／warn），**不是** `hideBanner()`。原因：`showBanner()` 也用於「已載入含資料副本」「已從本機記憶還原」這類資訊提示，若存檔一律 `hideBanner()`，那些提示會在約 350 ms 後被關掉，使用者幾乎看不到。

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
| `number` | `<input type=number>`；**若既有值不是數字**（例：CSV 匯入的 `5~10件/天`）則改用 `type=text`，以免該值被靜默清空 |
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
- 分頁按鈕用 `<button>`（不是 `<span>`），才能以鍵盤操作；超出範圍者設 `disabled`。
- 表頭全選（`#chkAll`）與個別列勾選由 `syncHeaderCheckbox()` 同步：全部勾選→`checked`，部分勾選→`indeterminate`。
- 執行期才建立的工具列控制項（搜尋框、建立者下拉）都帶 `data-runtime="1"`，供「存檔（含資料）」副本剷除。**建立者下拉需插在 `.menuWrap` 之外**：否則會落在`.menuWrap{position:relative}` 內，使 document 的「點外面關選單」判斷誤以為還在選單裡，選單不會關。

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
| `dupMatch(rec, t, dedupKeys)` | 判重欄位是否全部相符；任一側為空值即不算重複 |
| `dupDetection(rec, targetById, dedupKeys)` | 找疑似重複：有傳 `targetById`（以 `_id` 為鍵的集合）時以該集合比對，否則比對現有 `RECORDS` |

### 7.3 對話框計數

- `computeFileCounts(incoming)` — 以 `_id` 為鍵，統計每個檔案的 新增 / 更新 / 相同。
- `refreshDupCells()` — 依勾選的判重欄位，即時重算每個檔案的「疑似重複」數。
- `openMergeDialog()` 另比對我方 `SCHEMA` 與匯入檔 schema，把差異寫入 `#schemaDiff`（匯入檔有、我方沒有的欄位會影響畫面顯示與 `report.html` 匯出）。內容用 `textContent` 寫入 —— key 來自他人檔案。

> **預覽必須與 `doMerge` 同順序、同基準**：`doMerge` 邊處理邊把「無重複」的匯入紀錄納入基準集合，因此**同批匯入檔之間也會互相判重**（兩個業務各有一筆同統編時，第二筆會被併掉）。預覽若只跟既有 `RECORDS` 比，就會出現「預覽顯示 0、實際併 1 筆」的落差。`refreshDupCells()` 因此也逐步累積 `basis`，並跳過「同 `_id`」（＝更新，不算疑似重複）者。

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
   - `ruleDup === "newer"` 且匯入檔較舊 → `sameSkipped`（保留我方內容＝沒有變更，**不可計為併單**）
   - 其餘（`theirs`，或 `newer` 且匯入較新）→ 以匯入檔內容覆寫 `dup`（**保留我方 `_id` / `_createdAt`**），`dup._updatedAt` 跟著改成匯入檔的時間（無則 `nowISO()`）、`_owner` 也改為匯入檔的值
3. 回傳 `{added, updated, sameSkipped, merged, report, summary, verbose}`。

合併完成後可選呼叫 `renumberSerial()`：把我方所有紀錄的流水號重編為 1…N（依 `RECORDS` 順序）。由對話框的 `#mergeRenumber` 控制、**預設關閉**；各站所序號都從 1 起算，合併後本來就會重複。它刻意**不動 `_updatedAt`** —— 序號只是顯示標籤，重編不應讓每筆紀錄都看起來被編輯過。

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

> 對應清單**只提供 schema 的資料欄位**，不提供系統欄位（`_id` / `_owner` / `_createdAt` / `_updatedAt`）。這些欄位由工具維護；若開放對應，匯入的 CSV 即可覆寫識別碼（造成 `_id` 衝突）或偽造建立者。

---

## 10. 測試

### 10.1 測試鉤子

僅當外部先設 `window.__DT_TEST__ = true`（於主 script 之前注入）時，才在 IIFE 尾端覆寫為測試 API：

`state, saveState, loadState, clearStorage, applyTemplate, setOwner, getOwner, makeRec, addRec, pushRec, getRecords, setRecords, reportCSV, parseJSON, sanitize, csvParse, csvEscape, clone, diff, dedup, doMerge, render, dateStamp`

> 生產環境不設旗標時，此區塊不執行，零成本。

### 10.2 單元／整合測試（`npm test`）

測試檔在 `tests/data-html.test.js`：

```sh
npm install   # 第一次需要（jsdom）；node_modules/ 已 gitignore
npm test
```

流程：把 `data.html` 讀進來，在主 script 前注入 `<script>window.__DT_TEST__ = true;</script>`，再以 jsdom 載入。但**不依賴測試鉤子跑完全部** —— 涉及 DOM 與事件處理器的行為一律以**真實 UI 流程**驅動：實際點 `#importMenu` 的按鈕、以 `Object.defineProperty` 塞 `input.files` 後派送 `change`、勾選判重欄位、按下 `#mergeApply`。

涵蓋（T1–T18 + X1）：表頭必填標記、合併預覽與實際結果一致、寫入失敗不得毀掉舊資料、惡意 schema key 不注入、儲存格式相容與不殘留、基本功能（建立者／流水號／report CSV／淨化／CSV 解析）、疑似重複併單的欄位與計數、提示不被自動存檔關掉、CSV 對應不提供系統欄位、含資料副本可離線還原且不重複插入執行期控制項、`report.html` CSV 契約（本側）、合併後重新編號流水號、schema 差異警告、`number` 欄位非數字值不遺失、分頁可鍵盤操作、表頭全選狀態同步、離開頁面前補寫、建立者下拉不屬於選單容器、頁面內無未捕捉例外。

**現況：77 / 77 PASS。**

#### 環境限制與注意

- **共用對話框 + 非同步開檔 → 測試必須等到「內容」而非「開著」**：`startMerge()` 要 `await` 讀檔後才建對話框，而 modal 是共用元素。若只等 `#mbMerge` 有 `open` 類別，就會在下一個測試裡立刻成立、讀到**前一個測試殘留的對話框**，產生看起來合理但完全錯的結果（本套測試就曾因此連續誤導 T8/T12/T13，追了半天才定位）。因此 `openMergeViaUI()` / `openCsvViaUI()` 會先 `closeAllOpenModals()`，再等到列出的檔案名稱與數量符合這一批；而只是「檢視」不按套用的測試（T4、T9）要自己收尾。
- 測試 harness 也在 `loadPage()` 掛 `VirtualConsole` 收集 `jsdomError`（事件處理器裡拋錯會被吞掉），最後由 X1 統一斷言 —— 語法錯誤就是被它抓到。

- **`chromium-browser` 在 Termux 無法啟動**（`libtermux-exec.so` 的 namespace 錯誤），因此不使用它。2026-09 之前是 headless Chromium + `/tmp/opencode/gen_test.py`；該目錄已不存在，測試已改為本檔並納入版控。
- **jsdom 的 `localStorage` 是 Proxy**：覆寫實例上的 `setItem` 無效（會被當成寫入一個叫 `setItem` 的項目），模擬配額爆掉必須覆寫 `Storage.prototype.setItem`。
- **此掛載不支援 symlink**：npm 建立 `node_modules/.bin` 會 `EACCES`，因此 `.npmrc` 設 `bin-links=false`。測試不需要任何相依套件的 CLI。
- jsdom 沒有版面引擎，CSS／列印相關行為不在測試範圍。

> **重要**：純函式測試（走 `__DT_TEST__` 鉤子）不會觸發 UI 事件處理器，因此 2026-09 曾遺漏一個只在真實表單渲染時才會發生的錯誤（見第 11 節）。凡涉及 DOM 屬性的邏輯，務必以真實點擊補測。

### 10.3 report.html 端到端驗證（Node）

> ⚠️ 此驗證腳本**不在版控內**（原本在 `/tmp/opencode`，已不存在），目前這 11 項無法重現。

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

#### 2026-09-26（P0／P1 修正）新增

- **`textContent` 不會解析 HTML**：表頭原本寫 `th.textContent = label + "<span…>*</span>"`，畫面會直接顯示標籤原始碼。要放元素就用 `createElement` + `appendChild`。
- **用 innerHTML 拼接「來自匯入檔」的字串時，過濾清單必須涵蓋引號**：判重欄位 chips 以 `value='…'`（單引號）拼接卻只過濾 `< > & "`，key 內含單引號即可跳出屬性變成注入。這些 key 來自他人匯出的 JSON，而 `feSave` 只擋 `= ; ,`。改用 DOM API 建立。
- **合併預覽必須模擬 `doMerge` 的累積順序**，否則預覽數字會低於實際結果（見 7.3）。
- **存檔失敗不可先刪舊資料**：先寫成新世代、全部成功才切換指標（見 3.1）。
- **存檔成功不要呼叫 `hideBanner()`**：會把資訊提示一起關掉（見 3.2）。
- **`ruleDup = "newer"` 且匯入較舊時要算「略過」**，不能計為併單（見 7.4）。
- **不要憑讀碼下結論**：2026-09-26 的 review 曾誤判「疑似重複分支未更新 `_owner`／`_updatedAt`」，實際覆寫迴圈本來就會帶到這兩個欄位（只排除 `_raw`／`_id`／`_createdAt`）。寫測試驗證比讀碼可靠。

#### 2026-09-27（第二輪）新增

- **不要把 `type=number` 硬套在已有非數字值的欄位上**：瀏覽器曾把序號的空白值清空後儲存，等於靜默丟資料。改為偵測到非數字時改用 `type=text` 保住原值。
- **建立者下拉必須插在 `.menuWrap` 之外**：它在 `.menuWrap` 內時，「點外面關選單」的 `closest(".menuWrap")` 會誤判，匯入／匯出選單不會關。
- **分頁器用 `<span>` 不能聚焦**：改用 `<button>` 並以 `disabled` 表示越界。
- **表頭全選不會自己跟上**：個別列勾選後必須呼叫 `syncHeaderCheckbox()`，否則表頭永遠停在全選或未選。
- **去抖動存檔的缺口**：`beforeunload` / `pagehide` 必須補寫，否則 350 ms 內關分頁就遺失最後一筆。
- **測試用 `MutationObserver` 在 jsdom 不可靠**：本輪曾用它追蹤 modal 開啟卻一無所獲，最後靠「在函式裡暫時 `console.error(new Error().stack)`」才看到真正呼叫者。除錯 jsdom 時直接插堆疊比較快。
- **不要用字串比對來檢查屬性**：`!/data-runtime/.test(html)` 會被程式源碼裡的同名**字串**誤判；要看屬性就得真解析 DOM（且注意「載入後由程式建立」與「靜態標記」的分別）。

---

## 12. 版本與鍵名

- 儲存前綴 `datahtml.v1.`（結構若不相容需升版至 `v2`）。
- 鍵名：`datahtml.v1.gen`（世代指標）、`datahtml.v1.g<gen>.n` 與 `.g<gen>.<i>`（世代分塊）、`datahtml.v1.owner`、`datahtml.v1.theme`。舊格式（`datahtml.v1.`／`.n`／`.<i>`）僅保留讀取能力（見 3.1）。
- JSON `meta.ver = 1`。
- `report.html` 契約以 `REPORT_HEADERS`（25 欄精確名稱）為準，若 `report.html` 表頭變更需同步更新 `TEMPLATE` 與 `REPORT_HEADERS`。
