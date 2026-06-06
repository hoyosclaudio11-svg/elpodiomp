/**
 * Extrae productos REALES de Mercado Libre.
 * Usa puppeteer-extra + stealth plugin para evadir detección anti-bot.
 *
 * Ejecutar: node scripts/scrape-real-products.js
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const FIXTURE_PATH = path.join(__dirname, '..', 'products-fixture.json');
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const categories = config.categories;
const result = {};

async function scrapeCategory(browser, cat) {
  const url = `https://listado.mercadolibre.com.ar/${encodeURIComponent(cat.query)}`;
  console.log(`🔍 ${cat.icon} ${cat.name}...`);

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Esperar a que carguen productos (o que falle rápido)
    try {
      await page.waitForSelector('.ui-search-layout__item, .poly-card, .andes-card, li.ui-search-layout__item', { timeout: 8000 });
    } catch {
      // Si no encuentra productos, probablemente estamos en verificación
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
      if (bodyText.includes('verificación') || bodyText.includes('account-verification')) {
        console.log(`   ⚠️  Mercado Libre pidió verificación (bloqueo anti-bot).`);
      } else {
        console.log(`   ⚠️  No se encontraron productos (${bodyText.substring(0, 60)}...)`);
      }
      await page.close();
      return;
    }

    // Extraer productos
    const products = await page.evaluate((categoryUrl) => {
      const items = [];
      const selectors = ['.ui-search-layout__item', '.poly-card', '.andes-card', 'li.ui-search-layout__item'];
      let cards = [];
      for (const sel of selectors) {
        cards = [...document.querySelectorAll(sel)];
        if (cards.length > 0) break;
      }

      for (let i = 0; i < Math.min(cards.length, 3); i++) {
        const el = cards[i];

        const titleEl = el.querySelector('h2, .ui-search-item__title, .poly-component__title, a[title]');
        const title = titleEl ? (titleEl.textContent.trim() || titleEl.getAttribute('title') || '') : '';
        if (!title || title.length < 5) continue;

        // Buscar el link real del producto (no el de tracking genérico)
        let link = '';
        // Estrategia 1: link directo al artículo
        let linkEl = el.querySelector('a[href*="articulo.mercadolibre.com.ar"]')
          || el.querySelector('a[href*="mercadolibre.com.ar"][href*="/MLA-"]');
        // Estrategia 2: link de tracking (contiene url= con el destino real)
        if (!linkEl) {
          const allLinks = el.querySelectorAll('a');
          for (const a of allLinks) {
            const h = a.href || '';
            if (h.includes('mclics') || h.includes('click1') || h.includes('click2')) {
              linkEl = a; break;
            }
          }
        }
        // Estrategia 3: el primer link disponible
        if (!linkEl) linkEl = el.querySelector('a');

        if (linkEl && linkEl.href) {
          let href = linkEl.href;
          // Decodificar URL de tracking de ML
          if ((href.includes('mclics') || href.includes('click')) && href.includes('url=')) {
            try {
              const urlParam = new URL(href).searchParams.get('url');
              if (urlParam) href = decodeURIComponent(urlParam);
            } catch (_) {}
          }
          link = href.split('?')[0].split('#')[0];
        }
        // Estrategia 4: reconstruir desde MLA ID en el HTML del card
        if (!link || !/MLA-?\d{7,12}/.test(link)) {
          const mlaMatch = el.innerHTML.match(/MLA[_-]?(\d{7,12})/);
          if (mlaMatch) link = `https://www.mercadolibre.com.ar/MLA-${mlaMatch[1]}`;
        }
        // Fallback final
        if (!link) link = categoryUrl || '';

        const imgEl = el.querySelector('img');
        let imageUrl = '';
        if (imgEl) {
          imageUrl = imgEl.dataset.src || imgEl.src || '';
          if (imageUrl && imageUrl.includes('-I.jpg')) imageUrl = imageUrl.replace('-I.jpg', '-O.jpg');
          if (imageUrl && imageUrl.startsWith('http://')) imageUrl = imageUrl.replace('http://', 'https://');
        }

        const priceEl = el.querySelector('.price-tag-fraction, .andes-money-amount__fraction, [class*="price-tag-amount"]');
        let price = 0;
        if (priceEl) price = parseInt(priceEl.textContent.replace(/\D/g, '')) || 0;

        const oldPriceEl = el.querySelector('.price-tag-line-through, s .price-tag-fraction, [class*="price__old"]');
        let oldPrice = null;
        if (oldPriceEl) oldPrice = parseInt(oldPriceEl.textContent.replace(/\D/g, '')) || null;

        let badge = 'Destacado';
        if (oldPrice && price && oldPrice > price) {
          const pct = Math.round(((oldPrice - price) / oldPrice) * 100);
          if (pct > 0) badge = `${pct}% OFF`;
        } else if (el.querySelector('.ui-search-item__shipping--free, [class*="free"]')) {
          badge = 'Envío Gratis';
        }

        items.push({ title, price: price || 99999, oldPrice, imageUrl, badge, link });
        if (items.length >= 3) break;
      }
      return items;
    }, url);

    if (products.length > 0) {
      console.log(`   ✅ ${products.length} productos`);
      result[cat.id] = products.map(p => ({
        title: p.title,
        price: p.price,
        oldPrice: p.oldPrice,
        imageUrl: p.imageUrl,
        badge: p.badge,
        description: `Producto real de Mercado Libre. ${p.badge.includes('OFF') ? '¡Aprovechá el descuento!' : 'Calidad garantizada con los mejores vendedores.'}`,
        link: p.link
      }));
    } else {
      console.log(`   ⚠️  Sin productos extraíbles.`);
    }
  } catch (err) {
    console.log(`   ❌ ${err.message}`);
  } finally {
    await page.close();
  }
}

async function main() {
  console.log('🛒 Extrayendo productos reales de Mercado Libre...\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1366,768'
    ]
  });

  for (let i = 0; i < categories.length; i++) {
    await scrapeCategory(browser, categories[i]);
    if (i < categories.length - 1) await new Promise(r => setTimeout(r, 2000));
  }

  await browser.close();

  // Mantener fixture anterior para categorías sin resultado
  let oldFixture = {};
  if (fs.existsSync(FIXTURE_PATH)) {
    try { oldFixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')); } catch (_) {}
  }
  categories.forEach(cat => {
    if (!result[cat.id] && oldFixture[cat.id]) result[cat.id] = oldFixture[cat.id];
  });

  const updated = Object.keys(result).filter(k => {
    // Contar cuántas categorías tienen datos reales (con link a Meli)
    return result[k].some(p => p.link && p.link.includes('mercadolibre'));
  }).length;

  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n💾 ${Object.keys(result).length} categorías guardadas (${updated} con productos reales de Meli).`);

  if (updated > 0) {
    console.log('\n📋 Ahora ejecutá:');
    console.log('   node scripts/generate-cache.js');
    console.log('   git add cache.html products-fixture.json');
    console.log('   git commit -m "productos reales actualizados"');
    console.log('   git push');
  }
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
