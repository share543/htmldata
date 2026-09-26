// data.html 端到端測試（Playwright + 真實 Chromium）
//
// 這裡只放「jsdom 做不到」的驗證：真正的檔案挑選器、真正的下載、真正的導覽
// （beforeunload）、真實鍵盤焦點、真實 CSS 媒體查詢、真實版面。
// 其餘邏輯回歸請看 tests/data-html.test.js（jsdom，快且可離線）。
"use strict";

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..", "..");
const DATA_HTML = path.join(REPO_ROOT, "data.html");

let tmpDir;
test.beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "htmldata-e2e-"));
});
test.afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ── 小工具 ─────────────────────────────────────────────── */

/** 造一個本工具可匯入的 JSON 檔（模擬同事匯出的檔案） */
function filingFile(fileName, records) {
  const p = path.join(tmpDir, fileName);
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        meta: { tool: "data.html", ver: 1, exportedAt: "2026-01-01 00:00", sheet: "未命名資料表", owner: "業務" },
        schema: [
          { key: "統編", label: "統編", type: "text", options: [], examples: [], hint: "", default: "", required: false },
          { key: "序號", label: "序號", type: "serial", options: [], examples: [], hint: "", default: "", required: false },
          { key: "公司名稱", label: "公司名稱", type: "text", options: [], examples: [], hint: "", default: "", required: false },
        ],
        records,
      },
      null,
      1
    ),
    "utf8"
  );
  return p;
}

function rec(id, tax, serial, name) {
  return {
    _id: id,
    _owner: "業務",
    _createdAt: "2026-01-01 00:00",
    _updatedAt: "2026-01-01 00:00",
    統編: tax,
    序號: serial,
    公司名稱: name,
  };
}

/** 用「真實的檔案挑選器」選檔（jsdom 只能假造 input.files） */
async function chooseFiles(page, menuAct, files) {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.click("#btnImportMenu");
  await page.click(`#importMenu button[data-act="${menuAct}"]`);
  const chooser = await chooserPromise;
  await chooser.setFiles(files);
}

/** 準備一筆資料：套範本 → 填我的名稱 → 新增一筆 */
async function seedOneRecord(page, company) {
  await page.goto("/data.html");
  await page.click("#btnTemplate"); // 空表時直接套用，不跳確認
  await page.fill("#ownerName", "王小明");
  await page.click("#btnNew");
  await page.fill('#recForm [data-k="公司名稱"]', company);
  await page.click("#recSave");
  await expect(page.locator("#tbody tr")).toHaveCount(1);
}

/* ── 測試 ───────────────────────────────────────────────── */

test("真實打字會觸發 oninput，建立者正確寫入紀錄", async ({ page }) => {
  // jsdom 測不到這條：指派 element.value 不會觸發任何事件，
  // 只有真正的鍵盤／fill 才會。ownerName.oninput 是唯一把 OWNER 寫進狀態的路徑。
  await seedOneRecord(page, "甲公司");
  await expect(page.locator("#tbody tr")).toContainText("王小明");
});

test("真實檔案挑選 → 合併 → 預設重編流水號", async ({ page }) => {
  await page.goto("/data.html");
  await page.click("#btnTemplate");

  const a = filingFile("a.json", [rec("a1", "11111111", "1", "甲公司"), rec("a2", "22222222", "2", "乙公司")]);
  const b = filingFile("b.json", [rec("b1", "33333333", "1", "丙公司"), rec("b2", "44444444", "2", "丁公司")]);

  await chooseFiles(page, "merge", [a, b]);

  await expect(page.locator("#mbMerge")).toHaveClass(/open/);
  await expect(page.locator("#fileRows tr[data-idx]")).toHaveCount(2);

  await page.check("#mergeBody .ddk"); // 判重欄位（統編）
  await expect(page.locator("#mergeRenumber")).toBeChecked(); // 預設已勾選
  await page.click("#mergeApply");

  await expect(page.locator("#mbMerge")).not.toHaveClass(/open/);
  await expect(page.locator("#tbody tr")).toHaveCount(4);

  // 序號應重編為 1..4（識別依據是統編／客代，序號只是顯示標籤）
  const serials = await page.$$eval("#tbody tr", (rows) => rows.map((r) => r.children[1].textContent.trim()));
  expect(serials.slice().sort()).toEqual(["1", "2", "3", "4"]);
});

