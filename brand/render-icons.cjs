// Renders the Drivo icons to every PNG size the web app, Android and iOS use.
// Needs Playwright (Chromium). Run from the repository root: node brand/render-icons.cjs
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const svg = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const out = (p) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); return path.join(root, p); };

const androidDensities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  async function render(source, size, file, { circle = false, transparent = true } = {}) {
    await page.setViewportSize({ width: size, height: size });
    const clip = circle ? "border-radius:50%;overflow:hidden;" : "";
    await page.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;${clip}">${source.replace("<svg ", `<svg width="${size}" height="${size}" `)}</div></body></html>`);
    await page.screenshot({ path: out(file), omitBackground: transparent });
  }

  // Web: Apple touch icon (square; iOS rounds it). The favicon is web/src/app/icon.svg.
  await render(svg("drivo-icon-square.svg"), 180, "web/src/app/apple-icon.png", { transparent: false });

  // Android: legacy, round and adaptive foreground.
  for (const [d, k] of Object.entries(androidDensities)) {
    await render(svg("drivo-icon.svg"), 48 * k, `android/app/src/main/res/mipmap-${d}/ic_launcher.png`);
    await render(svg("drivo-icon-android-foreground.svg"), 48 * k, `android/app/src/main/res/mipmap-${d}/ic_launcher_round.png`, { circle: true });
    await render(svg("drivo-icon-android-foreground.svg"), 108 * k, `android/app/src/main/res/mipmap-${d}/ic_launcher_foreground.png`, { transparent: false });
  }

  // iOS: one 1024 px icon, no transparency.
  await render(svg("drivo-icon-square.svg"), 1024, "ios/Drivo/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png", { transparent: false });

  await browser.close();
  console.log("Icons rendered.");
})();
