/**
 * Test rápido de categorías problemáticas.
 * Ejecutar: node scripts/test-filtros.js
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());
require('dotenv').config({ override: true });

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
// Test manual con diferentes queries para gama media
const cats = [
  { id: 'test1', name: 'Test: samsung galaxy s24 fe', icon: '📲', query: 'samsung galaxy s24 fe', urlSuffix: '_OrderId_PRICE_DESC', minPrice: 500000, excludeKeywords: config.categories.find(c => c.id === 'celulares_media').excludeKeywords },
  { id: 'test2', name: 'Test: motorola edge 50', icon: '📲', query: 'motorola edge 50', urlSuffix: '_OrderId_PRICE_DESC', minPrice: 500000, excludeKeywords: config.categories.find(c => c.id === 'celulares_media').excludeKeywords },
];

function filterProducts(products, cat) {
  const minP = cat.minPrice || 0;
  const kw = (cat.excludeKeywords || []).map(k => k.toLowerCase());
  return products.filter(p => {
    const t = p.title.toLowerCase();
    if (minP > 0 && p.price < minP) return false;
    for (const k of kw) {
      // Usar word boundary para keywords cortas (evita "mica" matcheando "económicas")
      const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('(^|\\s)' + escaped + '(\\s|$)', 'i').test(t)) return false;
    }
    return true;
  });
}

(async () => {
  console.log('🧪 Test rápido de filtros\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled']
  });

  for (const cat of cats) {
    const slug = cat.query.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const baseUrl = 'https://listado.mercadolibre.com.ar/' + slug;
    const url = cat.urlSuffix ? baseUrl + cat.urlSuffix : baseUrl;
    console.log(`🔍 ${cat.icon} ${cat.name}`);
    console.log(`   Query: "${cat.query}"`);
    if (cat.urlSuffix) console.log(`   urlSuffix: ${cat.urlSuffix}`);
    console.log(`   minPrice: $${(cat.minPrice || 0).toLocaleString()}`);

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForSelector(
        '.ui-search-layout__item, .poly-card, .andes-card',
        { timeout: 8000 }
      );

      const products = await page.evaluate(() => {
        const items = [];
        const cards = document.querySelectorAll(
          '.ui-search-layout__item, .poly-card, .andes-card'
        );
        for (let i = 0; i < Math.min(cards.length, 6); i++) {
          const el = cards[i];
          const titleEl = el.querySelector(
            'h2, .ui-search-item__title, .poly-component__title, a[title]'
          );
          const title = titleEl
            ? (titleEl.textContent.trim() || titleEl.getAttribute('title') || '')
            : '';
          if (!title || title.length < 5) continue;

          let link = '';
          let linkEl =
            el.querySelector('a[href*="articulo.mercadolibre.com.ar"]') ||
            el.querySelector('a[href*="mercadolibre.com.ar"][href*="/MLA-"]');
          if (!linkEl) {
            for (const a of el.querySelectorAll('a')) {
              if (a.href && (a.href.includes('mclics') || a.href.includes('click'))) {
                linkEl = a; break;
              }
            }
          }
          if (!linkEl) linkEl = el.querySelector('a');
          if (linkEl && linkEl.href) {
            let href = linkEl.href;
            if ((href.includes('mclics') || href.includes('click')) && href.includes('url=')) {
              try {
                const up = new URL(href).searchParams.get('url');
                if (up) href = decodeURIComponent(up);
              } catch (_) {}
            }
            link = href.split('?')[0].split('#')[0];
          }
          if (!link || !/MLA-?\d{7,12}/.test(link)) {
            const mm = el.innerHTML.match(/MLA[_-]?(\d{7,12})/);
            if (mm) link = 'https://www.mercadolibre.com.ar/MLA-' + mm[1];
          }

          const priceEl = el.querySelector(
            '.price-tag-fraction, .andes-money-amount__fraction, [class*="price-tag-amount"]'
          );
          const price = priceEl
            ? (parseInt(priceEl.textContent.replace(/\D/g, '')) || 0)
            : 0;

          items.push({ title, price, link });
        }
        return items;
      });

      const filtered = filterProducts(products, cat);
      console.log(`   Scrapeados: ${products.length} | ✅ Pasan: ${filtered.length} | ❌ Descartados: ${products.length - filtered.length}`);

      if (filtered.length > 0) {
        console.log('   📱 Productos válidos:');
        filtered.forEach((p, i) =>
          console.log(`      ${i + 1}. ${p.title.substring(0, 90)} — $${p.price?.toLocaleString()}`)
        );
      } else {
        console.log('   ⚠️  ¡NINGÚN producto pasó los filtros!');
      }

      if (products.length - filtered.length > 0) {
        console.log('   🗑️  Descartados:');
        products
          .filter(p => !filtered.includes(p))
          .forEach(p =>
            console.log(`      ❌ ${p.title.substring(0, 80)} — $${p.price?.toLocaleString()}`)
          );
      }
    } catch (e) {
      console.log(`   ❌ Error: ${e.message}`);
    } finally {
      await page.close();
    }
    console.log('');
    await new Promise(r => setTimeout(r, 3000));
  }

  await browser.close();
  console.log('✅ Test completado.');
})();
