/**
 * Extrae productos REALES de AliExpress para la sección AliExpress de El Podio.
 * Usa puppeteer-extra + stealth plugin (mismo stack que scrape-real-products.js).
 *
 * Ejecutar: node scripts/scrape-aliexpress.js
 * Salida: data/aliexpress_offers.json
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { findBrowser } = require('./browser');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const OUT_PATH = path.join(__dirname, '..', 'data', 'aliexpress_offers.json');

// ── Categorías a buscar (bajo ticket, aptas para envío a Argentina) ──
const QUERIES = [
  { id: 'auriculares',  query: 'auriculares bluetooth in-ear',  maxPrice: 25 },
  { id: 'smartwatch',   query: 'smartwatch reloj inteligente',  maxPrice: 30 },
  { id: 'powerbank',    query: 'power bank 20000mah carga rapida', maxPrice: 30 },
  { id: 'cargador',     query: 'cargador inalambrico fast charge', maxPrice: 25 },
  { id: 'cable',        query: 'cable usb c carga rapida 100w', maxPrice: 15 },
  { id: 'funda',        query: 'funda celular silicona',        maxPrice: 12 },
  { id: 'lampara',      query: 'lampara led escritorio recargable', maxPrice: 25 },
  { id: 'mouse',        query: 'mouse inalambrico ergonomico',  maxPrice: 20 },
  { id: 'teclado',      query: 'teclado bluetooth inalambrico', maxPrice: 25 },
  { id: 'webcam',       query: 'webcam usb 1080p',              maxPrice: 30 },
  { id: 'billetera',    query: 'billetera antirrobo rfid',      maxPrice: 20 },
  { id: 'organizador',  query: 'organizador escritorio',        maxPrice: 25 }
];

// ── Utilidades ───────────────────────────────────
function slugify(q) {
  return q.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function parsePrice(text) {
  if (!text) return null;
  const m = text.replace(/[^\d.,]/g, '').match(/\d+[\.,]?\d*/);
  if (!m) return null;
  return parseFloat(m[0].replace(',', '.'));
}

const result = {};

// ── Scraping de una búsqueda ─────────────────────
async function scrapeQuery(browser, cat) {
  const slug = slugify(cat.query);
  const url = `https://www.aliexpress.com/w/wholesale-${slug}.html?SearchText=${encodeURIComponent(cat.query)}&freeShipping=true`;
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  try {
    console.log(`🔎 ${cat.id}: ${cat.query}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Esperar cards de producto
    await page.waitForSelector('a[href*="/item/"]', { timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 4000)); // dejar cargar precios/imágenes

    const items = await page.evaluate(() => {
      const out = [];
      const anchors = document.querySelectorAll('a[href*="/item/"]');
      for (const a of anchors) {
        const href = a.href || '';
        const id = (href.match(/item\/(\d+)\.html/) || [])[1];
        if (!id || out.some(x => x.itemId === id)) continue;
        const card = a.closest('div') || a;
        // Título: alt de la imagen o texto del card
        const img = card.querySelector('img[src*="alicdn"], img[data-src*="alicdn"]');
        const title = (img && (img.alt || img.getAttribute('data-ellipsis') || '')) ||
          (card.querySelector('[class*="title"]')?.textContent || '');
        // Precio: primer texto con cifra decimal en el card
        let price = null;
        for (const el of card.querySelectorAll('span, div')) {
          const t = (el.textContent || '').trim();
          if (t.length < 30 && /\d+[.,]\d{1,2}/.test(t) && (t.includes('$') || t.includes('US'))) {
            const m = t.match(/\d+[.,]\d{1,2}/);
            if (m) { price = parseFloat(m[0].replace(',', '.')); break; }
          }
        }
        const image = (img && (img.src || img.getAttribute('data-src') || '')) || '';
        if (title && price && image) {
          out.push({ itemId: id, title: title.trim(), price, image, link: `https://www.aliexpress.com/item/${id}.html` });
        }
      }
      return out;
    });

    // Filtros: precio máx, título legible, sin "review" repetido
    const filtered = items
      .filter(p => p.price >= 2 && p.price <= cat.maxPrice)
      .filter(p => p.title.length > 15 && p.title.length < 140)
      .slice(0, 12);

    result[cat.id] = filtered;
    console.log(`   ✅ ${filtered.length} productos (de ${items.length} encontrados)`);
  } catch (e) {
    console.log(`   ⚠️  Error: ${e.message.slice(0, 100)}`);
    result[cat.id] = [];
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Main ─────────────────────────────────────────
async function main() {
  console.log('🛒 Extrayendo productos reales de AliExpress...\n');
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-process',
      '--window-size=1366,768',
      '--lang=es-AR'
    ]
  });

  for (let i = 0; i < QUERIES.length; i++) {
    await scrapeQuery(browser, QUERIES[i]);
    if (i < QUERIES.length - 1) {
      const delay = 5000 + Math.floor(Math.random() * 6000);
      console.log(`   ⏳ Esperando ${(delay / 1000).toFixed(1)}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  await browser.close();

  // Mantener categorías anteriores si una query no dio nada
  let old = {};
  if (fs.existsSync(OUT_PATH)) {
    try { old = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch (_) {}
  }
  QUERIES.forEach(c => {
    if (!result[c.id].length && old[c.id]) result[c.id] = old[c.id];
  });

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2), 'utf8');

  const total = Object.values(result).reduce((a, v) => a + v.length, 0);
  console.log(`\n💾 ${Object.values(result).length} categorías, ${total} productos → data/aliexpress_offers.json`);
  console.log('   Siguiente paso: node scripts/build-aliexpress-page.js');
}

main().catch(err => { console.error('Error fatal:', err); process.exit(1); });
