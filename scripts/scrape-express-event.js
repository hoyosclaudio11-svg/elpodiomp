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

// ── Buscador directo en Mercado Libre ──
// Usa Google con site:articulo.mercadolibre.com.ar para obtener URLs reales de producto
async function searchMercadoLibreDirect(browser, query) {
  const page = await browser.newPage();
  const results = [];
  try {
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    // Buscar en Google solo páginas de producto de ML
    const cleanQuery = query.replace(/mercadolibre|mercadolibre\.com\.ar|mercadolibre argentina/gi, '').replace(/regalo|dia del padre|oferta/gi, '').trim();
    const searchUrl = `https://www.google.com/search?q=site:articulo.mercadolibre.com.ar+${encodeURIComponent(cleanQuery)}&hl=es-AR&gl=AR&num=10`;
    log(`   🛒 Google → ML productos: "${cleanQuery.substring(0, 55)}"`);

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
    if (bodyText.includes('consent.google') || bodyText.includes('not a robot') || bodyText.includes('Before you continue')) {
      log('      ⚠️  Google pide CAPTCHA/consent. Saltando.');
      return results;
    }

    const productos = await page.evaluate(() => {
      const items = [];
      const seen = new Set();
      // Buscar resultados de Google que contengan links a articulo.mercadolibre.com.ar
      const allLinks = document.querySelectorAll('a[href*="articulo.mercadolibre.com.ar/MLA-"]');

      for (const linkEl of allLinks) {
        const href = linkEl.href;
        const mlaMatch = href.match(/MLA-?\d{7,12}/);
        if (!mlaMatch || seen.has(mlaMatch[0])) continue;
        seen.add(mlaMatch[0]);

        // Encontrar el contenedor del resultado
        const container = linkEl.closest('div.g, div[data-sokoban-container], div[data-header]') || linkEl.closest('div');

        // Título (h3 en resultados de Google)
        const titleEl = container ? container.querySelector('h3') : null;
        const title = titleEl ? titleEl.textContent.trim() : linkEl.textContent.trim();

        // Snippet
        const snippetEl = container ? container.querySelector('div[data-sncf], span.aCOpRe, div.VwiC3b, div[role="heading"] + div') : null;
        const snippet = snippetEl ? snippetEl.textContent.trim() : '';

        if (title && title.length > 10 && href.includes('articulo.mercadolibre.com.ar')) {
          items.push({
            title,
            snippet,
            link: href,
            imageUrl: ''
          });
          if (items.length >= 8) break;
        }
      }
      return items;
    });

    results.push(...productos);
    log(`      📄 ${productos.length} productos reales de ML (MLA-ID via Google)`);
  } catch (err) {
    log(`      ⚠️  Google→ML: ${err.message}`);
  } finally {
    try { await page.close(); } catch (_) {}
  }
  return results;
}

