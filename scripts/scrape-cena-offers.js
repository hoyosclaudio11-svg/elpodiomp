/**
 * BUSCADOR DE OFERTAS DE CENA — "Cena Express"
 *
 * Busca las 3 mejores ofertas de cena con delivery en CABA:
 * hamburguesas, pizza, empanadas, lomitos, sushi, tacos, milanesas y más.
 * Extrae precio, origen y foto.
 *
 * Estrategia:
 *   1. Puppeteer → busca en Google Argentina con múltiples queries
 *   2. Extrae snippets, títulos y URLs de los resultados
 *   3. DeepSeek/Gemini AI → parsea el texto no estructurado a JSON (nombre, precio, ubicación)
 *   4. Imagen → intenta extraer del sitio del restaurante, fallback a Unsplash
 *   5. Guarda las 3 mejores ofertas en cena-offers.json
 *
 * Ejecutar: node scripts/scrape-cena-offers.js
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

puppeteer.use(StealthPlugin());
require('dotenv').config({ override: true });

const OUTPUT_PATH = path.join(__dirname, '..', 'cena-offers.json');
const HISTORY_PATH = path.join(__dirname, '..', 'cena-history.json');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ── Historial de ofertas recientes (anti-repetición) ──
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
      return JSON.parse(raw);
    }
  } catch (_) {}
  return { recent: [], updated: null, maxAge: 7 };
}

function saveHistory(history) {
  history.updated = new Date().toISOString().split('T')[0];
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
}

function cleanOldHistory(history) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (history.maxAge || 7));
  const cutoffStr = cutoff.toISOString().split('T')[0];
  history.recent = history.recent.filter(entry => {
    const parts = entry.split('|');
    const date = parts[2] || '';
    return date >= cutoffStr;
  });
  return history;
}

function addToHistory(history, restaurant, product) {
  const today = new Date().toISOString().split('T')[0];
  const entry = `${restaurant}|${product}|${today}`;
  history.recent = history.recent.filter(e => !e.startsWith(`${restaurant}|${product}|`));
  history.recent.push(entry);
  if (history.recent.length > 30) {
    history.recent = history.recent.slice(-30);
  }
  return history;
}

function getRecentAvoidList(history) {
  return history.recent.map(entry => {
    const parts = entry.split('|');
    return `${parts[0]} — ${parts[1] || ''}`;
  });
}

// ── Pool de queries para buscar ofertas de cena en CABA ──
// Se seleccionan 6 queries por día usando el día del mes como seed
const QUERY_POOL = [
  // Hamburguesas
  'hamburguesa combo delivery CABA oferta',
  'burger doble carne delivery capital federal promo',
  'combo hamburguesa papas delivery zona norte CABA',
  // Pizzas
  'pizza grande muzza delivery CABA oferta',
  'pizza promo delivery capital federal argentina',
  'pizza napolitana fugazzeta delivery zona sur CABA',
  // Empanadas
  'empanadas docena delivery CABA oferta promo',
  'empanadas carne pollo jyq delivery capital federal',
  // Lomitos y sandwiches
  'lomito completo delivery CABA oferta',
  'sandwich bondiola lomito delivery capital federal',
  // Sushi
  'sushi rolls combo delivery CABA oferta promo',
  'sushi promo pareja delivery capital federal',
  // Milanesas
  'milanesa napolitana papas delivery CABA',
  'milanesa sandwich delivery oferta capital federal',
  // Tacos y mexicanos
  'tacos mexicanos burritos delivery CABA oferta',
  'comida mexicana combo delivery capital federal',
  // Parrilla y asado
  'parrillada delivery CABA oferta promo',
  'asado sandwich vacio delivery capital federal',
];

function getDailyQueries() {
  const dayOfMonth = new Date().getDate();
  const shuffled = [...QUERY_POOL];
  let seed = dayOfMonth;
  for (let i = shuffled.length - 1; i > 0; i--) {
    seed = (seed * 16807 + 0) % 2147483647;
    const j = seed % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const selected = shuffled.slice(0, 6);
  log(`   📋 Queries del día (seed=${dayOfMonth}): ${selected.map(q => q.substring(0, 35) + '...').join(', ')}`);
  return selected;
}

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

// ── Extraer imagen de la página del restaurante ──
async function extractImageFromPage(browser, url) {
  if (!url || !url.startsWith('http')) return null;

  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });

    const imageUrl = await page.evaluate(() => {
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage && ogImage.content) {
        const og = ogImage.content;
        if (!/logo|icon|avatar|favicon/i.test(og)) return og;
      }

      const imgs = [...document.querySelectorAll('img')]
        .filter(img => {
          const src = (img.src || img.dataset?.src || '');
          if (/logo|icon|avatar|favicon|pixel|tracking|1x1|blank|placeholder/i.test(src)) return false;
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          return w > 300 && h > 300;
        })
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
async function parseWithDeepSeek(allSnippets, avoidList) {
  const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
  if (!DEEPSEEK_KEY) return null;

  const textToAnalyze = allSnippets
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet}\nLink: ${s.link}`)
    .join('\n\n')
    .substring(0, 8000);

  const avoidText = avoidList && avoidList.length > 0
    ? `\n\n🚫 RESTAURANTES/PRODUCTOS A EVITAR (ya fueron mostrados en días recientes):\n${avoidList.map(a => `  - ${a}`).join('\n')}\nBuscá alternativas DIFERENTES a estas. Priorizá restaurantes NUEVOS y de barrios DISTINTOS.`
    : '';

  const prompt = `Analizá estos resultados de búsqueda sobre OFERTAS DE CENA con DELIVERY en CABA (Capital Federal), Argentina.

Encontrá las 3 MEJORES OFERTAS que tengan ENVÍO A TODO CABA y devolvé SOLO este JSON (sin explicaciones):

[
  {
    "restaurant": "Nombre real del restaurante (ej: Big Pons, Pizza Cero, La Farola)",
    "product": "Ej: Combo Doble Bacon + Papas + Gaseosa",
    "price": 8500,
    "oldPrice": 11000,
    "description": "1-2 líneas tentadoras describiendo el plato, mencioná que hacen envíos a todo CABA",
    "location": "Barrio, CABA (ej: Palermo, Belgrano, Caballito, Villa Crespo)",
    "category": "Hamburguesería | Pizzería | Empanadas | Lomitería | Sushi | Mexicana | Milanesas | Parrilla",
    "installments": "Envío a todo CABA | Delivery en 45 min",
    "link": "URL real del resultado",
    "badge": "Mejor Precio",
    "precio_estimado": false
  }
]

Reglas CRÍTICAS:
- SOLO restaurantes/casas de comida que hagan DELIVERY/ENVÍO a todo CABA o Capital Federal.
- Si el restaurante no hace envíos, DESCARTALO.
- Precios en PESOS ARGENTINOS. Extraé el número de "$8500", "$8.500", "ARS 8500".
- Tipos de comida para la cena: hamburguesas con papas, pizzas grandes, docena de empanadas, lomitos completos, rolls de sushi, tacos/burritos, milanesa napolitana, parrillada para 2.
- Las 3 ofertas DEBEN ser de al menos 2 restaurantes DIFERENTES (idealmente 3).
- Diversificá los TIPOS DE COMIDA: **OBLIGATORIO 3 CATEGORÍAS DIFERENTES**. Si una es empanadas, las otras dos DEBEN ser de tipos distintos (hamburguesa, pizza, lomito, sushi, etc.). NUNCA pongas 2 o 3 ofertas de la misma categoría. Si los resultados no tienen variedad, al menos 2 categorías distintas.
- Diversificá los BARRIOS: cada oferta debe ser de un barrio DIFERENTE de CABA (ej: Palermo, Belgrano, Caballito, Villa Crespo, Almagro, Recoleta, San Telmo, Colegiales). No pongas "CABA" genérico, poné el barrio real.
- Si no hay info de delivery, precio_estimado: true.
- Si no hay 3 ofertas con delivery, devolvé las que tengan.${avoidText}

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
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        log(`   🤖 DeepSeek extrajo ${parsed.length} ofertas de cena.`);
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
async function parseWithGemini(allSnippets, avoidList) {
  if (!GEMINI_API_KEY) return null;

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

  const textToAnalyze = allSnippets
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet}\nLink: ${s.link}`)
    .join('\n\n')
    .substring(0, 8000);

  const avoidText = avoidList && avoidList.length > 0
    ? `EVITÁ estos restaurantes/productos ya mostrados: ${avoidList.join('; ')}. `
    : '';

  const prompt = `Analizá estos resultados de búsqueda sobre OFERTAS DE CENA con DELIVERY EN CABA. ${avoidText}Encontrá las 3 MEJORES OFERTAS que hagan envíos a Capital Federal. Devolvé SOLO este JSON (sin explicaciones): [{"restaurant":"nombre","product":"desc","price":8500,"oldPrice":11000,"description":"1-2 lineas","location":"Barrio, CABA","category":"Hamburguesería","installments":"Envío a todo CABA","link":"url","badge":"Destacado","precio_estimado":false}]. Tipos: hamburguesas, pizzas, empanadas, lomitos, sushi, tacos, milanesas, parrilla. SOLO con delivery a CABA. Las 3 ofertas de al menos 2 restaurantes DIFERENTES. Diversificá tipo de comida y barrios. Precios en PESOS ARGENTINOS.\n\nResultados:\n${textToAnalyze}`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    });

    const responseText = result.response.text().trim();
    const parsed = JSON.parse(responseText);

    if (Array.isArray(parsed) && parsed.length > 0) {
      log(`   🤖 Gemini extrajo ${parsed.length} ofertas de cena.`);
      return parsed.slice(0, 3);
    }
    return null;
  } catch (err) {
    log(`   ⚠️  Gemini: ${err.message}`);
    return null;
  }
}

// ── Parser combinado: DeepSeek → Gemini → fallback ──
async function parseWithAI(allSnippets, avoidList) {
  const deepseekResult = await parseWithDeepSeek(allSnippets, avoidList);
  if (deepseekResult) return deepseekResult;

  const geminiResult = await parseWithGemini(allSnippets, avoidList);
  if (geminiResult) return geminiResult;

  return null;
}

// ── Imagen fallback de Unsplash ──
function getUnsplashFallback(product, category) {
  const prod = (product || '').toLowerCase();
  const cat = (category || '').toLowerCase();

  const fallbacks = {
    hamburguesa: [
      'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1550547660-d9450f859349?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1586816001966-79b736744398?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1594212699903-ec8a3eca50f5?w=600&h=600&fit=crop',
    ],
    pizza: [
      'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1604382354936-07c5d9983bd3?w=600&h=600&fit=crop',
    ],
    empanadas: [
      'https://images.unsplash.com/photo-1604467707321-70d5ec45c25a?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1621955964441-c173e01c135b?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1595854341625-f33ee10dbf94?w=600&h=600&fit=crop',
    ],
    lomito: [
      'https://images.unsplash.com/photo-1553909489-cd47e0907980?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1521390188846-e2a3a97453a0?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1594212699903-ec8a3eca50f5?w=600&h=600&fit=crop',
    ],
    sushi: [
      'https://images.unsplash.com/photo-1579871494447-9811cf80d66c?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1553621042-f6e147245754?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1611143669185-af224c5e3252?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1540648639573-8c848de23f0a?w=600&h=600&fit=crop',
    ],
    mexicana: [
      'https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1551504734-5ee1c4a1479b?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1650727759967-fb23139b07ed?w=600&h=600&fit=crop',
    ],
    milanesa: [
      'https://images.unsplash.com/photo-1598515214211-89d3c73ae83b?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1626082927389-6cd097cdc6ec?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1632778149955-e80f8ceca2e8?w=600&h=600&fit=crop',
    ],
    parrilla: [
      'https://images.unsplash.com/photo-1558030006-450675393462?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1544025162-d76694265947?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600&h=600&fit=crop',
    ],
    generica: [
      'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=600&h=600&fit=crop',
    ]
  };

  // Detectar tipo por nombre del producto
  if (prod.includes('hamburguesa') || prod.includes('burger') || prod.includes('bacon') || prod.includes('cheddar')) return pickRandom(fallbacks.hamburguesa);
  if (prod.includes('pizza') || prod.includes('muzza') || prod.includes('napolitana') || prod.includes('fugazzeta')) return pickRandom(fallbacks.pizza);
  if (prod.includes('empanada')) return pickRandom(fallbacks.empanadas);
  if (prod.includes('lomito') || prod.includes('bondiola') || prod.includes('sandwich')) return pickRandom(fallbacks.lomito);
  if (prod.includes('sushi') || prod.includes('roll') || prod.includes('nigiri')) return pickRandom(fallbacks.sushi);
  if (prod.includes('taco') || prod.includes('burrito') || prod.includes('mexicano') || prod.includes('nachos')) return pickRandom(fallbacks.mexicana);
  if (prod.includes('milanesa') || prod.includes('napolitana')) return pickRandom(fallbacks.milanesa);
  if (prod.includes('parrilla') || prod.includes('asado') || prod.includes('vacio') || prod.includes('choripan')) return pickRandom(fallbacks.parrilla);

  // Fallback por categoría
  if (cat.includes('hamburguesa')) return pickRandom(fallbacks.hamburguesa);
  if (cat.includes('pizza')) return pickRandom(fallbacks.pizza);
  if (cat.includes('empanada')) return pickRandom(fallbacks.empanadas);
  if (cat.includes('lomito') || cat.includes('sandwich')) return pickRandom(fallbacks.lomito);
  if (cat.includes('sushi')) return pickRandom(fallbacks.sushi);
  if (cat.includes('mexican')) return pickRandom(fallbacks.mexicana);
  if (cat.includes('milanesa')) return pickRandom(fallbacks.milanesa);
  if (cat.includes('parrilla')) return pickRandom(fallbacks.parrilla);

  return pickRandom(fallbacks.generica);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Limpiar URLs de DuckDuckGo (extraer URL real del redirect) ──
function cleanUrl(url) {
  if (!url) return 'https://pedidosya.com.ar';
  const ddgMatch = url.match(/uddg=([^&]+)/);
  if (ddgMatch) {
    try { return decodeURIComponent(ddgMatch[1]); } catch { return url; }
  }
  if (url.startsWith('http')) return url;
  return 'https://pedidosya.com.ar';
}

// ── Validar y enriquecer ofertas ──
function enrichOffers(offers) {
  return offers.map((offer, i) => {
    const seed = offer.restaurant + offer.product;
    let hash = 0;
    for (let j = 0; j < seed.length; j++) {
      hash = ((hash << 5) - hash) + seed.charCodeAt(j);
      hash |= 0;
    }
    // Rating determinístico entre 4.0 y 5.0
    const rating = Math.round((4.0 + (Math.abs(hash) % 11) / 10) * 10) / 10;
    const reviews = 80 + (Math.abs(hash) % 420);

    return {
      id: `cena_${i + 1}`,
      restaurant: offer.restaurant || 'Restaurante Delivery',
      product: offer.product || 'Combo Cena Especial',
      price: offer.price || 8500,
      oldPrice: offer.oldPrice || null,
      description: offer.description || 'Elaborado con ingredientes frescos. Delivery a todo CABA en minutos.',
      location: offer.location || 'Capital Federal',
      category: offer.category || 'Cena Delivery',
      installments: offer.installments || 'Envío a todo CABA',
      imageUrl: offer.imageUrl || '',
      link: cleanUrl(offer.link),
      badge: offer.badge || 'Destacado',
      precio_estimado: offer.precio_estimado || false,
      rating,
      reviews
    };
  });
}

// ── Pipeline de imagen: scrapeada → Unsplash ──
async function resolveImages(browser, offers) {
  for (const offer of offers) {
    // Verificar si ya tiene una imagen válida (no logo miniatura)
    if (offer.imageUrl && offer.imageUrl.startsWith('http')
        && !/logo|icon|avatar|favicon|homes-palpatine|frontend-assets/i.test(offer.imageUrl)) {
      log(`   🖼️  ${offer.restaurant}: ya tiene imagen válida.`);
      continue;
    }

    if (offer.imageUrl && /logo|icon|homes-palpatine|frontend-assets/i.test(offer.imageUrl)) {
      log(`   ⚠️  ${offer.restaurant}: tenía logo, buscando imagen real...`);
    }

    // Intentar extraer imagen real de la web del restaurante
    if (offer.link && offer.link.startsWith('http')) {
      log(`   🔍 Buscando imagen para "${offer.product}"...`);
      const extracted = await extractImageFromPage(browser, offer.link);
      if (extracted) {
        // Validar que la imagen no sea un logo miniatura
        if (extracted.includes('?d=10x10') || extracted.includes('&d=10x10') ||
            extracted.includes('?e=webp&d=10') || (extracted.includes('logo') && extracted.includes('10x10'))) {
          log(`   ⚠️  ${offer.restaurant}: imagen parece logo miniatura, descartando.`);
        } else {
          offer.imageUrl = extracted;
          log(`   ✅ Imagen real encontrada.`);
          continue;
        }
      }
    }

    // Fallback a Unsplash
    const fallback = getUnsplashFallback(offer.product || '', offer.category || '');
    offer.imageUrl = fallback;
    log(`   📸 Imagen Unsplash asignada a "${offer.restaurant}".`);
  }
  return offers;
}

// ── Generar datos de ejemplo (último recurso si todo falla) ──
function generateFallbackOffers() {
  log('⚠️  Generando ofertas de cena de ejemplo (fallback). Los precios son estimados.');
  return [
    {
      id: 'cena_1',
      restaurant: 'Big Pons',
      product: 'Combo Doble Bacon + Papas + Gaseosa',
      price: 8500,
      oldPrice: 11000,
      description: 'Doble medallón de carne vacuna, queso cheddar fundido, panceta crocante y salsa Big Pons. Incluye papas fritas grandes y gaseosa.',
      location: 'Palermo, CABA',
      category: 'Hamburguesería',
      installments: 'Envío a todo CABA | Delivery en 45 min',
      imageUrl: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&h=600&fit=crop',
      link: 'https://pedidosya.com.ar',
      badge: 'Mejor Precio',
      precio_estimado: true,
      rating: 4.7,
      reviews: 340
    },
    {
      id: 'cena_2',
      restaurant: 'Pizza Cero',
      product: 'Pizza Grande de Muzzarella + 2 Empanadas',
      price: 6500,
      oldPrice: 8500,
      description: 'Pizza casera a la piedra con abundante muzzarella, aceitunas y orégano. Incluye 2 empanadas de carne a elección.',
      location: 'Caballito, CABA',
      category: 'Pizzería',
      installments: 'Envío a todo CABA en 45 min',
      imageUrl: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600&h=600&fit=crop',
      link: 'https://pedidosya.com.ar',
      badge: 'Más Vendido',
      precio_estimado: true,
      rating: 4.5,
      reviews: 215
    },
    {
      id: 'cena_3',
      restaurant: 'La Farola Empanadas',
      product: 'Docena de Empanadas Mixtas + Salsa',
      price: 5500,
      oldPrice: 7200,
      description: '6 empanadas de carne suave + 6 de jamón y queso. Masa criolla casera, relleno abundante y salsas caseras incluidas.',
      location: 'Villa Crespo, CABA',
      category: 'Empanadas',
      installments: 'Envío a todo CABA en 30 min',
      imageUrl: 'https://images.unsplash.com/photo-1604467707321-70d5ec45c25a?w=600&h=600&fit=crop',
      link: 'https://pedidosya.com.ar',
      badge: 'Delivery Gratis',
      precio_estimado: true,
      rating: 4.8,
      reviews: 520
    }
  ];
}

// ── MAIN ──
async function main() {
  log('🍔 INICIANDO BÚSQUEDA DE OFERTAS DE CENA...\n');

  // Verificar API keys
  if (!GEMINI_API_KEY && !process.env.DEEPSEEK_API_KEY) {
    log('⚠️  Ni GEMINI_API_KEY ni DEEPSEEK_API_KEY configuradas en .env.');
    log('   Se usarán datos de ejemplo. Agregá una API key para scraping real.\n');
  }

  // ── Cargar historial ──
  let history = loadHistory();
  history = cleanOldHistory(history);
  const avoidList = getRecentAvoidList(history);
  if (avoidList.length > 0) {
    log(`📋 ${avoidList.length} ofertas en historial reciente (a evitar):`);
    avoidList.forEach(a => log(`   🚫 ${a}`));
  } else {
    log('📋 Historial vacío — se aceptan todas las ofertas.');
  }

  // ── Paso 1: Scraping con Puppeteer ──
  log('\n── Paso 1/4: Buscando en buscadores ──');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1366,900'
    ]
  });

  const dailyQueries = getDailyQueries();

  let allResults = [];
  for (const query of dailyQueries) {
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

  // ── Paso 2: Parsear con IA (DeepSeek → Gemini → fallback) ──
  log('\n── Paso 2/4: Analizando resultados con IA ──');
  let offers = null;
  if (allResults.length > 0) {
    offers = await parseWithAI(allResults, avoidList);
  }

  // ── Paso 3: Enriquecer y resolver imágenes ──
  log('\n── Paso 3/4: Enriqueciendo datos y resolviendo imágenes ──');
  if (offers && offers.length > 0) {
    offers = enrichOffers(offers);
    // Guardar en historial las nuevas ofertas encontradas
    for (const offer of offers) {
      history = addToHistory(history, offer.restaurant, offer.product);
    }
    saveHistory(history);
    log(`   📝 ${offers.length} ofertas agregadas al historial.`);
  } else {
    log('   ⚠️  No se pudieron extraer ofertas reales. Usando fallback.');
    offers = generateFallbackOffers();
  }

  await resolveImages(browser, offers);
  await browser.close();

  // ── Paso 4: Guardar ──
  log('\n── Paso 4/4: Guardando cena-offers.json ──');
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(offers, null, 2), 'utf8');

  log('\n═══════════════════════════════════════');
  log('🍔 Ofertas de cena actualizadas:');
  offers.forEach((o, i) => {
    const estimado = o.precio_estimado ? ' ⚠️(precio estimado)' : '';
    log(`   ${i + 1}. ${o.restaurant} — ${o.product} (${o.category})`);
    log(`      💵 $${o.price}${o.oldPrice ? ` (antes $${o.oldPrice})` : ''} | 📍 ${o.location}${estimado}`);
    log(`      🖼️  ${o.imageUrl ? 'Imagen OK' : 'Sin imagen'}`);
  });
  log('═══════════════════════════════════════');
}

main().catch(err => {
  console.error('❌ Error crítico:', err.message);
  process.exit(1);
});
