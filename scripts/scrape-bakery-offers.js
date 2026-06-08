/**
 * BUSCADOR DE OFERTAS DE PANADERÍA — "Medialunas & Facturas"
 *
 * Busca las 3 mejores ofertas de medialunas o facturas de panaderías
 * y restaurantes en Argentina. Extrae precio, origen y foto.
 *
 * Estrategia:
 *   1. Puppeteer → busca en Google Argentina con múltiples queries
 *   2. Extrae snippets, títulos y URLs de los resultados
 *   3. DeepSeek/Gemini AI → parsea el texto no estructurado a JSON (nombre, precio, ubicación)
 *   4. Imagen → intenta extraer del sitio de la panadería, fallback a Unsplash
 *   5. Guarda las 3 mejores ofertas en bakery-offers.json
 *
 * Ejecutar: node scripts/scrape-bakery-offers.js
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

puppeteer.use(StealthPlugin());
require('dotenv').config({ override: true });

const OUTPUT_PATH = path.join(__dirname, '..', 'bakery-offers.json');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ── Queries para buscar ofertas de panadería en CABA ──
const SEARCH_QUERIES = [
  'docena de medialunas delivery CABA oferta',
  'facturas medialunas envio Capital Federal panaderia',
  'promo medialunas docena delivery zona norte sur CABA',
  'panaderia delivery CABA medialunas facturas precio',
  'docena facturas envio gratis Capital Federal',
  'medialunas manteca delivery capital federal oferta',
];

// ── Helpers ──
function log(msg) {
  const ts = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Extraer datos de múltiples buscadores ──
async function searchDuckDuckGo(browser, query) {
  const page = await browser.newPage();
  const results = [];
  try {
    await page.setViewport({ width: 1366, height: 900 });
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query + ' argentina')}`;
    log(`   🦆 DuckDuckGo: "${query}"`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const snippets = await page.evaluate(() => {
      const items = [];
      const cards = document.querySelectorAll('.result, .web-result');
      for (const card of cards) {
        const titleEl = card.querySelector('.result__title, .result__a');
        const title = titleEl ? titleEl.textContent.trim() : '';
        const snippetEl = card.querySelector('.result__snippet');
        const snippet = snippetEl ? snippetEl.textContent.trim() : '';
        const linkEl = card.querySelector('.result__url, .result__title a');
        const link = linkEl ? linkEl.href || linkEl.getAttribute('href') : '';
        if (title || snippet) {
          items.push({ title, snippet, link, imageUrl: '' });
          if (items.length >= 10) break;
        }
      }
      return items;
    });
    results.push(...snippets);
    log(`      📄 ${snippets.length} resultados`);
  } catch (err) {
    log(`      ⚠️  DuckDuckGo: ${err.message}`);
  } finally {
    try { await page.close(); } catch (_) {}
  }
  return results;
}

async function searchBing(browser, query) {
  const page = await browser.newPage();
  const results = [];
  try {
    await page.setViewport({ width: 1366, height: 900 });
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query + ' argentina')}&cc=ar&setlang=es`;
    log(`   🔵 Bing: "${query}"`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const snippets = await page.evaluate(() => {
      const items = [];
      const cards = document.querySelectorAll('li.b_algo, li.b_ans');
      for (const card of cards) {
        const titleEl = card.querySelector('h2 a, h2');
        const title = titleEl ? titleEl.textContent.trim() : '';
        const snippetEl = card.querySelector('.b_caption p, .b_lineclamp2');
        const snippet = snippetEl ? snippetEl.textContent.trim() : '';
        const linkEl = card.querySelector('h2 a');
        const link = linkEl ? linkEl.href : '';
        const imgEl = card.querySelector('img');
        const imageUrl = imgEl ? (imgEl.src || '') : '';
        if (title || snippet) {
          items.push({ title, snippet, link, imageUrl });
          if (items.length >= 10) break;
        }
      }
      return items;
    });
    results.push(...snippets);
    log(`      📄 ${snippets.length} resultados`);
  } catch (err) {
    log(`      ⚠️  Bing: ${err.message}`);
  } finally {
    try { await page.close(); } catch (_) {}
  }
  return results;
}

async function searchGoogle(browser, query) {
  // Google solo como fallback — tiene anti-bot agresivo
  const page = await browser.newPage();
  const results = [];
  try {
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    const url = `https://www.google.com/search?q=${encodeURIComponent(query + ' argentina')}&hl=es-AR&gl=AR&num=10`;
    log(`   🔍 Google: "${query}"`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Ver si nos bloquearon
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
    if (bodyText.includes('consent.google') || bodyText.includes('Before you continue') || bodyText.includes('not a robot')) {
      log('      ⚠️  Google pide CAPTCHA/consent. Saltando.');
      try { await page.close(); } catch (_) {}
      return results;
    }

    const snippets = await page.evaluate(() => {
      const items = [];
      const cards = document.querySelectorAll('div.g, div.MjjYud');
      for (const card of cards) {
        const titleEl = card.querySelector('h3');
        const title = titleEl ? titleEl.textContent.trim() : '';
        const snippetEl = card.querySelector('div[data-sncf], span.aCOpRe, div.VwiC3b');
        const snippet = snippetEl ? snippetEl.textContent.trim() : '';
        const linkEl = card.querySelector('a[href*="http"]');
        const link = linkEl ? linkEl.href : '';
        if (title || snippet) {
          items.push({ title, snippet, link, imageUrl: '' });
          if (items.length >= 10) break;
        }
      }
      return items;
    });
    results.push(...snippets);
    log(`      📄 ${snippets.length} resultados`);
  } catch (err) {
    log(`      ⚠️  Google: ${err.message}`);
  } finally {
    try { await page.close(); } catch (_) {}
  }
  return results;
}

// ── Buscar en todos los motores ──
async function searchAllEngines(browser, query) {
  // Prioridad: DuckDuckGo → Bing → Google (menos a más agresivo anti-bot)
  let results = await searchDuckDuckGo(browser, query);
  if (results.length < 5) {
    const bingResults = await searchBing(browser, query);
    results = results.concat(bingResults);
  }
  if (results.length < 5) {
    const googleResults = await searchGoogle(browser, query);
    results = results.concat(googleResults);
  }
  return results;
}

// ── Extraer imagen de la página de la panadería ──
async function extractImageFromPage(browser, url) {
  if (!url || !url.startsWith('http')) return null;

  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });

    const imageUrl = await page.evaluate(() => {
      // Buscar imágenes relevantes (producto, hero, galería)
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage && ogImage.content) return ogImage.content;

      // Buscar imágenes grandes (posiblemente de producto)
      const imgs = [...document.querySelectorAll('img')]
        .filter(img => img.naturalWidth > 300 || img.width > 300)
        .sort((a, b) => {
          const aSize = (a.naturalWidth || a.width || 0) * (a.naturalHeight || a.height || 0);
          const bSize = (b.naturalWidth || b.width || 0) * (b.naturalHeight || b.height || 0);
          return bSize - aSize;
        });

      if (imgs.length > 0) {
        return imgs[0].src || imgs[0].dataset?.src || '';
      }
      return null;
    });

    return imageUrl || null;
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

// ── Parser con DeepSeek API ──
async function parseWithDeepSeek(allSnippets) {
  const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
  if (!DEEPSEEK_KEY) return null;

  const textToAnalyze = allSnippets
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet}\nLink: ${s.link}`)
    .join('\n\n')
    .substring(0, 8000); // No exceder contexto

  const prompt = `Analizá estos resultados de búsqueda sobre ofertas de MEDIALUNAS y FACTURAS con DELIVERY en CABA (Capital Federal), Argentina.

Encontrá las 3 MEJORES OFERTAS que tengan ENVÍO A TODO CABA y devolvé SOLO este JSON (sin explicaciones):

[
  {
    "bakery": "Nombre real de la panadería",
    "product": "Ej: Docena de Medialunas de Manteca",
    "price": 4500,
    "oldPrice": 5800,
    "description": "1-2 líneas tentadoras, mencioná que hacen envíos a todo CABA",
    "location": "Barrio, CABA (ej: Palermo, Belgrano, Caballito)",
    "installments": "Envío a todo CABA | Delivery en 45 min",
    "link": "URL real del resultado",
    "badge": "Mejor Precio",
    "precio_estimado": false
  }
]

Reglas CRÍTICAS:
- SOLO panaderías que hagan DELIVERY/ENVÍO a todo CABA o Capital Federal.
- Si la panadería no hace envíos, DESCARTALA.
- Precios en PESOS ARGENTINOS. Extraé el número de "$4500", "$4.500", "ARS 4500".
- SOLO productos de panadería: medialunas (docena) o facturas (kg/docena).
- Si no hay info de delivery, precio_estimado: true.
- Si no hay 3 ofertas con delivery, devolvé las que tengan.

Resultados:\n${textToAnalyze}`;

  try {
    const axios = require('axios');
    const res = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1500
    }, {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 25000
    });

    const text = res.data.choices[0].message.content.trim();
    // Extraer JSON del response (puede tener markdown)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        log(`   🤖 DeepSeek extrajo ${parsed.length} ofertas.`);
        return parsed.slice(0, 3);
      }
    }
    return null;
  } catch (err) {
    log(`   ⚠️  DeepSeek: ${err.message}`);
    return null;
  }
}

// ── Parser con Gemini (fallback) ──
async function parseWithGemini(allSnippets) {
  if (!GEMINI_API_KEY) return null;

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

  const textToAnalyze = allSnippets
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet}\nLink: ${s.link}`)
    .join('\n\n')
    .substring(0, 8000);

  const prompt = `Analizá estos resultados de búsqueda sobre ofertas de MEDIALUNAS y FACTURAS con DELIVERY EN CABA. Encontrá las 3 MEJORES OFERTAS que hagan envíos a Capital Federal. Devolvé SOLO este JSON (sin explicaciones): [{"bakery":"nombre","product":"desc","price":4500,"oldPrice":5800,"description":"1-2 lineas","location":"Barrio, CABA","installments":"Envío a todo CABA","link":"url","badge":"Mejor Precio","precio_estimado":false}]. SOLO panaderías con delivery a CABA. Precios en PESOS ARGENTINOS.\n\nResultados:\n${textToAnalyze}`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    });

    const responseText = result.response.text().trim();
    const parsed = JSON.parse(responseText);

    if (Array.isArray(parsed) && parsed.length > 0) {
      log(`   🤖 Gemini extrajo ${parsed.length} ofertas.`);
      return parsed.slice(0, 3);
    }
    return null;
  } catch (err) {
    log(`   ⚠️  Gemini: ${err.message}`);
    return null;
  }
}

// ── Parser combinado: DeepSeek → Gemini → fallback ──
async function parseWithAI(allSnippets) {
  // 1. Intentar DeepSeek (más barato, sin quota issues)
  const deepseekResult = await parseWithDeepSeek(allSnippets);
  if (deepseekResult) return deepseekResult;

  // 2. Intentar Gemini
  const geminiResult = await parseWithGemini(allSnippets);
  if (geminiResult) return geminiResult;

  // 3. Fallback: no se pudo parsear con ninguna IA
  return null;
}

// ── Imagen fallback de Unsplash ──
function getUnsplashFallback(productType) {
  // Imágenes de medialunas y facturas argentinas en Unsplash
  const fallbacks = {
    medialunas: [
      'https://images.unsplash.com/photo-1555507036-ab1f4038024a?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1509365465985-25d11c17e812?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1517433670267-08bbd4be890f?w=600&h=600&fit=crop',
    ],
    facturas: [
      'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1499636136210-6f4ee915583e?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1608198093002-ad4eef4f05e6?w=600&h=600&fit=crop',
    ],
    generica: [
      'https://images.unsplash.com/photo-1517244683847-7456f63b1c0a?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1605478371310-a9f58e20f8ef?w=600&h=600&fit=crop',
    ]
  };

  const key = productType.includes('medialuna') ? 'medialunas'
    : productType.includes('factura') ? 'facturas'
    : 'generica';

  const pool = fallbacks[key];
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Pipeline de imagen: scrapeada → Unsplash ──
async function resolveImages(browser, offers) {
  for (const offer of offers) {
    if (offer.imageUrl && offer.imageUrl.startsWith('http')) {
      log(`   🖼️  ${offer.bakery}: ya tiene imagen.`);
      continue;
    }

    // Intentar extraer imagen del link de la panadería
    if (offer.link && offer.link.startsWith('http')) {
      log(`   🔍 Buscando imagen en ${offer.bakery}...`);
      const extracted = await extractImageFromPage(browser, offer.link);
      if (extracted) {
        offer.imageUrl = extracted;
        log(`   ✅ Imagen encontrada para ${offer.bakery}`);
        continue;
      }
    }

    // Fallback a Unsplash
    const fallback = getUnsplashFallback(offer.product || '');
    offer.imageUrl = fallback;
    log(`   📸 Imagen Unsplash asignada a ${offer.bakery}`);
  }
  return offers;
}

// ── Limpiar URLs de DuckDuckGo (extraer URL real del redirect) ──
function cleanUrl(url) {
  if (!url) return 'https://pedidosya.com.ar';
  // DuckDuckGo redirect: extraer uddg param
  const ddgMatch = url.match(/uddg=([^&]+)/);
  if (ddgMatch) {
    try { return decodeURIComponent(ddgMatch[1]); } catch { return url; }
  }
  // Si ya es URL directa, devolverla
  if (url.startsWith('http')) return url;
  return 'https://pedidosya.com.ar';
}

// ── Validar y enriquecer ofertas ──
function enrichOffers(offers) {
  return offers.map((offer, i) => {
    // Generar rating determinístico basado en el nombre
    const seed = offer.bakery + offer.product;
    let hash = 0;
    for (let j = 0; j < seed.length; j++) {
      hash = ((hash << 5) - hash) + seed.charCodeAt(j);
      hash |= 0;
    }
    const rating = Math.round((4.0 + (Math.abs(hash) % 15) / 10) * 10) / 10;
    const reviews = 80 + (Math.abs(hash) % 420);

    return {
      id: `bakery_${i + 1}`,
      bakery: offer.bakery || 'Panadería Artesanal',
      product: offer.product || 'Docena de Medialunas',
      price: offer.price || 4500,
      oldPrice: offer.oldPrice || null,
      description: offer.description || 'Elaboradas con ingredientes de primera calidad. Crujientes por fuera, esponjosas por dentro.',
      location: offer.location || 'Capital Federal',
      installments: offer.installments || 'Envío a todo CABA',
      imageUrl: offer.imageUrl || '',
      link: cleanUrl(offer.link),
      badge: offer.badge || 'Destacado',
      precio_estimado: offer.precio_estimado || false,
      rating,
      reviews,
      sites: ['elpodiofood']
    };
  });
}

// ── Generar datos de ejemplo (último recurso si todo falla) ──
function generateFallbackOffers() {
  log('⚠️  Generando ofertas de ejemplo (fallback). Los precios son estimados.');
  return [
    {
      id: 'bakery_1',
      bakery: 'Panadería La Argentina',
      product: 'Docena de Medialunas de Grasa',
      price: 4200,
      oldPrice: 5500,
      description: 'Medialunas doradas y crocantes, recién horneadas cada mañana. Con el sabor inconfundible de la panadería argentina tradicional.',
      location: 'Caballito, CABA',
      installments: 'Envío a todo CABA sin cargo',
      imageUrl: 'https://images.unsplash.com/photo-1555507036-ab1f4038024a?w=600&h=600&fit=crop',
      link: 'https://pedidosya.com.ar',
      badge: 'Mejor Precio',
      precio_estimado: true,
      rating: 4.7,
      reviews: 340,
      sites: ['elpodiofood']
    },
    {
      id: 'bakery_2',
      bakery: 'Confitería Del Molino',
      product: '½ Kg de Facturas Surtidas',
      price: 3800,
      oldPrice: 4800,
      description: 'Facturas recién horneadas con membrillo, crema pastelera y dulce de leche. Envíos a toda Capital Federal.',
      location: 'San Telmo, CABA',
      installments: 'Envío a todo CABA en 45 min',
      imageUrl: 'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=600&h=600&fit=crop',
      link: 'https://pedidosya.com.ar',
      badge: 'Más Vendido',
      precio_estimado: true,
      rating: 4.5,
      reviews: 215,
      sites: ['elpodiofood']
    },
    {
      id: 'bakery_3',
      bakery: 'Panadería El Buen Gusto',
      product: 'Combo Medialunas + Facturas (Docena Mixta)',
      price: 5500,
      oldPrice: 7200,
      description: '6 medialunas de manteca + 6 facturas a elección. Delivery a todo CABA sin cargo.',
      location: 'Palermo, CABA',
      installments: 'Envío a todo CABA en 30 min',
      imageUrl: 'https://images.unsplash.com/photo-1517244683847-7456f63b1c0a?w=600&h=600&fit=crop',
      link: 'https://pedidosya.com.ar',
      badge: 'Delivery Gratis',
      precio_estimado: true,
      rating: 4.8,
      reviews: 520,
      sites: ['elpodiofood']
    }
  ];
}

// ── MAIN ──
async function main() {
  log('🥐 INICIANDO BÚSQUEDA DE OFERTAS DE PANADERÍA...\n');

  // Verificar API keys
  if (!GEMINI_API_KEY && !process.env.DEEPSEEK_API_KEY) {
    log('⚠️  Ni GEMINI_API_KEY ni DEEPSEEK_API_KEY configuradas en .env.');
    log('   Se usarán datos de ejemplo. Agregá una API key para scraping real.\n');
  }

  // ── Paso 1: Scraping con Puppeteer ──
  log('── Paso 1/4: Buscando en Google Argentina ──');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1366,900'
    ]
  });

  let allResults = [];
  for (const query of SEARCH_QUERIES) {
    const results = await searchAllEngines(browser, query);
    allResults.push(...results);
    await sleep(1500); // Delay entre búsquedas
  }

  // Dedeuplicar por link
  const seen = new Set();
  allResults = allResults.filter(r => {
    if (!r.link || seen.has(r.link)) return false;
    seen.add(r.link);
    return true;
  });

  log(`\n📊 Total resultados únicos: ${allResults.length}`);

  // ── Paso 2: Parsear con IA (DeepSeek → Gemini → fallback) ──
  log('\n── Paso 2/4: Analizando resultados con IA ──');
  let offers = null;
  if (allResults.length > 0) {
    offers = await parseWithAI(allResults);
  }

  // ── Paso 3: Enriquecer y resolver imágenes ──
  log('\n── Paso 3/4: Resolviendo imágenes ──');
  if (offers && offers.length > 0) {
    offers = enrichOffers(offers);
  } else {
    log('   ⚠️  No se pudieron extraer ofertas reales. Usando fallback.');
    offers = generateFallbackOffers();
  }

  await resolveImages(browser, offers);
  await browser.close();

  // ── Paso 4: Guardar ──
  log('\n── Paso 4/4: Guardando bakery-offers.json ──');
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(offers, null, 2), 'utf8');

  log('\n═══════════════════════════════════════');
  log('✅ Ofertas de panadería actualizadas:');
  offers.forEach((o, i) => {
    const estimado = o.precio_estimado ? ' ⚠️(precio estimado)' : '';
    log(`   ${i + 1}. ${o.bakery} — ${o.product}`);
    log(`      💵 $${o.price}${o.oldPrice ? ` (antes $${o.oldPrice})` : ''} | 📍 ${o.location}${estimado}`);
    log(`      🖼️  ${o.imageUrl ? 'Imagen OK' : 'Sin imagen'}`);
  });
  log('═══════════════════════════════════════');
}

main().catch(err => {
  console.error('❌ Error crítico:', err.message);
  process.exit(1);
});