async function searchAllEngines(browser, query) {
  // Primero buscar productos reales de ML via Google (URLs con MLA-ID)
  let results = await searchMercadoLibreDirect(browser, query);

  // Complementar con DuckDuckGo
  const ddgResults = await searchDuckDuckGo(browser, query);
  results = results.concat(ddgResults);

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
      if (ogImage && ogImage.content) {
        const og = ogImage.content;
        // Rechazar logos e imágenes genéricas de ML
        if (!/logo|icon|avatar|favicon|homes-palpatine|frontend-assets/i.test(og)) return og;
      }

      const imgs = [...document.querySelectorAll('img')]
        .filter(img => {
          const src = (img.src || img.dataset?.src || '');
          // Rechazar logos, iconos, avatares, imágenes chicas
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

Encontrá los 3 MEJORES PRODUCTOS PARA REGALAR en este evento. Productos que REALMENTE emocionen recibir: notebooks gamer, consolas (PlayStation 5, Xbox, Nintendo Switch), celulares alta gama, smartwatches, herramientas profesionales (Bosch, DeWalt, Stanley), sets de asado premium, perfumes importados (Paco Rabanne, Dior, Armani), zapatillas de marca, smart TVs, tablets, parlantes Bluetooth premium (JBL, Bose, Sony), drones, cafeteras espresso, auriculares gamer, sillas gamer.

Devolvé SOLO este JSON (sin explicaciones, sin markdown):

[
  {
    "product": "Nombre real y completo del producto con marca y modelo (ej: Notebook Lenovo IdeaPad Gaming 3 Ryzen 7 16GB)",
    "price": 459999,
    "oldPrice": 589999,
    "description": "1-2 líneas atractivas explicando por qué es EL regalo ideal para papá, con gancho emocional",
    "category": "Tecnología | Herramientas | Perfumería | Indumentaria | Gaming | Hogar",
    "link": "URL real del producto en Mercado Libre",
    "badge": "Regalo TOP para Papá",
    "precio_estimado": false
  }
]

Reglas CRÍTICAS (si las rompés, el JSON es inútil):
1. **URL OBLIGATORIA**: El link DEBE ser https://www.mercadolibre.com.ar/... o https://articulo.mercadolibre.com.ar/MLA-XXXXX. SI ES UN LISTADO (listado.mercadolibre.com.ar), UN BLOG, O CUALQUIER OTRA COSA → DESCARTALO COMPLETAMENTE.
2. SOLO productos de Mercado Libre Argentina. Nada de Amazon, Falabella, Frávega, etc.
3. Precios en PESOS ARGENTINOS (junio 2026). Productos PREMIUM: notebooks desde $400k, consolas desde $500k, herramientas desde $80k, perfumes desde $60k, zapatillas desde $80k.
4. **VARIEDAD OBLIGATORIA**: Los 3 productos deben ser de 3 categorías DIFERENTES. Nada de 2 celulares ni 2 perfumes.
5. Precios realistas para Argentina junio 2026 (con inflación). Si no hay precio, precio_estimado: true.
6. **CALIDAD**: Nada de productos genéricos sin marca reconocible. Nada de "Kit de herramientas genérico" o "Zapatillas deportivas sin marca".

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

  const prompt = `Analizá estos resultados de búsqueda sobre "${event.name}" en Mercado Libre Argentina. Encontrá los 3 MEJORES PRODUCTOS para regalar (notebooks, consolas, herramientas premium, perfumes importados, smartwatches, zapatillas de marca, sets de asado, auriculares gamer, cafeteras espresso, smart TVs). Devolvé SOLO este JSON: [{"product":"nombre real con marca y modelo","price":459999,"oldPrice":589999,"description":"1-2 lineas atractivas","category":"Tecnologia|Gaming|Herramientas|Perfumeria|Indumentaria|Hogar","link":"URL PRODUCTO REAL articulo.mercadolibre.com.ar/MLA-XXXX","badge":"Regalo TOP","precio_estimado":false}]. REGLAS: 1) SOLO productos de Mercado Libre Argentina. 2) URL DEBE ser de PRODUCTO real (articulo.mercadolibre.com.ar), NO listados ni blogs. 3) Precios en PESOS ARGENTINOS junio 2026 (notebooks +$400k, consolas +$500k, herramientas +$80k). 4) 3 categorías DIFERENTES. 5) Nada sin marca.\n\nResultados:\n${textToAnalyze}`;

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

// ── Resolver URL real de producto buscando en ML ──
async function resolveProductUrl(browser, productName) {
  if (!productName) return '';
  const page = await browser.newPage();
  try {
    // Buscar el producto en DuckDuckGo acotado a ML
    const query = `site:mercadolibre.com.ar ${productName}`;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const links = await page.evaluate(() => {
      const results = [];
      const allLinks = document.querySelectorAll('a[href*="mercadolibre.com.ar"]');
      for (const a of allLinks) {
        const href = a.href;
        // Priorizar URLs con MLA-ID
        if (/\/MLA-?\d{7,12}/.test(href)) {
          results.push({ url: href, priority: 1 });
        } else if (/\/_JM/.test(href) && !/listado|ofertas|categorias|blog/i.test(href)) {
          results.push({ url: href, priority: 2 });
        }
        if (results.length >= 3) break;
      }
      return results;
    });

    // Buscar MLA-ID en las URLs de DDG (uddg=...)
    for (const link of links) {
      try {
        const decoded = decodeURIComponent(link.url);
        const mlaMatch = decoded.match(/MLA-?\d{7,12}/);
        if (mlaMatch) {
          await page.close();
          return decoded;
        }
      } catch {}
    }

    // Si no hay MLA-ID, usar URL de producto sin listado
    const productUrl = links.find(l => !/listado|ofertas|categorias|blog/i.test(l.url));
    if (productUrl) {
      await page.close();
      return productUrl.url;
    }
  } catch (err) {
    log(`      ⚠️  Resolver URL "${productName.substring(0, 40)}": ${err.message}`);
  } finally {
    try { await page.close(); } catch (_) {}
  }
  return '';
}

// ── Validar que la URL sea un producto real de ML ──
function isValidMLProductUrl(url) {
  if (!url) return false;
  // Producto real con MLA-ID
  if (/\/MLA-?\d{7,12}/i.test(url)) return true;
  // Producto real con URL amigable que termina en /_JM
  if (/mercadolibre\.com\.ar\/.+\/_JM/i.test(url)) return true;
  // Producto con slug descriptivo (tiene guiones, palabras clave de producto)
  if (/mercadolibre\.com\.ar\/[a-z0-9-]{20,}/i.test(url)
      && !/listado|ofertas|categorias|blog|publicidad/i.test(url)) {
    return true;
  }
  // Rechazar explícitamente
  if (/listado\.mercadolibre\.com\.ar/i.test(url)) return false;
  if (/mercadolibre\.com\.ar\/blog\//i.test(url)) return false;
  if (/mercadolibre\.com\.ar\/categorias\//i.test(url)) return false;
  if (/mercadolibre\.com\.ar\/ofertas/i.test(url)) return false;
  return false;
}

function validateAndFixOffers(offers, event) {
  const valid = [];
  const seen = new Set();
  for (const offer of offers) {
    // Validar URL de producto real
    if (!isValidMLProductUrl(offer.link)) {
      log(`   ⚠️  "${offer.product}" descartado: link no es producto real de ML (${offer.link?.substring(0, 80)}...)`);
      continue;
    }
    // Validar que tenga nombre de producto con marca
    if (!offer.product || offer.product.length < 10 || /^(producto|regalo|oferta|item)\b/i.test(offer.product.trim())) {
      log(`   ⚠️  Producto descartado: nombre demasiado genérico "${offer.product}"`);
      continue;
    }
    // Anti-duplicados
    const key = (offer.product || '').toLowerCase().trim();
    if (seen.has(key)) {
      log(`   ⚠️  Producto duplicado descartado: "${offer.product}"`);
      continue;
    }
    seen.add(key);
    valid.push(offer);
  }
  if (valid.length < offers.length) {
    log(`   🔍 Filtrados: ${offers.length} → ${valid.length} productos válidos (${offers.length - valid.length} descartados)`);
  }
  return valid;
}

async function parseWithAI(allSnippets, event) {
  const deepseekResult = await parseWithDeepSeek(allSnippets, event);
  if (deepseekResult) return deepseekResult;

  const geminiResult = await parseWithGemini(allSnippets, event);
  if (geminiResult) return geminiResult;

  return null;
}

// ── Imagen fallback de Unsplash ──
function getUnsplashFallback(category, productName) {
  const cat = (category || '').toLowerCase();
  const prod = (productName || '').toLowerCase();

  const fallbacks = {
    auriculares: [
      'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1583394838336-acd977736f90?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1618366712010-f4ae9c647dcb?w=600&h=600&fit=crop',
    ],
    zapatillas: [
      'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1608231387042-66d1773070a5?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?w=600&h=600&fit=crop',
    ],
    perfume: [
      'https://images.unsplash.com/photo-1541643600914-78b084683601?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1588405748880-12d1d2a59f75?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1563170351-be82bc888aa4?w=600&h=600&fit=crop',
    ],
    tecnologia: [
      'https://images.unsplash.com/photo-1468495244123-6c6c332eeece?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1550009158-9ebf69173e03?w=600&h=600&fit=crop',
    ],
    herramientas: [
      'https://images.unsplash.com/photo-1581783898377-1c85bf937427?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1530124566582-a618bc2615dc?w=600&h=600&fit=crop',
    ],
    reloj: [
      'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1524592094714-0f0654e20314?w=600&h=600&fit=crop',
    ],
    indumentaria: [
      'https://images.unsplash.com/photo-1556905055-8f358a7a47b2?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1489987707025-afc232f7ea0f?w=600&h=600&fit=crop',
    ],
    billetera: [
      'https://images.unsplash.com/photo-1627123424574-724758594e93?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=600&h=600&fit=crop',
    ],
    pesca: [
      'https://images.unsplash.com/photo-1507608869274-d3177c8bb4c7?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=600&h=600&fit=crop',
    ],
    asado: [
      'https://images.unsplash.com/photo-1558030006-450675393462?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=600&h=600&fit=crop',
    ],
    pulsera: [
      'https://images.unsplash.com/photo-1611652022419-a9419f74343d?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1602173574767-37ac01994b2a?w=600&h=600&fit=crop',
    ],
    generica: [
      'https://images.unsplash.com/photo-1607083206869-4c7672e72a8a?w=600&h=600&fit=crop',
      'https://images.unsplash.com/photo-1607344645866-009c320b63e4?w=600&h=600&fit=crop',
    ]
  };

  // Detectar categoría por palabras clave en el nombre del producto
  if (prod.includes('auricular') || prod.includes('sony') || prod.includes('headphone')) return pickRandom(fallbacks.auriculares);
  if (prod.includes('zapatilla') || prod.includes('nike') || prod.includes('adidas')) return pickRandom(fallbacks.zapatillas);
  if (prod.includes('perfume') || prod.includes('fragancia') || prod.includes('colonia')) return pickRandom(fallbacks.perfume);
  if (prod.includes('reloj') || prod.includes('smartwatch') || prod.includes('galaxy watch')) return pickRandom(fallbacks.reloj);
  if (prod.includes('billetera') || prod.includes('cinturon') || prod.includes('cartera')) return pickRandom(fallbacks.billetera);
  if (prod.includes('herramienta') || prod.includes('kit') || prod.includes('stanley')) return pickRandom(fallbacks.herramientas);
  if (prod.includes('pesca') || prod.includes('caña')) return pickRandom(fallbacks.pesca);
  if (prod.includes('asado') || prod.includes('parrilla') || prod.includes('tabla')) return pickRandom(fallbacks.asado);
  if (prod.includes('pulsera') || prod.includes('anillo') || prod.includes('cadena') || prod.includes('joya')) return pickRandom(fallbacks.pulsera);

  // Fallback por categoría
  if (cat.includes('tecnolog') || cat.includes('tech')) return pickRandom(fallbacks.tecnologia);
  if (cat.includes('herramienta')) return pickRandom(fallbacks.herramientas);
  if (cat.includes('perfume') || cat.includes('perfumer')) return pickRandom(fallbacks.perfume);
  if (cat.includes('indumentaria') || cat.includes('ropa') || cat.includes('moda')) return pickRandom(fallbacks.indumentaria);

  return pickRandom(fallbacks.generica);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Resolver imágenes ──
async function resolveImages(browser, offers) {
  for (const offer of offers) {
    // Verificar si ya tiene una imagen válida (no logo de ML)
    if (offer.imageUrl && offer.imageUrl.startsWith('http')
        && !/logo|icon|homes-palpatine|frontend-assets/i.test(offer.imageUrl)) {
      log(`   🖼️  ${offer.product}: ya tiene imagen válida.`);
      continue;
    }

    if (offer.imageUrl && /logo|homes-palpatine|frontend-assets/i.test(offer.imageUrl)) {
      log(`   ⚠️  ${offer.product}: tenía logo de ML, buscando imagen real...`);
    }

    if (offer.link && offer.link.startsWith('http')) {
      log(`   🔍 Buscando imagen para "${offer.product}"...`);
      const extracted = await extractImageFromPage(browser, offer.link);
      if (extracted && !/logo|icon|homes-palpatine|frontend-assets/i.test(extracted)) {
        offer.imageUrl = extracted;
        log(`   ✅ Imagen real encontrada.`);
        continue;
      }
      if (extracted) {
        log(`   ⚠️  Imagen descartada (parece logo), usando Unsplash.`);
      }
    }

    const fallback = getUnsplashFallback(offer.category || '', offer.product || '');
    offer.imageUrl = fallback;
    log(`   📸 Imagen Unsplash asignada a "${offer.product}".`);
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
    const rating = Math.min(5.0, Math.round((4.0 + (Math.abs(hash) % 10) / 10) * 10) / 10);
    const reviews = 120 + (Math.abs(hash) % 380);
    const full = Math.floor(rating);
    const half = rating - full >= 0.5 ? 1 : 0;
    const empty = Math.max(0, 5 - full - half);
    const starsHtml = '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);

    // Validar link: si no es producto real, no usar fallback genérico
    let finalLink = cleanUrl(offer.link);
    if (!isValidMLProductUrl(finalLink)) {
      finalLink = '';
    }

    return {
      id: `express_${i + 1}`,
      product: offer.product || 'Producto Destacado',
      price: offer.price || 35000,
      oldPrice: offer.oldPrice || null,
      description: offer.description || `El regalo perfecto para este ${event.name}. Calidad garantizada con envío a todo el país.`,
      category: offer.category || 'Producto',
      installments: offer.installments || 'Hasta 12 cuotas sin interés',
      imageUrl: offer.imageUrl || '',
      link: finalLink,
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
        product: 'Notebook Lenovo IdeaPad Gaming 3 Ryzen 5 16GB RAM 512GB SSD RTX 2050',
        price: 649999,
        oldPrice: 849999,
        description: 'El regalo tecnológico definitivo. Para el papá gamer o el que necesita productividad al máximo nivel. Pantalla 15.6" Full HD, volá con los juegos y el trabajo.',
        category: 'Tecnología',
        installments: 'Hasta 18 cuotas sin interés',
        imageUrl: 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=600&h=600&fit=crop',
        link: 'https://www.mercadolibre.com.ar/notebook-lenovo-ideapad-gaming-3-ryzen-5',
        badge: 'Regalo TOP para Papá',
        precio_estimado: true,
        rating: 4.8,
        reviews: 637,
        starsHtml: '★★★★½',
        eventId: 'dia_del_padre_2026',
        eventName: 'Especial Día del Padre'
      },
      {
        id: 'express_2',
        product: 'Consola PlayStation 5 Slim Digital + 2 Joysticks + Spider-Man 2',
        price: 799999,
        oldPrice: 999999,
        description: 'Para el papá que nunca dejó de ser chico. La PS5 Slim con lector digital, gráficos 4K y el Spider-Man 2 de regalo. Horas de diversión aseguradas.',
        category: 'Gaming',
        installments: 'Hasta 18 cuotas sin interés',
        imageUrl: 'https://images.unsplash.com/photo-1606813907293-d7613a46bab0?w=600&h=600&fit=crop',
        link: 'https://www.mercadolibre.com.ar/playstation-5-slim-digital',
        badge: 'Regalo TOP para Papá',
        precio_estimado: true,
        rating: 4.9,
        reviews: 1423,
        starsHtml: '★★★★★',
        eventId: 'dia_del_padre_2026',
        eventName: 'Especial Día del Padre'
      },
      {
        id: 'express_3',
        product: 'Set de Asador Premium con Tablas, Cuchillos y Delantal de Cuero Grabado',
        price: 98999,
        oldPrice: 139999,
        description: 'Para el rey del asado. Set completo de asador profesional con tabla de bambú, 4 cuchillos Tramontina, delantal de cuero personalizado y guantes térmicos.',
        category: 'Hogar',
        installments: 'Hasta 6 cuotas sin interés',
        imageUrl: 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=600&h=600&fit=crop',
        link: 'https://www.mercadolibre.com.ar/set-asador-premium',
        badge: 'Regalo TOP para Papá',
        precio_estimado: true,
        rating: 4.7,
        reviews: 892,
        starsHtml: '★★★★★',
        eventId: 'dia_del_padre_2026',
        eventName: 'Especial Día del Padre'
      },
      {
        id: 'express_4',
        product: 'Perfume Dior Sauvage Eau de Toilette 100ml Original',
        price: 129999,
        oldPrice: 169999,
        description: 'La fragancia más deseada del mundo. Notas frescas de bergamota de Calabria con pimienta de Sichuan. Elegancia pura para el papá con estilo.',
        category: 'Perfumería',
        installments: 'Hasta 6 cuotas sin interés',
        imageUrl: 'https://images.unsplash.com/photo-1541643600914-78b084683601?w=600&h=600&fit=crop',
        link: 'https://www.mercadolibre.com.ar/perfume-dior-sauvage-100ml',
        badge: 'Regalo TOP para Papá',
        precio_estimado: true,
        rating: 4.9,
        reviews: 2156,
        starsHtml: '★★★★★',
        eventId: 'dia_del_padre_2026',
        eventName: 'Especial Día del Padre'
      },
      {
        id: 'express_5',
        product: 'Smart TV Samsung 55" Crystal UHD 4K 55CU7000',
        price: 549999,
        oldPrice: 699999,
        description: 'Para que papá viva el fútbol y las series a lo grande. Imagen 4K nítida, HDR10+, sonido envolvente y control remoto con asistente de voz.',
        category: 'Tecnología',
        installments: 'Hasta 18 cuotas sin interés',
        imageUrl: 'https://images.unsplash.com/photo-1593359677879-a4bb92f829d1?w=600&h=600&fit=crop',
        link: 'https://www.mercadolibre.com.ar/smart-tv-samsung-55-crystal-uhd',
        badge: 'Regalo TOP para Papá',
        precio_estimado: true,
        rating: 4.7,
        reviews: 945,
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
      link: '',
      badge: event.badge || 'Oferta',
      precio_estimado: true,
      rating: 4.5,
      reviews: 250,
      starsHtml: '★★★★½',
      eventId: event.id,
      eventName: event.name
    }
  ];

  // Elegir 3 aleatorios de entre los disponibles para variar cada ejecución
  if (eventFallbacks.length > 3) {
    const shuffled = [...eventFallbacks].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, 3);
  }
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

  // ── Paso 2.5: Resolver URLs reales de ML para cada producto ──
  if (offers && offers.length > 0) {
    log('\n── Paso 2.5/4: Buscando URLs reales de ML ──');
    for (const offer of offers) {
      const currentLink = offer.link || '';
      // Si ya tiene URL válida, no buscar
      if (isValidMLProductUrl(currentLink)) {
        log(`   ✅ "${offer.product.substring(0, 50)}" ya tiene URL real`);
        continue;
      }
      // Buscar URL real del producto
      log(`   🔍 Buscando URL real para: "${offer.product.substring(0, 50)}..."`);
      const realUrl = await resolveProductUrl(browser, offer.product);
      if (realUrl) {
        offer.link = realUrl;
        log(`   ✅ URL encontrada: ${realUrl.substring(0, 80)}...`);
      } else {
        log(`   ⚠️  No se encontró URL real para "${offer.product.substring(0, 50)}"`);
      }
      await sleep(800); // pausa entre búsquedas
    }
  }

  // ── Paso 2.6: Validar URLs de productos ──
  if (offers && offers.length > 0) {
    offers = validateAndFixOffers(offers, event);
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
