/**
 * BUSCADOR DE PRODUCTOS PARA EVENTO EXPRESS — "Especial Día del Padre" (rotativo)
 *
 * Busca los 3 mejores productos para el evento activo definido en express-events.json.
 * Usa la misma estrategia que scrape-bakery-offers.js:
 *   1. Puppeteer → busca en DuckDuckGo/Bing/Google con queries del evento
 *   2. Extrae snippets, títulos y URLs de los resultados
 *   3. DeepSeek/Gemini AI → parsea el texto no estructurado a JSON
 *   4. Imagen → intenta extraer del sitio del producto, fallback a Unsplash
 *   5. Guarda las 3 mejores ofertas en express-offers.json
 *
 * Integrado al pipeline principal (auto-update.js).
 * Ejecutar: node scripts/scrape-express-event.js
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

puppeteer.use(StealthPlugin());
require('dotenv').config({ override: true });

const OUTPUT_PATH = path.join(__dirname, '..', 'express-offers.json');
const EVENTS_PATH = path.join(__dirname, '..', 'express-events.json');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// ── Helpers ──
function log(msg) {
  const ts = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function cleanUrl(url) {
  if (!url) return '';
  const ddgMatch = url.match(/uddg=([^&]+)/);
  if (ddgMatch) {
    try { return decodeURIComponent(ddgMatch[1]); } catch { return url; }
  }
  if (url.startsWith('http')) return url;
  return '';
}

// ── Cargar evento activo ──
function getActiveEvent() {
  if (!fs.existsSync(EVENTS_PATH)) {
    log('⚠️  express-events.json no encontrado. Usando evento fallback.');
    return null;
  }
  try {
    const config = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
    const activeId = config.active;
    const event = config.events[activeId];
    if (!event) {
      log(`⚠️  Evento "${activeId}" no encontrado en express-events.json.`);
      return null;
    }

    // Verificar fechas
    const now = new Date().toISOString().split('T')[0];
    if (event.start_date && event.start_date > now) {
      log(`⚠️  Evento "${event.name}" empieza el ${event.start_date}. Aún no activo (hoy: ${now}).`);
      return null;
    }
    if (event.end_date && event.end_date < now) {
      log(`⚠️  Evento "${event.name}" terminó el ${event.end_date}. Expirado (hoy: ${now}).`);
      return null;
    }

    log(`📅 Evento activo: "${event.name}" (${event.start_date} → ${event.end_date})`);
    return { id: activeId, ...event };
  } catch (err) {
    log(`❌ Error al leer express-events.json: ${err.message}`);
    return null;
  }
}

// ── Buscadores ──
async function searchDuckDuckGo(browser, query) {
  const page = await browser.newPage();
  const results = [];
  try {
    await page.setViewport({ width: 1366, height: 900 });
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query + ' argentina mercadolibre')}`;
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
    log(`      ⚠️  Bing: ${err.message}`);
  } finally {
    try { await page.close(); } catch (_) {}
  }
  return results;
}

async function searchGoogle(browser, query) {
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

async function searchAllEngines(browser, query) {
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

// ── Extraer imagen de la página del producto ──
async function extractImageFromPage(browser, url) {
  if (!url || !url.startsWith('http')) return null;
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });

    const imageUrl = await page.evaluate(() => {
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage && ogImage.content) return ogImage.content;

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

// ── Parser con DeepSeek ──
async function parseWithDeepSeek(allSnippets, event) {
  if (!DEEPSEEK_API_KEY) return null;

  const textToAnalyze = allSnippets
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet}\nLink: ${s.link}`)
    .join('\n\n')
    .substring(0, 8000);

  const today = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

  const prompt = `Analizá estos resultados de búsqueda sobre "${event.name}" en Mercado Libre Argentina.

El evento es: ${event.name} — ${event.slogan}
Fecha actual: ${today}

Encontrá los 3 MEJORES PRODUCTOS para regalar en este evento. Devolvé SOLO este JSON (sin explicaciones):

[
  {
    "product": "Nombre real del producto (ej: Kit de Herramientas Stanley 65 piezas)",
    "price": 45999,
    "oldPrice": 58999,
    "description": "1-2 líneas tentadoras explicando por qué es el regalo ideal para esta ocasión",
    "category": "Herramientas | Tecnología | Perfumería | Indumentaria | etc.",
    "link": "URL real del resultado de Mercado Libre",
    "badge": "Ideal para Papá",
    "precio_estimado": false
  }
]

Reglas CRÍTICAS:
- SOLO productos de Mercado Libre Argentina (articulo.mercadolibre.com.ar o listado.mercadolibre.com.ar).
- Si no es de Mercado Libre, DESCARTALO.
- Precios en PESOS ARGENTINOS. Extraé el número de "$45000", "$45.000", "ARS 45999".
- Productos variados: no repitas el mismo tipo de producto. Ideal: 1 tecnología, 1 indumentaria/accesorio, 1 herramienta/perfume.
- Precios realistas para Argentina (junio 2026).
- Si no hay precio claro, precio_estimado: true.
- Si no hay 3 productos de Mercado Libre, devolvé los que encuentres.

Resultados:\n${textToAnalyze}`;

  try {
    const res = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1500
    }, {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 25000
    });

    const text = res.data.choices[0].message.content.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        log(`   🤖 DeepSeek extrajo ${parsed.length} productos.`);
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
async function parseWithGemini(allSnippets, event) {
  if (!GEMINI_API_KEY) return null;

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const textToAnalyze = allSnippets
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet}\nLink: ${s.link}`)
    .join('\n\n')
    .substring(0, 8000);

  const prompt = `Analizá estos resultados de búsqueda sobre "${event.name}" en Mercado Libre Argentina. Encontrá los 3 MEJORES PRODUCTOS para regalar. Devolvé SOLO este JSON (sin explicaciones): [{"product":"nombre","price":45999,"oldPrice":58999,"description":"1-2 lineas","category":"categoria","link":"url","badge":"Ideal para Papa","precio_estimado":false}]. SOLO productos de Mercado Libre Argentina. Precios en PESOS ARGENTINOS. Productos variados.\n\nResultados:\n${textToAnalyze}`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    });

    const responseText = result.response.text().trim();
    const parsed = JSON.parse(responseText);

    if (Array.isArray(parsed) && parsed.length > 0) {
      log(`   🤖 Gemini extrajo ${parsed.length} productos.`);
      return parsed.slice(0, 3);
    }
    return null;
  } catch (err) {
    log(`   ⚠️  Gemini: ${err.message}`);
    return null;
  }
}

async function parseWithAI(allSnippets, event) {
  const deepseekResult = await parseWithDeepSeek(allSnippets, event);
  if (deepseekResult) return deepseekResult;

  const geminiResult = await parseWithGemini(allSnippets, event);
  if (geminiResult) return geminiResult;

  return null;
}

// ── Imagen fallback de Unsplash ──
function getUnsplashFallback(category) {
  const fallbacks = {
    tecnologia: [
      'https://images.unsplash.com/photo-1468495244123-6c6c332eeece?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1550009158-9ebf69173e03?w=600&h=600&fit=crop',
    ],
    herramientas: [
      'https://images.unsplash.com/photo-1581783898377-1c85bf937427?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1530124566582-a618bc2615dc?w=600&h=600&fit=crop',
    ],
    perfumeria: [
      'https://images.unsplash.com/photo-1541643600914-78b084683601?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1523293182086-7651a899d37f?w=600&h=600&fit=crop',
    ],
    indumentaria: [
      'https://images.unsplash.com/photo-1556905055-8f358a7a47b2?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1489987707025-afc232f7ea0f?w=600&h=600&fit=crop',
    ],
    generica: [
      'https://images.unsplash.com/photo-1607083206869-4c7672e72a8a?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1607344645866-009c320b63e4?w=600&h=600&fit=crop',
    ]
  };

  const cat = (category || '').toLowerCase();
  const key = cat.includes('tecnolog') ? 'tecnologia'
    : cat.includes('herramienta') ? 'herramientas'
    : cat.includes('perfume') || cat.includes('perfumer') ? 'perfumeria'
    : cat.includes('indumentaria') || cat.includes('ropa') ? 'indumentaria'
    : 'generica';

  const pool = fallbacks[key];
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Resolver imágenes ──
async function resolveImages(browser, offers) {
  for (const offer of offers) {
    if (offer.imageUrl && offer.imageUrl.startsWith('http')) {
      log(`   🖼️  ${offer.product}: ya tiene imagen.`);
      continue;
    }

    if (offer.link && offer.link.startsWith('http')) {
      log(`   🔍 Buscando imagen para "${offer.product}"...`);
      const extracted = await extractImageFromPage(browser, offer.link);
      if (extracted) {
        offer.imageUrl = extracted;
        log(`   ✅ Imagen encontrada.`);
        continue;
      }
    }

    const fallback = getUnsplashFallback(offer.category || '');
    offer.imageUrl = fallback;
    log(`   📸 Imagen Unsplash asignada.`);
  }
  return offers;
}

// ── Enriquecer ofertas ──
function enrichOffers(offers, event) {
  return offers.map((offer, i) => {
    const seed = (offer.product || '') + (offer.category || '') + i;
    let hash = 0;
    for (let j = 0; j < seed.length; j++) {
      hash = ((hash << 5) - hash) + seed.charCodeAt(j);
      hash |= 0;
    }
    const rating = Math.round((4.0 + (Math.abs(hash) % 15) / 10) * 10) / 10;
    const reviews = 120 + (Math.abs(hash) % 380);
    const full = Math.floor(rating);
    const half = rating - full >= 0.5 ? 1 : 0;
    const empty = 5 - full - half;
    const starsHtml = '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);

    return {
      id: `express_${i + 1}`,
      product: offer.product || 'Producto Destacado',
      price: offer.price || 35000,
      oldPrice: offer.oldPrice || null,
      description: offer.description || `El regalo perfecto para este ${event.name}. Calidad garantizada con envío a todo el país.`,
      category: offer.category || 'Producto',
      installments: offer.installments || 'Hasta 12 cuotas sin interés',
      imageUrl: offer.imageUrl || '',
      link: cleanUrl(offer.link) || `https://listado.mercadolibre.com.ar/${encodeURIComponent(event.searchTerms?.[0] || 'regalo')}`,
      badge: offer.badge || event.badge || 'Destacado',
      precio_estimado: offer.precio_estimado || false,
      rating,
      reviews,
      starsHtml,
      eventId: event.id,
      eventName: event.name
    };
  });
}

// ── Fallback ──
function generateFallbackOffers(event) {
  log('⚠️  Generando productos de ejemplo (fallback). Los precios son estimados.');

  const fallbacksByEvent = {
    dia_del_padre_2026: [
      {
        id: 'express_1',
        product: 'Kit de Herramientas Stanley 65 Piezas',
        price: 45999,
        oldPrice: 58999,
        description: 'El regalo que todo papá necesita. Maletín completo con herramientas de alta calidad. Ideal para el hogar y el taller.',
        category: 'Herramientas',
        installments: 'Hasta 12 cuotas sin interés',
        imageUrl: 'https://images.unsplash.com/photo-1581783898377-1c85bf937427?w=600&h=600&fit=crop',
        link: 'https://listado.mercadolibre.com.ar/herramientas-stanley',
        badge: 'Ideal para Papá',
        precio_estimado: true,
        rating: 4.8,
        reviews: 523,
        starsHtml: '★★★★★',
        eventId: 'dia_del_padre_2026',
        eventName: 'Especial Día del Padre'
      },
      {
        id: 'express_2',
        product: 'Smartwatch Samsung Galaxy Watch 6',
        price: 189999,
        oldPrice: 249999,
        description: 'Tecnología de punta para papá. Monitor cardíaco, GPS, resistente al agua y más de 90 modos deportivos.',
        category: 'Tecnología',
        installments: 'Hasta 18 cuotas sin interés',
        imageUrl: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&h=600&fit=crop',
        link: 'https://listado.mercadolibre.com.ar/samsung-galaxy-watch',
        badge: 'Top en Tecnología',
        precio_estimado: true,
        rating: 4.7,
        reviews: 892,
        starsHtml: '★★★★½',
        eventId: 'dia_del_padre_2026',
        eventName: 'Especial Día del Padre'
      },
      {
        id: 'express_3',
        product: 'Perfume Paco Rabanne Invictus 100ml',
        price: 89999,
        oldPrice: 119999,
        description: 'Fragancia icónica para el hombre ganador. Notas frescas de pomelo y laurel con fondo amaderado. Regalo clásico que nunca falla.',
        category: 'Perfumería',
        installments: 'Hasta 6 cuotas sin interés',
        imageUrl: 'https://images.unsplash.com/photo-1541643600914-78b084683601?w=600&h=600&fit=crop',
        link: 'https://listado.mercadolibre.com.ar/perfume-paco-rabanne-invictus',
        badge: 'Regalo Clásico',
        precio_estimado: true,
        rating: 4.9,
        reviews: 1205,
        starsHtml: '★★★★★',
        eventId: 'dia_del_padre_2026',
        eventName: 'Especial Día del Padre'
      }
    ]
  };

  const eventFallbacks = fallbacksByEvent[event.id] || [
    {
      id: 'express_1',
      product: 'Producto Destacado 1',
      price: 35000,
      oldPrice: 49999,
      description: `El regalo perfecto para ${event.name}. Calidad premium con envío a todo el país.`,
      category: 'Destacado',
      installments: 'Hasta 12 cuotas sin interés',
      imageUrl: 'https://images.unsplash.com/photo-1607083206869-4c7672e72a8a?w=600&h=600&fit=crop',
      link: `https://listado.mercadolibre.com.ar/${encodeURIComponent(event.searchTerms?.[0] || 'regalo')}`,
      badge: event.badge || 'Oferta',
      precio_estimado: true,
      rating: 4.5,
      reviews: 250,
      starsHtml: '★★★★½',
      eventId: event.id,
      eventName: event.name
    }
  ];

  return eventFallbacks;
}

// ── MAIN ──
async function main() {
  log('🎯 ══════ SCRAPER EVENTO EXPRESS INICIADO ══════\n');

  // Verificar API keys
  if (!DEEPSEEK_API_KEY && !GEMINI_API_KEY) {
    log('⚠️  Ni DEEPSEEK_API_KEY ni GEMINI_API_KEY configuradas en .env.');
    log('   Se usarán datos de ejemplo.\n');
  }

  // ── Paso 0: Cargar evento activo ──
  const event = getActiveEvent();
  if (!event) {
    log('❌ No hay evento express activo. Verificá express-events.json.');
    log('   Si el evento está fuera de su rango de fechas, se desactiva automáticamente.');
    // Guardar archivo vacío para que generate-cache.js sepa que no hay evento
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify([], null, 2), 'utf8');
    log('   ✅ express-offers.json guardado vacío.\n');
    return;
  }

  const queries = event.queries || event.searchTerms || [];
  if (queries.length === 0) {
    log('⚠️  El evento no tiene queries definidas. Usando fallback.');
    const fallback = generateFallbackOffers(event);
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(fallback, null, 2), 'utf8');
    return;
  }

  // ── Paso 1: Scraping con Puppeteer ──
  log(`── Paso 1/4: Buscando "${event.name}" en buscadores ──`);
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
  for (const query of queries) {
    const results = await searchAllEngines(browser, query);
    allResults.push(...results);
    await sleep(1500);
  }

  // Deduplicar por link
  const seen = new Set();
  allResults = allResults.filter(r => {
    if (!r.link || seen.has(r.link)) return false;
    seen.add(r.link);
    return true;
  });

  log(`\n📊 Total resultados únicos: ${allResults.length}`);

  // ── Paso 2: Parsear con IA ──
  log('\n── Paso 2/4: Analizando resultados con IA ──');
  let offers = null;
  if (allResults.length > 0) {
    offers = await parseWithAI(allResults, event);
  }

  // ── Paso 3: Enriquecer y resolver imágenes ──
  log('\n── Paso 3/4: Enriqueciendo datos y resolviendo imágenes ──');
  if (offers && offers.length > 0) {
    offers = enrichOffers(offers, event);
  } else {
    log('   ⚠️  No se pudieron extraer ofertas reales. Usando fallback.');
    offers = generateFallbackOffers(event);
  }

  await resolveImages(browser, offers);
  await browser.close();

  // ── Paso 4: Guardar ──
  log('\n── Paso 4/4: Guardando express-offers.json ──');
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(offers, null, 2), 'utf8');

  log('\n═══════════════════════════════════════');
  log(`🎯 ${event.name} — Productos actualizados:`);
  offers.forEach((o, i) => {
    const estimado = o.precio_estimado ? ' ⚠️(precio estimado)' : '';
    log(`   ${i + 1}. ${o.product} (${o.category})`);
    log(`      💵 $${o.price}${o.oldPrice ? ` (antes $${o.oldPrice})` : ''}${estimado}`);
    log(`      🖼️  ${o.imageUrl ? 'Imagen OK' : 'Sin imagen'}`);
    log(`      🏷️  ${o.badge}`);
  });
  log('═══════════════════════════════════════');
}

main().catch(err => {
  console.error('❌ Error crítico:', err.message);
  process.exit(1);
});
