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
require('dotenv').config({ override: true });

const FIXTURE_PATH = path.join(__dirname, '..', 'products-fixture.json');
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// ── Proxy helper ─────────────────────────────────
function parseProxyUrl(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    return {
      server: `${u.protocol}//${u.hostname}:${u.port}`,
      username: u.username || null,
      password: u.password || null
    };
  } catch { return null; }
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const categories = config.categories;
const result = {};

// ── Filtros de calidad ────────────────────────────
function applyFilters(products, cat) {
  const minPrice = cat.minPrice || 0;
  const excludeKw = (cat.excludeKeywords || []).map(k => k.toLowerCase());

  return products.filter(p => {
    const t = p.title.toLowerCase();

    // Precio mínimo
    if (minPrice > 0 && p.price < minPrice) return false;

    // Keywords excluidas (accesorios, repuestos, fundas, etc.)
    for (const kw of excludeKw) {
      // Word boundary regex — evita falsos positivos como "mica" dentro de "económicas"
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('(^|\\s)' + escaped + '(\\s|$)', 'i').test(t)) return false;
    }

    return true;
  });
}

// ── Scraping de una categoría ─────────────────────
async function scrapeOne(browser, cat, query, proxyConfig) {
  const baseUrl = `https://listado.mercadolibre.com.ar/${encodeURIComponent(query)}`;
  const url = cat.urlSuffix ? `${baseUrl}${cat.urlSuffix}` : baseUrl;

  const page = await browser.newPage();

  // Viewport aleatorio
  const widths = [1366, 1440, 1536, 1920];
  const heights = [768, 900, 864, 1080];
  await page.setViewport({
    width: widths[Math.floor(Math.random() * widths.length)],
    height: heights[Math.floor(Math.random() * heights.length)]
  });

  if (proxyConfig && proxyConfig.username && proxyConfig.password) {
    await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password });
  }

  let products = [];

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Scroll humano para cargar lazy images y evadir detección
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let total = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 100 + Math.floor(Math.random() * 200));
          total += 100;
          if (total >= 600) { clearInterval(timer); resolve(); }
        }, 100 + Math.floor(Math.random() * 150));
      });
    });

    // Esperar cards de producto
    try {
      await page.waitForSelector(
        '.ui-search-layout__item, .poly-card, .andes-card, li.ui-search-layout__item',
        { timeout: 10000 }
      );
    } catch {
      const bodyHtml = await page.evaluate(() => document.body.innerHTML.substring(0, 500));
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));

      if (bodyText.includes('verificación') || bodyHtml.includes('account-verification') ||
          bodyText.includes('Valida tu identidad') || bodyText.includes('robot') ||
          bodyText.includes('humano') || bodyText.includes('Confirma que')) {
        console.log(`   ⚠️  Mercado Libre pidió verificación (bloqueo anti-bot).`);
      } else {
        console.log(`   ⚠️  No se encontraron productos.`);
      }
      return products;
    }

    // Verificar página de verificación
    const isVerification = await page.evaluate(() =>
      document.body.innerHTML.includes('account-verification')
    );
    if (isVerification) {
      console.log(`   ⚠️  Mercado Libre pidió verificación (bloqueo anti-bot).`);
      return products;
    }

    // Extraer productos
    products = await page.evaluate((categoryUrl) => {
      const items = [];
      const selectors = [
        '.ui-search-layout__item', '.poly-card', '.andes-card',
        'li.ui-search-layout__item'
      ];
      let cards = [];
      for (const sel of selectors) {
        cards = [...document.querySelectorAll(sel)];
        if (cards.length > 0) break;
      }

      for (let i = 0; i < Math.min(cards.length, 6); i++) {
        const el = cards[i];

        const titleEl = el.querySelector(
          'h2, .ui-search-item__title, .poly-component__title, a[title]'
        );
        const title = titleEl
          ? (titleEl.textContent.trim() || titleEl.getAttribute('title') || '')
          : '';
        if (!title || title.length < 5) continue;

        // Link del producto
        let link = '';
        let linkEl =
          el.querySelector('a[href*="articulo.mercadolibre.com.ar"]') ||
          el.querySelector('a[href*="mercadolibre.com.ar"][href*="/MLA-"]');

        if (!linkEl) {
          const allLinks = el.querySelectorAll('a');
          for (const a of allLinks) {
            if (a.href && (a.href.includes('mclics') || a.href.includes('click1') || a.href.includes('click2'))) {
              linkEl = a; break;
            }
          }
        }
        if (!linkEl) linkEl = el.querySelector('a');

        if (linkEl && linkEl.href) {
          let href = linkEl.href;
          if ((href.includes('mclics') || href.includes('click')) && href.includes('url=')) {
            try {
              const urlParam = new URL(href).searchParams.get('url');
              if (urlParam) href = decodeURIComponent(urlParam);
            } catch (_) {}
          }
          link = href.split('?')[0].split('#')[0];
        }

        // Reconstruir desde MLA ID
        if (!link || !/MLA-?\d{7,12}/.test(link)) {
          const mlaMatch = el.innerHTML.match(/MLA[_-]?(\d{7,12})/);
          if (mlaMatch) {
            const s = (title || 'producto').toLowerCase()
              .normalize('NFD').replace(/[̀-ͯ]/g, '')
              .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 80);
            link = `https://www.mercadolibre.com.ar/MLA-${mlaMatch[1]}-${s}-_JM`;
          }
        }
        if (!link) link = categoryUrl || '';

        // Imagen
        const imgEl = el.querySelector('img');
        let imageUrl = '';
        if (imgEl) {
          imageUrl = imgEl.dataset.src || imgEl.src || '';
          if (imageUrl && imageUrl.includes('-I.jpg'))
            imageUrl = imageUrl.replace('-I.jpg', '-O.jpg');
          if (imageUrl && imageUrl.startsWith('http://'))
            imageUrl = imageUrl.replace('http://', 'https://');
        }

        // Precio
        const priceEl = el.querySelector(
          '.price-tag-fraction, .andes-money-amount__fraction, [class*="price-tag-amount"]'
        );
        let price = 0;
        if (priceEl) price = parseInt(priceEl.textContent.replace(/\D/g, '')) || 0;

        const oldPriceEl = el.querySelector(
          '.price-tag-line-through, s .price-tag-fraction, [class*="price__old"]'
        );
        let oldPrice = null;
        if (oldPriceEl) oldPrice = parseInt(oldPriceEl.textContent.replace(/\D/g, '')) || null;

        let badge = 'Destacado';
        if (oldPrice && price && oldPrice > price) {
          const pct = Math.round(((oldPrice - price) / oldPrice) * 100);
          if (pct > 0) badge = `${pct}% OFF`;
        } else if (el.querySelector('.ui-search-item__shipping--free, [class*="free"]')) {
          badge = 'Envío Gratis';
        }

        items.push({
          title, price: price || 99999, oldPrice, imageUrl, badge, link
        });
      }
      return items;
    }, url);

  } catch (err) {
    console.log(`   ❌ ${err.message}`);
  } finally {
    await page.close();
  }

  return products;
}

