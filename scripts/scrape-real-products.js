/**
 * Extrae productos REALES de Mercado Libre usando un navegador headless.
 * Ejecutar desde la PC local: node scripts/scrape-real-products.js
 *
 * Esto actualiza products-fixture.json con productos, precios, imágenes
 * y links reales. Luego ejecutá node scripts/generate-cache.js para
 * regenerar cache.html, y commiteá + pusheá.
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const FIXTURE_PATH = path.join(__dirname, '..', 'products-fixture.json');
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// Leer categorías de config.json
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const categories = config.categories;

const result = {};

async function scrapeCategory(browser, cat) {
  const url = `https://listado.mercadolibre.com.ar/${encodeURIComponent(cat.query)}`;
  console.log(`🔍 ${cat.icon} ${cat.name}...`);

  const page = await browser.newPage();

  // Configurar para parecer un navegador real
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'es-AR,es;q=0.9',
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Esperar a que los productos aparezcan
    await page.waitForSelector('.ui-search-layout__item, .poly-card, .ui-search-result__wrapper', { timeout: 10000 });

    // Extraer datos de los productos
    const products = await page.evaluate(() => {
      const items = [];

      // Probar varios selectores (Meli cambia el markup)
      const selectors = ['.ui-search-layout__item', '.poly-card', '.ui-search-result__wrapper'];
      let cards = [];
      for (const sel of selectors) {
        cards = document.querySelectorAll(sel);
        if (cards.length > 0) break;
      }

      // Obtener los primeros 3 productos
      for (let i = 0; i < Math.min(cards.length, 3); i++) {
        const el = cards[i];

        // Título
        const titleEl = el.querySelector('h2') || el.querySelector('.ui-search-item__title') || el.querySelector('.poly-component__title');
        const title = titleEl ? titleEl.textContent.trim() : '';
        if (!title) continue;

        // Link
        const linkEl = el.querySelector('a');
        let link = linkEl ? linkEl.href : '';
        if (link && !link.startsWith('http')) link = 'https://www.mercadolibre.com.ar' + link;
        // Limpiar parámetros de tracking
        link = link.split('?')[0];

        // Imagen
        const imgEl = el.querySelector('img');
        let imageUrl = '';
        if (imgEl) {
          imageUrl = imgEl.dataset.src || imgEl.src || '';
          // Intentar obtener versión de alta calidad
          if (imageUrl.endsWith('-I.jpg')) imageUrl = imageUrl.replace('-I.jpg', '-O.jpg');
        }

        // Precio actual
        const priceEl = el.querySelector('.price-tag-fraction') || el.querySelector('.andes-money-amount__fraction');
        let price = 0;
        if (priceEl) {
          price = parseInt(priceEl.textContent.replace(/\D/g, '')) || 0;
        }

        // Precio anterior (descuento)
        const oldPriceEl = el.querySelector('.price-tag-line-through') || el.querySelector('s .price-tag-fraction');
        let oldPrice = null;
        if (oldPriceEl) {
          oldPrice = parseInt(oldPriceEl.textContent.replace(/\D/g, '')) || null;
        }

        // Cuotas
        const installmentsEl = el.querySelector('.ui-search-installments') || el.querySelector('.poly-price__installments');
        let installmentsText = 'Comprar en Mercado Libre';
        if (installmentsEl) {
          installmentsText = installmentsEl.textContent.trim();
        }

        // Badge (descuento o destacado)
        let badge = 'Destacado';
        if (oldPrice && price && oldPrice > price) {
          const pct = Math.round(((oldPrice - price) / oldPrice) * 100);
          if (pct > 0) badge = `${pct}% OFF`;
        }

        // Descripción corta
        const description = `Producto real de Mercado Libre en la categoría. ${badge.includes('OFF') ? 'Aprovechá el descuento por tiempo limitado.' : 'Calidad garantizada con los mejores vendedores.'}`;

        items.push({
          title,
          price: price || 99999,
          oldPrice,
          imageUrl,
          badge,
          description,
          link
        });

        if (items.length >= 3) break;
      }

      return items;
    });

    if (products.length > 0) {
      console.log(`   ✅ ${products.length} productos extraídos`);
      result[cat.id] = products.map(p => ({
        title: p.title,
        price: p.price,
        oldPrice: p.oldPrice,
        imageUrl: p.imageUrl,
        badge: p.badge,
        description: p.description,
        link: p.link
      }));
    } else {
      console.log(`   ⚠️  0 productos. Se mantiene el fixture actual.`);
    }

  } catch (err) {
    console.log(`   ❌ Error: ${err.message}`);
  } finally {
    await page.close();
  }
}

async function main() {
  console.log('🛒 Iniciando extracción de productos reales de Mercado Libre...\n');
  console.log('   Esto abre un navegador y navega por 20 categorías.');
  console.log('   Puede tardar 1-2 minutos.\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  for (let i = 0; i < categories.length; i++) {
    await scrapeCategory(browser, categories[i]);
    // Pausa entre categorías para no saturar
    if (i < categories.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  await browser.close();

  // Guardar resultados
  if (Object.keys(result).length > 0) {
    // Mantener categorías sin resultados con el fixture anterior
    let oldFixture = {};
    if (fs.existsSync(FIXTURE_PATH)) {
      try { oldFixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')); } catch (_) {}
    }

    categories.forEach(cat => {
      if (!result[cat.id]) {
        // Usar datos anteriores si existen
        if (oldFixture[cat.id]) result[cat.id] = oldFixture[cat.id];
      }
    });

    fs.writeFileSync(FIXTURE_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(`\n💾 Guardado en products-fixture.json (${Object.keys(result).length} categorías)`);

    console.log('\n📋 Siguientes pasos:');
    console.log('   1. node scripts/generate-cache.js');
    console.log('   2. git add cache.html products-fixture.json');
    console.log('   3. git commit -m "productos reales actualizados"');
    console.log('   4. git push');
  } else {
    console.log('\n❌ No se pudo extraer ningún producto. Probá más tarde.');
  }
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
