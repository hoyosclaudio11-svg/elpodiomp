/**
 * Genera og-image.png (1200×630) para Facebook/WhatsApp/Telegram
 * Usa Puppeteer para renderizar un HTML y capturarlo como PNG.
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const OUTPUT_PATH = path.join(__dirname, '..', 'og-image.png');

const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1200px;
    height: 630px;
    background: linear-gradient(135deg, #FFE600 0%, #FFD700 50%, #FFC107 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
    overflow: hidden;
  }
  .container {
    text-align: center;
    padding: 60px;
  }
  .trophy {
    font-size: 120px;
    margin-bottom: 24px;
    filter: drop-shadow(0 8px 16px rgba(0,0,0,0.15));
  }
  h1 {
    font-size: 72px;
    font-weight: 900;
    color: #1a1a1a;
    margin-bottom: 8px;
    letter-spacing: -2px;
  }
  h1 span {
    color: #3483FA;
  }
  p {
    font-size: 28px;
    color: #333;
    font-weight: 500;
    letter-spacing: -0.5px;
  }
  .bottom-bar {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 8px;
    background: #3483FA;
  }
  .corner-circle {
    position: absolute;
    width: 300px;
    height: 300px;
    border-radius: 50%;
    opacity: 0.08;
    background: #3483FA;
  }
  .corner-circle.tl { top: -100px; left: -100px; }
  .corner-circle.br { bottom: -100px; right: -100px; }
</style>
</head>
<body>
  <div class="corner-circle tl"></div>
  <div class="corner-circle br"></div>
  <div class="container">
    <div class="trophy">&#127942;</div>
    <h1>El Podio <span>MP</span></h1>
    <p>Los mejores productos de Mercado Libre al mejor precio</p>
  </div>
  <div class="bottom-bar"></div>
</body>
</html>`;

async function main() {
  console.log('[OG Image] Lanzando navegador...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
    await page.setContent(HTML, { waitUntil: 'networkidle0' });

    // Tomar screenshot
    await page.screenshot({ path: OUTPUT_PATH, type: 'png' });
    console.log(`[OG Image] Creada: ${OUTPUT_PATH} (${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1)} KB)`);
  } catch (err) {
    console.error('[OG Image] Error:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