// ── Scraping con fallback ─────────────────────────
async function scrapeCategory(browser, cat, proxyConfig) {
  console.log(`🔍 ${cat.icon} ${cat.name}...`);

  // Intento 1: query principal
  let products = await scrapeOne(browser, cat, cat.query, proxyConfig);

  // Intento 2: fallback (si existe y no se obtuvo nada)
  if (products.length === 0 && cat.fallbackQuery) {
    console.log(`   🔄 Query principal sin resultados. Probando fallback: "${cat.fallbackQuery}"...`);
    // Delay extra para no parecer bot
    await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 3000)));
    products = await scrapeOne(browser, cat, cat.fallbackQuery, proxyConfig);
  }

  // Aplicar filtros de calidad
  if (products.length > 0) {
    const filtered = applyFilters(products, cat);
    const descartados = products.length - filtered.length;

    if (filtered.length > 0) {
      const extra = descartados > 0
        ? ` (${descartados} accesorios/repuestos descartados)`
        : '';
      console.log(`   ✅ ${filtered.length} productos${extra}`);
      result[cat.id] = filtered.map(p => ({
        title: p.title,
        price: p.price,
        oldPrice: p.oldPrice,
        imageUrl: p.imageUrl,
        badge: p.badge,
        description: `Producto real de Mercado Libre. ${p.badge.includes('OFF') ? '¡Aprovechá el descuento!' : 'Calidad garantizada con los mejores vendedores.'}`,
        link: p.link
      }));
    } else {
      console.log(`   ⚠️  ${products.length} scrapeados pero ninguno pasó los filtros (minPrice: $${cat.minPrice || 0}, excluir: ${(cat.excludeKeywords || []).length} keywords).`);
    }
  }
}

// ── Main ──────────────────────────────────────────
async function main() {
  console.log('🛒 Extrayendo productos reales de Mercado Libre...\n');

  const proxyConfig = parseProxyUrl(process.env.PROXY_URL);
  const launchArgs = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--window-size=1366,768'
  ];
  if (proxyConfig) {
    console.log(`🌐 Usando proxy: ${proxyConfig.server}`);
    launchArgs.push(`--proxy-server=${proxyConfig.server}`);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: launchArgs
  });

  for (let i = 0; i < categories.length; i++) {
    await scrapeCategory(browser, categories[i], proxyConfig);
    if (i < categories.length - 1) {
      const delay = 4000 + Math.floor(Math.random() * 5000);
      console.log(`   ⏳ Esperando ${(delay / 1000).toFixed(1)}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  await browser.close();

  // Mantener fixture anterior para categorías sin resultado nuevo
  let oldFixture = {};
  if (fs.existsSync(FIXTURE_PATH)) {
    try { oldFixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')); } catch (_) {}
  }
  categories.forEach(cat => {
    if (!result[cat.id] && oldFixture[cat.id]) result[cat.id] = oldFixture[cat.id];
  });

  const updated = Object.keys(result).filter(k =>
    result[k].some(p => p.link && p.link.includes('mercadolibre'))
  ).length;

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
