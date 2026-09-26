// Playwright 設定：端到端測試（真實 Chromium）
//
// 為什麼需要這一套：tests/data-html.test.js 用的是 jsdom，它沒有版面引擎、沒有
// 真正的檔案挑選器與下載、也無法模擬鍵盤焦點與 CSS 媒體查詢。這一套專門補上
// jsdom 做不到的部分，其餘仍由 jsdom 那套（快、可離線）負責。
//
// 注意：Playwright 在 Android/Termux 上會直接拋 "Unsupported platform: android"，
// 因此本機（Termux）無法執行，只能在 CI 或一般桌機跑。
const { defineConfig, devices } = require("@playwright/test");

const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE,
    trace: "on-first-retry",
  },
  // 用本機 HTTP 伺服器而非 file://：避免各瀏覽器對 file:// 的 localStorage
  // 與 blob 下載政策差異造成不穩。真實的 file:// 情境另有專門的測試。
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1`,
    url: `${BASE}/data.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
