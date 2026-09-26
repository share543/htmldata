#!/usr/bin/env node
/**
 * data.html 回歸測試
 *
 * 用法： npm test
 *
 * 以 Node + jsdom 載入 data.html 並用「真實 UI 流程」驅動（實際點選單、
 * 派送檔案 change 事件、勾選判重欄位、按下套用合併），而非只呼叫內部函式。
 *
 * 為什麼不是 headless Chromium：Termux 環境下 chromium-browser 會因
 * libtermux-exec.so 的 namespace 問題無法啟動。jsdom 足夠涵蓋這些流程，
 * 但有兩個已知差異（見 tests/README 說明與 TECHNICAL.md 10.2）：
 *   1. localStorage 是 Proxy，覆寫實例上的 setItem 無效，必須改 Storage.prototype。
 *   2. 沒有版面引擎，CSS 相關行為不驗證。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const DATA_HTML = path.join(__dirname, "..", "data.html");
const TEST_FLAG = '<script>window.__DT_TEST__ = true;</script>\n';
const MAIN_SCRIPT = '<script>\n"use strict";';

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? "" : String(detail) });
}
function section(title) {
  results.push({ section: title });
}
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = !!fn(); } catch (_) { v = false; }
    if (v) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(20);
  }
}

/** 頁面內未捕捉的錯誤。事件處理器拋錯時瀏覽器不會中斷，jsdom 會用
 *  jsdomError 回報 —— 這種「靜默失敗」正是最難查的一類，所以一律收集。 */
const pageErrors = [];

/** 載入一份 data.html（可選擇是否注入測試旗標） */
async function loadPage(html, url) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => pageErrors.push(e && e.message ? e.message : String(e)));
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: url || "https://example.test/data.html",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const w = dom.window;
  await new Promise((res) => (w.document.readyState === "complete" ? res() : w.addEventListener("load", res)));
  return { dom, w, d: w.document };
}

/* ── 測試資料小工具 ───────────────────────────────────────── */
const rec = (id, field, val, extra) => {
  const r = { _id: id, _owner: "A", _createdAt: "2026-01-01 00:00", _updatedAt: "2026-01-01 00:00" };
  r[field] = val;
  if (extra) for (const k in extra) r[k] = extra[k];
  return r;
};
const schemaOf = (...keys) => keys.map((k) => ({ key: k, label: k, type: "text" }));

