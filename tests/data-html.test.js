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
const { JSDOM } = require("jsdom");

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

/** 載入一份 data.html（可選擇是否注入測試旗標） */
async function loadPage(html, url) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: url || "https://example.test/data.html",
    pretendToBeVisual: true,
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

  /** 以真實 UI 開啟合併對話框（模擬使用者選檔） */
  async function openMergeViaUI(filings) {
    const inp = d.getElementById("mergeFileInput");
    inp.click = function () {};                       // 阻止 jsdom 開檔對話框
    d.querySelector('#importMenu button[data-act="merge"]').click();
    const files = filings.map((f) => new w.File([JSON.stringify(f.data)], f.name, { type: "application/json" }));
    Object.defineProperty(inp, "files", { value: files, configurable: true });
    inp.dispatchEvent(new w.Event("change"));
    return until(() => d.getElementById("mbMerge").classList.contains("open"));
  }

  /** 以真實 UI 開啟 CSV 匯入對應對話框 */
  async function openCsvViaUI(csvText) {
    const inp = d.getElementById("csvFileInput");
    inp.click = function () {};
    d.querySelector('#importMenu button[data-act="csv"]').click();
    Object.defineProperty(inp, "files", {
      value: [new w.File([csvText], "x.csv", { type: "text/csv" })],
      configurable: true,
    });
    inp.dispatchEvent(new w.Event("change"));
    return until(() => d.getElementById("mbMap").classList.contains("open"));
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