test("匯出 JSON 會真的下載檔案，內容可解析", async ({ page }) => {
  await seedOneRecord(page, "甲公司");

  const dlPromise = page.waitForEvent("download");
  await page.click("#btnExportMenu");
  await page.click('#exportMenu button[data-act="json"]');
  const download = await dlPromise;

  expect(download.suggestedFilename()).toMatch(/\.json$/);
  const obj = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  expect(obj.records).toHaveLength(1);
  expect(obj.records[0].公司名稱).toBe("甲公司");
  expect(obj.schema.map((f) => f.key)).toContain("公司名稱");
});

test("「存檔（含資料）」副本可離線從磁碟開啟並還原資料", async ({ page, context }) => {
  // 這是整條鏈最關鍵的一條：clone → 剝除執行期節點 → 內嵌資料 → 下載 →
  // 用 file:// 從磁碟開啟 → 資料回來，而且沒有重複插入的控制項。
  await seedOneRecord(page, "副本公司");

  const dlPromise = page.waitForEvent("download");
  await page.click("#btnSaveCopy");
  const download = await dlPromise;
  const copyPath = path.join(tmpDir, "copy.html");
  await download.saveAs(copyPath);
  expect(fs.statSync(copyPath).size).toBeGreaterThan(50000);

  const page2 = await context.newPage();
  const errors = [];
  page2.on("pageerror", (e) => errors.push(e.message));
  await page2.goto("file://" + copyPath);

  await expect(page2.locator("#tbody tr")).toHaveCount(1);
  await expect(page2.locator("#tbody tr")).toContainText("副本公司");
  await expect(page2.locator(".tmpq")).toHaveCount(2); // 搜尋框 + 建立者下拉，各 1
  expect(errors).toEqual([]);
});

test("重新載入後未存的變更仍在（真實導覽 + beforeunload 補寫）", async ({ page }) => {
  await page.goto("/data.html");
  await page.click("#btnTemplate");
  await page.fill("#ownerName", "王小明");
  await page.click("#btnNew");
  await page.fill('#recForm [data-k="公司名稱"]', "趕著關掉");
  await page.click("#recSave"); // 只排入 350ms 去抖動，還沒寫入
  await page.reload(); // 真實導覽，會觸發 beforeunload

  await expect(page.locator("#tbody tr")).toHaveCount(1);
  await expect(page.locator("#tbody tr")).toContainText("趕著關掉");
});

test("列印模式的 CSS 真的生效（jsdom 完全做不到）", async ({ page }) => {
  await page.goto("/data.html");
  await expect(page.locator(".toolbar")).toBeVisible();

  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".toolbar")).toBeHidden();
  await expect(page.locator("#pager")).toBeHidden();
});

test("手機寬度不水平溢出，modal 不超出視窗", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/data.html");
  await page.click("#btnTemplate");
  await page.click("#btnNew");
  await expect(page.locator("#mbRecord")).toHaveClass(/open/);

  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);

  const box = await page.locator("#mbRecord .modal").boundingBox();
  expect(box.width).toBeLessThanOrEqual(390);
});

test("分頁按鈕可用鍵盤聚焦（jsdom 沒有焦點模型）", async ({ page }) => {
  await page.goto("/data.html");
  await page.click("#btnTemplate");

  const btn = page.locator("#pager button.pg").nth(1);
  await expect(btn).toBeVisible();
  await btn.focus();
  expect(await page.evaluate(() => document.activeElement && document.activeElement.tagName)).toBe("BUTTON");
  await page.keyboard.press("Enter"); // 按下不應拋錯
});

test("可直接用 file:// 從磁碟開啟（實際使用情境）", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("file://" + DATA_HTML);
  await expect(page.locator("#btnNew")).toBeVisible();
  await page.click("#btnTemplate");
  await page.click("#btnNew");
  await page.fill('#recForm [data-k="公司名稱"]', "離線甲公司");
  await page.click("#recSave");

  await expect(page.locator("#tbody tr")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("匯入檔的惡意 schema key 在真實引擎中也不注入", async ({ page }) => {
  await page.goto("/data.html");
  await page.click("#btnTemplate");

  const evil = "A' onmouseover='window.__PWNED=1' x='";
  const p = filingFile("evil.json", [
    { _id: "e1", _owner: "業務", _createdAt: "2026-01-01 00:00", _updatedAt: "2026-01-01 00:00", [evil]: "v" },
  ]);
  await chooseFiles(page, "merge", [p]);
  await expect(page.locator("#mbMerge")).toHaveClass(/open/);

  expect(await page.locator("#mergeBody [onmouseover]").count()).toBe(0);
  expect(await page.evaluate(() => window.__PWNED)).toBeUndefined();

  const box = page.locator("#mergeBody .ddk").first();
  await expect(box).toHaveCount(1);
  expect(await box.getAttribute("value")).toBe(evil);
});