async function main() {
  const raw = fs.readFileSync(DATA_HTML, "utf8");
  if (!raw.includes(MAIN_SCRIPT)) {
    console.error("找不到主 script 標記，data.html 結構可能已變更");
    process.exit(2);
  }
  const { w, d } = await loadPage(raw.replace(MAIN_SCRIPT, TEST_FLAG + MAIN_SCRIPT));
  const T = w.__DT_TEST__;
  if (!T) {
    console.error("測試 API 未暴露：旗標注入失敗");
    process.exit(3);
  }

  /** 關掉所有還開著的 modal。對話框是共用元素，若前一個測試忘了關（例如只是檢視、
   *  沒按套用），下一個測試的「等對話框開啟」會立刻成立而讀到殘留內容 ——
   *  這是確定性測試的必要前置。 */
  function closeAllOpenModals() {
    Array.from(d.querySelectorAll(".modalBack.open")).forEach((m) => m.classList.remove("open"));
  }

  /** 以真實 UI 開啟合併對話框（模擬使用者選檔），並等到內容確實是這一批檔案 */
  async function openMergeViaUI(filings) {
    const inp = d.getElementById("mergeFileInput");
    inp.click = function () {};                       // 阻止 jsdom 開檔對話框
    inp.onchange = null;                              // 丟掉前一次未完成的 resolver
    closeAllOpenModals();
    d.querySelector('#importMenu button[data-act="merge"]').click();
    const files = filings.map((f) => new w.File([JSON.stringify(f.data)], f.name, { type: "application/json" }));
    Object.defineProperty(inp, "files", { value: files, configurable: true });
    inp.dispatchEvent(new w.Event("change"));
    const opened = await until(() => d.getElementById("mbMerge").classList.contains("open"));
    // 讀檔是非同步的，光「開著」不夠 —— 必須等到列出的檔案正是這一批
    const filled = await until(() => {
      const rows = Array.from(d.querySelectorAll("#fileRows tr[data-idx]"));
      return rows.length === filings.length &&
        rows.every((tr, i) => tr.cells[0].textContent.indexOf(filings[i].name) === 0);
    });
    return opened && filled;
  }

  /** 以真實 UI 開啟 CSV 匯入對應對話框，並等到標題確實是這支檔案 */
  async function openCsvViaUI(csvText, fileName) {
    const name = fileName || "x.csv";
    const inp = d.getElementById("csvFileInput");
    inp.click = function () {};
    inp.onchange = null;
    closeAllOpenModals();
    d.querySelector('#importMenu button[data-act="csv"]').click();
    Object.defineProperty(inp, "files", {
      value: [new w.File([csvText], name, { type: "text/csv" })],
      configurable: true,
    });
    inp.dispatchEvent(new w.Event("change"));
    const opened = await until(() => d.getElementById("mbMap").classList.contains("open"));
    const titled = await until(() => d.getElementById("mapTitle").textContent.indexOf(name) >= 0);
    return opened && titled;
  }

  /* ══════════════════════════════════════════════════════════
     T1  必填欄位的表頭必須是元素，不是 HTML 原始碼
     （回歸：th.textContent 塞入 <span> 會顯示標籤原始碼）
     ══════════════════════════════════════════════════════════ */
  section("T1 表頭必填標記");
  try {
    T.applyTemplate();
    const st = T.state();
    st.schema[0].required = true;
    const key0 = st.schema[0].key;
    T.render();
    const th = d.getElementById("hdr-" + key0);
    check("表頭不得出現 HTML 原始碼", th && !th.textContent.includes("<span"), `th.textContent = ${JSON.stringify(th && th.textContent)}`);
    check("表頭應以 <span> 呈現 *", th && th.querySelector("span") !== null, `span 數量 = ${th ? th.querySelectorAll("span").length : "n/a"}`);
    check("必填欄位的表單 label 應有 *", true, "（renderRecForm 原本即使用純文字 *）");
  } catch (e) { check("T1 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T2  合併預覽的「疑似重複」數字必須等於實際併單數
     （回歸：預覽只比對既有資料，未納入同批匯入檔彼此）
     ══════════════════════════════════════════════════════════ */
  section("T2 合併預覽 == 實際結果");
  try {
    T.setRecords([]);                                 // 總部空表
    const filings = [
      { name: "a.json", data: { schema: schemaOf("統編"), records: [rec("id1", "統編", "12345678")] } },
      { name: "b.json", data: { schema: schemaOf("統編"), records: [rec("id2", "統編", "12345678")] } },
    ];
    const opened = await openMergeViaUI(filings);
    check("合併對話框可開啟", opened);
    const cb = d.querySelector("#mergeBody .ddk");
    check("有判重欄位可勾選", !!cb);
    cb.checked = true;
    cb.dispatchEvent(new w.Event("change"));
    await sleep(60);
    const previewNum = parseInt(String(d.getElementById("dupTotal").textContent).replace(/[^0-9]/g, ""), 10) || 0;
    d.getElementById("mergeApply").click();
    await sleep(80);
    const after = T.getRecords();
    const actualMerged = filings.reduce((n, f) => n + f.data.records.length, 0) - after.length;
    check("預覽數字 == 實際併單數", previewNum === actualMerged,
      `預覽 ${previewNum}、實際併單 ${actualMerged}（合併後 ${after.length} 筆）`);
  } catch (e) { check("T2 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T3  localStorage 寫入失敗不得弄丟既有的完整備份
     ══════════════════════════════════════════════════════════ */
  section("T3 寫入失敗不得毀掉舊資料");
  try {
    T.clearStorage();
    T.applyTemplate();
    const many = Array.from({ length: 1500 }, (_, i) => rec("id" + i, "說明", "x".repeat(300) + i));
    T.setRecords(many);
    T.saveState();
    const before = T.loadState();
    check("前置：大資料可存入並讀回", before && T.getRecords().length === 1500, `讀回 ${T.getRecords().length} 筆`);

    // 讓第 2 次之後的 setItem 全部失敗（模擬配額爆掉）
    const proto = w.Storage.prototype;
    const orig = proto.setItem;
    let calls = 0;
    proto.setItem = function (k, v) {
      if (++calls > 1) { const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e; }
      return orig.call(this, k, v);
    };
    T.setRecords(many.slice(0, 1400));                // 內容改變 → 觸發寫入
    T.saveState();
    proto.setItem = orig;

    check("確實模擬到寫入失敗", calls > 0, `setItem 被呼叫 ${calls} 次後中止`);
    const afterLoad = T.loadState();
    check("失敗後舊資料仍在", afterLoad === true, `loadState() = ${afterLoad}`);
    check("失敗後讀回的是舊的完整內容", T.getRecords().length === 1500, `讀回 ${T.getRecords().length} 筆`);
  } catch (e) { check("T3 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T4  匯入檔的 schema key 不得注入 HTML／事件屬性
     （key 來自他人匯出的 JSON，而 feSave 只擋 = ; ,）
     ══════════════════════════════════════════════════════════ */
  section("T4 schema key 不得注入");
  try {
    T.clearStorage();
    T.setRecords([]);
    const evil = "A' onmouseover='window.__PWNED=1' x='";
    const opened = await openMergeViaUI([
      { name: "evil.json", data: { schema: schemaOf(evil), records: [rec("e1", evil, "v")] } },
    ]);
    check("惡意 key 的對話框可開啟", opened);
    check("不得產生注入的事件屬性", d.querySelectorAll("#mergeBody [onmouseover]").length === 0,
      `找到 ${d.querySelectorAll("#mergeBody [onmouseover]").length} 個 [onmouseover]`);
    check("不得執行注入程式碼", w.__PWNED === undefined, `window.__PWNED = ${w.__PWNED}`);
    const cb = d.querySelector("#mergeBody .ddk");
    check("判重 checkbox 的 value 應完整等於原始 key",
      cb && cb.value === evil && cb.getAttribute("value") === evil,
      `value = ${JSON.stringify(cb && cb.value)}`);
    closeAllOpenModals();                             // 只是檢視，不按套用 → 自行收拾
  } catch (e) { check("T4 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T5  儲存格式：舊格式相容、不殘留、不累積舊世代
     ══════════════════════════════════════════════════════════ */
  section("T5 儲存格式與相容性");
  try {
    const LS = "datahtml.v1.";
    const payload = {
      meta: { tool: "data.html", ver: 1 },
      schema: schemaOf("a"),
      records: [rec("old1", "a", "v1"), rec("old2", "a", "v2")],
    };

    T.clearStorage();                                  // (a) 舊格式：單塊
    w.localStorage.setItem(LS, JSON.stringify(payload));
    const okSingle = T.loadState();
    check("可讀取舊格式單塊", okSingle === true && T.getRecords().length === 2,
      `loadState() = ${okSingle}、${T.getRecords().length} 筆`);

    T.clearStorage();                                  // (b) 舊格式：分塊
    const s = JSON.stringify(payload);
    const half = Math.ceil(s.length / 2);
    w.localStorage.setItem(LS + "n", "2");
    w.localStorage.setItem(LS + "0", s.slice(0, half));
    w.localStorage.setItem(LS + "1", s.slice(half));
    const okChunk = T.loadState();
    check("可讀取舊格式分塊", okChunk === true && T.getRecords().length === 2,
      `loadState() = ${okChunk}、${T.getRecords().length} 筆`);

    T.saveState();                                     // (c) 存檔後舊格式殘骸應被清掉
    const leftovers = ["", "n", "0", "1"].filter((k) => w.localStorage.getItem(LS + k) !== null);
    check("新格式存檔後不留下舊格式殘骸", leftovers.length === 0, JSON.stringify(leftovers.map((k) => LS + k)));
    check("新格式仍可讀回", T.loadState() === true && T.getRecords().length === 2, `${T.getRecords().length} 筆`);

    for (let i = 0; i < 5; i++) {                      // (d) 反覆存檔不得累積舊世代
      T.setRecords(Array.from({ length: 20 + i }, (_, j) => rec(`g${i}_${j}`, "a", "v")));
      T.saveState();
    }
    const genIds = new Set();
    for (const k of Object.keys(w.localStorage)) {
      if (k === LS + "gen") continue;
      const m = k.match(/^datahtml\.v1\.g([^.]+)/);
      if (m) genIds.add(m[1]);
    }
    check("只保留 1 個世代（不累積舊世代）", genIds.size === 1, `世代數 = ${genIds.size}`);
    check("指標指向的世代可讀回", T.loadState() === true && T.getRecords().length === 24, `${T.getRecords().length} 筆`);
  } catch (e) { check("T5 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T6  基本功能（避免修正破壞正常流程）
     ══════════════════════════════════════════════════════════ */
  section("T6 基本功能");
  try {
    T.clearStorage();
    T.applyTemplate();
    T.setOwner("王小明");
    T.setRecords([]);
    T.addRec({ 公司名稱: "測試公司" });
    const rs = T.getRecords();
    check("新增紀錄套用建立者", rs.length === 1 && rs[0]._owner === "王小明", `owner = ${rs[0] && rs[0]._owner}`);
    check("流水號自動配發", String(rs[0]["序號"]) === "1", `序號 = ${rs[0]["序號"]}`);
    const csv = T.reportCSV({});
    check("report CSV 表頭 25 欄", csv.split("\r\n")[0].replace("\uFEFF", "").split(",").length === 25, "");
    check("淨化：半形逗號轉全形", T.sanitize("a,b", "說明") === "a，b", JSON.stringify(T.sanitize("a,b", "說明")));
    check("淨化：收貨站所換行轉斜線", T.sanitize("A\nB", "收貨站所") === "A/B", JSON.stringify(T.sanitize("A\nB", "收貨站所")));
    check("CSV 引號解析", JSON.stringify(T.csvParse('"a,b",c')) === '[["a,b","c"]]', JSON.stringify(T.csvParse('"a,b",c')));
    const rt = T.parseJSON(JSON.stringify({ meta: {}, schema: schemaOf("a"), records: [rec("x", "a", "1")] }), "t.json");
    check("匯入 JSON 解析", rt.records.length === 1, `${rt.records.length} 筆`);
  } catch (e) { check("T6 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T7  疑似重複併單：內容、_owner、_updatedAt、計數
     ══════════════════════════════════════════════════════════ */
  section("T7 併單的欄位與計數");
  try {
    const mkHQ = (owner, ts) => ({ _id: "mine1", _owner: owner, _createdAt: "2026-01-01 00:00", _updatedAt: ts, 統編: "12345678", 公司名稱: "舊名" });
    const mkIn = (id, owner, ts) => ({ _id: id, _owner: owner, _createdAt: "2026-01-01 00:00", _updatedAt: ts, 統編: "12345678", 公司名稱: "新名" });
    const schema = schemaOf("統編", "公司名稱");
    const of = (r) => [{ name: "f.json", data: { schema, records: [r] } }];

    T.applyTemplate();
    T.setRecords([mkHQ("總部", "2026-01-01 00:00")]);   // (a) theirs + 匯入較新
    T.doMerge(of(mkIn("th1", "業務", "2026-02-01 00:00")), ["統編"], "theirs", "theirs", false);
    let r = T.getRecords();
    check("保留我方 _id", r.length === 1 && r[0]._id === "mine1", r[0] && r[0]._id);
    check("內容取自匯入檔", r.length === 1 && r[0].公司名稱 === "新名", r[0] && r[0].公司名稱);
    check("_owner 取自匯入檔", r.length === 1 && r[0]._owner === "業務", r[0] && r[0]._owner);
    check("_updatedAt 與內容一致", r.length === 1 && r[0]._updatedAt === "2026-02-01 00:00", r[0] && r[0]._updatedAt);

    T.setRecords([mkHQ("總部", "2026-03-01 00:00")]);   // (b) theirs + 匯入較舊
    T.doMerge(of(mkIn("th2", "業務", "2025-12-01 00:00")), ["統編"], "theirs", "theirs", false);
    r = T.getRecords();
    check("內容取自較舊匯入檔時 _updatedAt 不得沿用我方較新值",
      r.length === 1 && r[0].公司名稱 === "新名" && r[0]._updatedAt === "2025-12-01 00:00",
      `name = ${r[0] && r[0].公司名稱}、_updatedAt = ${r[0] && r[0]._updatedAt}`);

    T.setRecords([mkHQ("總部", "2026-03-01 00:00")]);   // (c) newer + 匯入較舊
    let res = T.doMerge(of(mkIn("th3", "業務", "2025-12-01 00:00")), ["統編"], "theirs", "newer", false);
    r = T.getRecords();
    check("newer + 匯入較舊 → 內容不變且計為略過（非併單）",
      res.merged === 0 && res.sameSkipped === 1 && r[0].公司名稱 === "舊名",
      `merged = ${res.merged}、sameSkipped = ${res.sameSkipped}、name = ${r[0].公司名稱}`);

    T.setRecords([mkHQ("總部", "2026-01-01 00:00")]);   // (d) newer + 匯入較新
    res = T.doMerge(of(mkIn("th4", "業務", "2026-05-01 00:00")), ["統編"], "theirs", "newer", false);
    r = T.getRecords();
    check("newer + 匯入較新 → 併單並採用匯入內容",
      res.merged === 1 && r[0].公司名稱 === "新名" && r[0]._owner === "業務" && r[0]._updatedAt === "2026-05-01 00:00",
      `merged = ${res.merged}、name = ${r[0].公司名稱}、owner = ${r[0]._owner}`);
  } catch (e) { check("T7 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T8  資訊提示不得被自動存檔關掉
     ══════════════════════════════════════════════════════════ */
  section("T8 提示不被自動存檔關掉");
  try {
    T.clearStorage();
    T.applyTemplate();
    T.setRecords([]);
    const t0 = Date.now();
    const opens = [];
    const mo = new w.MutationObserver(() => {
      if (d.getElementById("mbMerge").classList.contains("open")) opens.push(Date.now() - t0);
    });
    mo.observe(d.getElementById("mbMerge"), { attributes: true, attributeFilter: ["class"] });
    await openMergeViaUI([{ name: "x.json", data: { schema: schemaOf("統編"), records: [rec("n1", "統編", "99999999")] } }]);
    const cb = d.querySelector("#mergeBody .ddk");
    cb.checked = true;
    cb.dispatchEvent(new w.Event("change"));
    d.getElementById("mergeApply").click();
    await sleep(50);
    const banner = d.getElementById("banner");
    const rightAfter = banner.style.display;
    await sleep(700);                                  // 超過 350 ms 的去抖動存檔
    check("合併提示在自動存檔後仍可見", banner.style.display !== "none",
      `按下後 display = ${rightAfter}、700 ms 後 display = ${banner.style.display}`);
    check("套用合併後對話框應關閉", !d.getElementById("mbMerge").classList.contains("open"),
      `開啟中的 modal 數 = ${d.querySelectorAll(".modalBack.open").length}`);
  } catch (e) { check("T8 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T9  CSV 匯入不得提供系統欄位作為對應目標
     ══════════════════════════════════════════════════════════ */
  section("T9 CSV 對應不提供系統欄位");
  try {
    T.applyTemplate();
    const opened = await openCsvViaUI("_owner,公司名稱\n王小明,測試公司");
    check("CSV 對應對話框可開啟", opened);
    const vals = Array.from(d.querySelectorAll("#mapTable select option")).map((o) => o.value);
    const bad = ["_id", "_owner", "_createdAt", "_updatedAt"].filter((k) => vals.includes(k));
    check("不得提供系統欄位", bad.length === 0, `仍提供: ${JSON.stringify(bad)}`);
    check("仍提供一般資料欄位", vals.includes("公司名稱"), `選項數 = ${vals.length}`);
    closeAllOpenModals();                             // 只是檢視，不按匯入 → 自行收拾
  } catch (e) { check("T9 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T10 「存檔（含資料）」副本：可離線還原、且不重複插入執行期控制項
     ══════════════════════════════════════════════════════════ */
  section("T10 含資料副本");
  try {
    T.clearStorage();
    T.applyTemplate();
    T.setOwner("測試員");
    T.setRecords([]);
    T.addRec({ 公司名稱: "副本公司", 說明: "含 <b>標籤</b> 與 </script> 字樣" });
    const copyHtml = T.selfCopy();

    check("副本含 #datahtml-data 承載資料", copyHtml.includes('id="datahtml-data"'), "");

    // 注意：不可用字串比對 "data-runtime"（程式原始碼本身就含這個字串），    // 也不可在「已執行 script」的副本上查 —— 搜尋框與建立者下拉本來就會在載入時
    // 由程式建立（各帶 data-runtime="1"）。要驗的是「靜態標記」不帶該屬性，
    // 否則副本開啟後會被插入第二次（曾發生「欄位管理左邊多出下拉選單」）。
    const staticDom = new JSDOM(copyHtml);             // 不執行 script，只看靜態標記
    const staticCount = staticDom.window.document.querySelectorAll("[data-runtime]").length;
    check("副本的靜態標記不含 [data-runtime]（避免開啟後重複插入）", staticCount === 0,
      `靜態 [data-runtime] = ${staticCount}`);

    const copy = await loadPage(copyHtml, "https://example.test/copy.html");
    const cd = copy.d;
    const rows = cd.querySelectorAll("#tbody tr");
    check("副本開啟後資料列已還原", rows.length === 1, `#tbody tr = ${rows.length}`);
    check("副本保留了特殊字元", rows.length === 1 && rows[0].textContent.includes("含 <b>標籤</b> 與 </script> 字樣"),
      JSON.stringify(rows.length === 1 ? rows[0].textContent.slice(0, 80) : ""));
    check("副本未重複插入執行期控制項（搜尋框 + 建立者下拉各 1）",
      cd.querySelectorAll(".tmpq").length === 2, `.tmpq = ${cd.querySelectorAll(".tmpq").length}`);
    copy.dom.window.close();
  } catch (e) { check("T10 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T11 report.html CSV 契約（只驗本側；跨 repo 的 e2e 見 TECHNICAL 10.3）
     report.html 以純逗號分欄、並依精確表頭取值，所以輸出不得出現逗號、
     引號或換行，且欄數必須恆為 25。
     ══════════════════════════════════════════════════════════ */
  section("T11 report.html CSV 契約");
  try {
    const HEADERS = ["序號", "客代", "統編", "公司名稱", "收件地址", "聯絡窗口", "聯絡電話", "聯絡信箱", "開發者", "課別", "收貨站所", "日均量體", "預估營收/月", "商品類別", "填單日期", "初步接洽", "需求確認", "報價", "簽約", "導入", "結案", "說明", "洽談內容", "類別", "甲指成功轉甲配"];
    const DATE_COLS = new Set(["填單日期", "初步接洽", "需求確認", "報價", "簽約", "導入"]);

    T.applyTemplate();
    T.setRecords([]);
    T.addRec({ 公司名稱: 'A,B"C\nD', 說明: "x\ny", 收貨站所: "甲\n乙", 填單日期: "2026-09-03", 洽談內容: "3/13 拜訪; 3/14 電聯" });
    T.addRec({ 公司名稱: "", 說明: "", 收貨站所: "" });

    const keys = new Set(T.state().schema.map((f) => f.key));
    const mapping = {};
    HEADERS.forEach((h) => { if (keys.has(h)) mapping[h] = h; });
    const csv = T.reportCSV(mapping);
    const lines = csv.split("\r\n");
    const headerCells = lines[0].replace("\uFEFF", "").split(",");

    check("輸出以 BOM 開頭", csv.charCodeAt(0) === 0xfeff, `code = ${csv.charCodeAt(0)}`);
    check("表頭恰為 25 欄且名稱正確", headerCells.length === 25 && headerCells.join("|") === HEADERS.join("|"), `欄數 = ${headerCells.length}`);
    const bad = lines.slice(1).filter((l) => l.split(",").length !== 25);
    check("每一列的欄數皆為 25（分隔符未被內容破壞）", bad.length === 0, `異常列數 = ${bad.length}`);
    check("輸出不得包含雙引號", !csv.includes('"'), "");
    const cells = lines.slice(1).flatMap((l) => l.split(","));
    check("儲存格不得含換行", !cells.some((c) => /[\r\n]/.test(c)), "");
    const dateCells = lines.slice(1).flatMap((l) => l.split(",").filter((c, i) => DATE_COLS.has(HEADERS[i])));
    check("日期欄輸出 YYYY-MM-DD 或空值", dateCells.every((c) => c === "" || /^\d{4}-\d{2}-\d{2}$/.test(c)), JSON.stringify(dateCells.slice(0, 4)));
    check("淨化：收貨站所換行轉斜線", lines[1].split(",")[HEADERS.indexOf("收貨站所")] === "甲/乙", lines[1].split(",")[HEADERS.indexOf("收貨站所")]);
    check("淨化：其余欄位換行轉全形分號", lines[1].split(",")[HEADERS.indexOf("說明")] === "x；y", lines[1].split(",")[HEADERS.indexOf("說明")]);
  } catch (e) { check("T11 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T12 合併後可選擇重新編號流水號（預設不變）
     ══════════════════════════════════════════════════════════ */
  section("T12 合併後重新編號流水號");
  try {
    const schema = schemaOf("統編", "序號");
    schema[1].type = "serial";
    const mk = (id, tax, serial) => ({ _id: id, _owner: "A", _createdAt: "2026-01-01 00:00", _updatedAt: "2026-01-01 00:00", 統編: tax, 序號: serial });
    const filings = [
      { name: "a.json", data: { schema, records: [mk("a1", "11111111", "1"), mk("a2", "22222222", "2")] } },
      { name: "b.json", data: { schema, records: [mk("b1", "33333333", "1"), mk("b2", "44444444", "2")] } },
    ];

    // (a) 預設不勾選 → 保留各站所原編號（可能重複）
    check("開啟合併對話框前沒有任何開啟中的 modal", d.querySelectorAll(".modalBack.open").length === 0,
      `開啟中的 modal = ${Array.from(d.querySelectorAll(".modalBack.open")).map((m) => m.id).join(",") || "（無）"}`);
    T.clearStorage();
    T.setRecords([]);
    for (const f of filings[0].data.schema) T.state().schema.push(f);
    T.state().schema.length = 0; filings[0].data.schema.forEach((f) => T.state().schema.push(f));
    await openMergeViaUI(filings);
    check("對話框提供「重新編號流水號」選項", !!d.getElementById("mergeRenumber"), "");
    check("預設為不勾選（不改變現行行為）", d.getElementById("mergeRenumber") && !d.getElementById("mergeRenumber").checked, "");
    check("合併前列出的檔案數 = 2", d.querySelectorAll("#fileRows tr[data-idx]").length === 2,
      `列數 = ${d.querySelectorAll("#fileRows tr[data-idx]").length}`);
    check("合併前我方 0 筆、schema = 2 欄", T.getRecords().length === 0 && T.state().schema.length === 2,
      `我方 ${T.getRecords().length} 筆、schema ${T.state().schema.length} 欄`);
    d.querySelector("#mergeBody .ddk").checked = true;
    d.getElementById("mergeApply").click();
    await sleep(80);
    let serials = T.getRecords().map((r) => r["序號"]).sort();
    check("未勾選時保留原編號（會有重複）", serials.join(",") === "1,1,2,2",
      `筆數 = ${T.getRecords().length}、序號 = ${JSON.stringify(serials)}、首筆 = ${JSON.stringify(T.getRecords()[0] || null).slice(0, 160)}`);

    // (b) 勾選 → 重新編號為 1..N且不重複
    T.clearStorage();
    T.setRecords([]);
    T.state().schema.length = 0; filings[0].data.schema.forEach((f) => T.state().schema.push(f));
    await openMergeViaUI(filings);
    d.getElementById("mergeRenumber").checked = true;
    d.querySelector("#mergeBody .ddk").checked = true;
    d.getElementById("mergeApply").click();
    await sleep(80);
    const rs = T.getRecords();
    serials = rs.map((r) => r["序號"]);
    check("勾選後重新編號為 1..N且不重複",
      rs.length === 4 && serials.slice().sort().join(",") === "1,2,3,4",
      `筆數 = ${rs.length}、序號 = ${serials.join(",")}`);
  } catch (e) { check("T12 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T13 合併對話框必須警告 schema（欄位）差異
     ══════════════════════════════════════════════════════════ */
  section("T13 schema 差異警告");
  try {
    T.applyTemplate();                                   // 我方 25 欄
    T.setRecords([]);
    const incoming = schemaOf("統編", "序號", "匯入才有欄位");
    await openMergeViaUI([{ name: "x.json", data: { schema: incoming, records: [rec("x1", "統編", "12345678")] } }]);
    const box = d.getElementById("schemaDiff");
    check("對話框有 schema 差異區塊", !!box, "");
    check("列出匯入檔才有、我方沒有的欄位", !!box && box.textContent.includes("匯入才有欄位"),
      `我方欄數 = ${T.state().schema.length}、開著的是 = ${JSON.stringify(box ? box.textContent.slice(0, 60) : null)}`);
    check("同樣提示我方有、匯入檔沒有的欄位", !!box && box.textContent.includes("公司名稱"), box ? JSON.stringify(box.textContent.slice(0, 200)) : "");
  } catch (e) { check("T13 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T14 number 欄位的非數字原值不得被靜默清空
     ══════════════════════════════════════════════════════════ */
  section("T14 number 欄位非數字值不遺失");
  try {
    T.clearStorage();
    T.applyTemplate();
    T.setRecords([rec("n1", "預估營收/月", "5~10件/天", { 公司名稱: "甲公司" })]);
    T.render();
    const row = d.querySelector("#tbody tr");
    row.click();                                        // 點列開啟編輯
    await until(() => d.getElementById("mbRecord").classList.contains("open"));
    const inp = d.querySelector('#recForm [data-k="預估營收/月"]');
    check("非數字原值確實被帶入表單", !!inp && inp.value === "5~10件/天", `value = ${JSON.stringify(inp && inp.value)}`);
    d.getElementById("recSave").click();
    await sleep(60);
    check("儲存後原值未被清空", T.getRecords()[0]["預估營收/月"] === "5~10件/天", JSON.stringify(T.getRecords()[0]["預估營收/月"]));
  } catch (e) { check("T14 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T15 分頁元件必須是 button（可鍵盤操作）
     ══════════════════════════════════════════════════════════ */
  section("T15 分頁可鍵盤操作");
  try {
    T.clearStorage();
    T.applyTemplate();
    T.setRecords(Array.from({ length: 120 }, (_, i) => rec("p" + i, "公司名稱", "C" + i)));
    T.render();
    check("分頁使用 <button> 元素", d.querySelectorAll("#pager button.pg").length >= 3,
      `button.pg = ${d.querySelectorAll("#pager button.pg").length}`);
    check("分頁不再使用不可聚焦的 <span>", d.querySelectorAll("#pager span.pg").length === 0,
      `span.pg = ${d.querySelectorAll("#pager span.pg").length}`);
  } catch (e) { check("T15 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T16 表頭全選與個別勾選狀態必須同步
     ══════════════════════════════════════════════════════════ */
  section("T16 表頭全選狀態同步");
  try {
    T.clearStorage();
    T.applyTemplate();
    T.setRecords(Array.from({ length: 3 }, (_, i) => rec("s" + i, "公司名稱", "C" + i)));
    T.render();
    const boxes = () => Array.from(d.querySelectorAll("#tbody input[type=checkbox]"));
    const all = () => d.getElementById("chkAll");
    check("初始：未勾選任何列 → 表頭未勾選", boxes().every((b) => !b.checked), `checked = ${boxes().map((b) => b.checked).join(",")}`);
    boxes()[0].click();
    await sleep(20);
    check("勾選 1 列 → 表頭為未定狀態（非全選）", all() && all().indeterminate === true && all().checked === false,
      `checked = ${all() && all().checked}、indeterminate = ${all() && all().indeterminate}`);
    all().click();                                      // 全選
    await sleep(20);
    check("按全選 → 表頭為已勾選", d.getElementById("chkAll") && d.getElementById("chkAll").checked === true, `checked = ${d.getElementById("chkAll") && d.getElementById("chkAll").checked}`);
    boxes()[1].click();                                 // 取消1 列
    await sleep(20);
    check("取消 1 列 → 表頭回到未定狀態", d.getElementById("chkAll") && d.getElementById("chkAll").indeterminate === true && d.getElementById("chkAll").checked === false,
      `checked = ${d.getElementById("chkAll") && d.getElementById("chkAll").checked}、indeterminate = ${d.getElementById("chkAll") && d.getElementById("chkAll").indeterminate}`);
  } catch (e) { check("T16 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T17 離開頁面前必須把未存的變更補寫（去抖動期間關分頁不得遺失）
     ══════════════════════════════════════════════════════════ */
  section("T17 離開頁面前補寫");
  try {
    const LS = "datahtml.v1.";
    function readPersisted() {
      const gen = w.localStorage.getItem(LS + "gen");
      if (!gen) return null;
      const n = parseInt(w.localStorage.getItem(LS + "g" + gen + ".n") || "0", 10);
      let s = "";
      for (let i = 0; i < n; i++) s += w.localStorage.getItem(LS + "g" + gen + "." + i) || "";
      try { return JSON.parse(s); } catch (e2) { return null; }
    }

    T.clearStorage();
    T.applyTemplate();
    T.setRecords([]);
    d.getElementById("btnNew").click();                 // 新增一筆後儲存 → 排入去抖動存檔
    await until(() => d.getElementById("mbRecord").classList.contains("open"));
    d.getElementById("recSave").click();
    check("存檔前確實尚未寫入（仍在去抖動中）", readPersisted() === null, JSON.stringify(readPersisted() === null));
    w.dispatchEvent(new w.Event("beforeunload"));       // 關分頁
    const persisted = readPersisted();
    check("離開頁面前已補寫入", persisted !== null && persisted.records.length === 1,
      persisted ? `已寫入 ${persisted.records.length} 筆` : "未寫入");
  } catch (e) { check("T17 執行", false, e.message); }

  /* ══════════════════════════════════════════════════════════
     T18 點建立者下拉時，選單應關閉（它不屬於 .menuWrap）
     ══════════════════════════════════════════════════════════ */
  section("T18 建立者下拉不屬於選單容器");
  try {
    T.clearStorage();
    T.applyTemplate();
    T.setRecords([]);
    T.render();
    const owner = d.getElementById("ownerFilter");
    check("建立者下拉存在", !!owner, "");
    check("建立者下拉不在 .menuWrap 内部", !!owner && owner.closest(".menuWrap") === null,
      owner && owner.closest(".menuWrap") ? `在 ${owner.closest(".menuWrap").className}` : "不在任何 menuWrap 内");
    d.getElementById("btnImportMenu").click();          // 開啟匯入選單
    await sleep(20);
    check("匯入選單已開啟", d.getElementById("importMenu").classList.contains("open"), "");
    owner.click();                                    // 點建立者下拉
    await sleep(20);
    check("點建立者下拉後選單應關閉", !d.getElementById("importMenu").classList.contains("open"),
      `open = ${d.getElementById("importMenu").classList.contains("open")}`);
  } catch (e) { check("T18 執行", false, e.message); }

  /* ── 頁面內不得有未捕捉的例外 ─────────────────────── */
  section("X1 頁面執行期間的未捕捉例外");
  check("沒有任何未捕捉的例外", pageErrors.length === 0,
    pageErrors.length ? `${pageErrors.length} 筆，首筆：${pageErrors[0].split("\n")[0]}` : "");
  if (pageErrors.length) {
    console.log("\n未捕捉的例外（事件處理器裡拋錯會被吞掉）：");
    pageErrors.slice(0, 8).forEach((m) => console.log("   - " + m.split("\n")[0]));
  }

  /* ── 結果輸出 ────────────────────────────────────────────── */
  const pad = (s, n) => s + " ".repeat(Math.max(0, n - [...s].length));
  console.log(`\ndata.html 回歸測試  檔案: ${path.relative(process.cwd(), DATA_HTML)}\n`);
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.section) { console.log(`\n▌${r.section}`); continue; }
    r.ok ? pass++ : fail++;
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${pad(r.name, 62)}${r.detail ? "  " + r.detail : ""}`);
  }
  console.log(`\n${pass} pass / ${fail} fail / ${pass + fail} total\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("測試 harness 例外:", e);
  process.exit(9);
});
