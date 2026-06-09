const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────
// Rutas de archivos
// ─────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const FOOD_PATH = path.join(__dirname, 'food.json');
const OFERTAS_DIA_PATH = path.join(__dirname, 'data', 'ofertas_dia.json');
const TEMPLATE_PATH = path.join(__dirname, 'index.html');
const FIXTURE_PATH = path.join(__dirname, 'products-fixture.json');
const CONTADOR_PATH = path.join(__dirname, 'contador.json');
const LOGS_DIR = path.join(__dirname, 'logs');

// Site por defecto si no se detecta ninguno
const DEFAULT_SITE = 'elpodiomp';

// Crear directorio de logs si no existe
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// ─────────────────────────────────────
// Logging simple a archivo
// ─────────────────────────────────────
function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(LOGS_DIR, 'server.log'), line + '\n');
  } catch (_) { /* no bloquear si falla el log */ }
}

// ─────────────────────────────────────
// Middlewares de producción
// ─────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://www.googletagmanager.com", "https://www.google-analytics.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      connectSrc: ["'self'", "https://www.google-analytics.com"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: [],
      scriptSrcAttr: ["'unsafe-inline'"],
    }
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());

// Rate limiting: 100 requests por minuto por IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Demasiadas solicitudes. Intentá de nuevo en un minuto.',
});
app.use(globalLimiter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir archivos estáticos — solo assets públicos (imágenes, fuentes, css)
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  maxAge: '1h',
}));

// Forzar HTTPS en producción (Render ya lo hace, pero por si acaso)
app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, `https://${req.get('host')}${req.url}`);
  }
  next();
});

// ─────────────────────────────────────
// Utilidades Multi-Sitio
// ─────────────────────────────────────

/**
 * Escapa HTML para prevenir XSS.
 * Convierte < > & " ' en sus entidades HTML.
 */
function escapeHtml(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escapa una URL para usar en atributos href/src.
 * Solo permite http/https/mailto/data relativos.
 */
function safeUrl(url) {
  if (!url || typeof url !== 'string') return '#';
  const trimmed = url.trim();
  if (/^(https?:|\/|mailto:|data:image\/)/i.test(trimmed)) {
    return trimmed.replace(/"/g, '%22').replace(/'/g, '%27');
  }
  return '#';
}

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (err) {
    log('Error al leer config.json: ' + err.message);
  }
  return { sites: {}, categories: [], affiliateLinks: {}, categoryFallbacks: {}, meliTokens: {} };
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    log('Error al guardar config.json: ' + err.message);
  }
}

function readFood() {
  try {
    if (fs.existsSync(FOOD_PATH)) {
      return JSON.parse(fs.readFileSync(FOOD_PATH, 'utf8'));
    }
  } catch (err) {
    log('Error al leer food.json: ' + err.message);
  }
  return [];
}

function readOfertasDia() {
  try {
    if (fs.existsSync(OFERTAS_DIA_PATH)) {
      return JSON.parse(fs.readFileSync(OFERTAS_DIA_PATH, 'utf8'));
    }
  } catch (err) {
    log('Error al leer ofertas_dia.json: ' + err.message);
  }
  return null;
}

// ── Contador de Visitas ─────────────────
let contadorData = { visitas: 0, ultima_actualizacion: new Date().toISOString() };

function loadContador() {
  try {
    if (fs.existsSync(CONTADOR_PATH)) {
      contadorData = JSON.parse(fs.readFileSync(CONTADOR_PATH, 'utf8'));
      log(`[Contador] Cargado: ${contadorData.visitas} visitas totales.`);
    } else {
      log('[Contador] No existe contador.json. Iniciando en 0.');
    }
  } catch (err) {
    log('[Contador] Error al cargar: ' + err.message);
  }
  if (typeof contadorData.visitas !== 'number') contadorData.visitas = 0;
}

function saveContador() {
  try {
    contadorData.ultima_actualizacion = new Date().toISOString();
    fs.writeFileSync(CONTADOR_PATH, JSON.stringify(contadorData, null, 2), 'utf8');
  } catch (err) {
    log('[Contador] Error al guardar: ' + err.message);
  }
}

// Rate limiting en memoria: IP -> timestamp (se limpia cada hora)
const visitorIps = new Map();
const VISITOR_COOLDOWN = 60 * 60 * 1000; // 1 hora entre visitas de la misma IP

function limpiarIpsExpiradas() {
  const ahora = Date.now();
  for (const [ip, ts] of visitorIps) {
    if (ahora - ts > VISITOR_COOLDOWN) visitorIps.delete(ip);
  }
}
// Limpiar IPs expiradas cada 30 minutos
setInterval(limpiarIpsExpiradas, 30 * 60 * 1000);

/**
 * Detecta el siteId a partir del request.
 * 1. Query param ?site=xxx (para desarrollo local)
 * 2. Subdominio: tech.elpodiomp.com.ar → elpodiotech
 * 3. Hostname exacto: elpodiomp.com.ar → elpodiomp
 * 4. Fallback: elpodiomp
 */
function getSiteFromRequest(req) {
  // Permitir override por query param (útil para pruebas locales)
  if (req.query.site) {
    const config = readConfig();
    if (config.sites[req.query.site]) {
      return req.query.site;
    }
  }

  const hostname = (req.headers['x-forwarded-host'] || req.get('host') || '').toLowerCase();

  // Mapeo de subdominios conocidos
  const subdomainMap = {
    'tech': 'elpodiotech',
    'food': 'elpodiofood',
    'hogar': 'elpodiohogar',
  };

  // Detectar subdominio
  for (const [sub, siteId] of Object.entries(subdomainMap)) {
    if (hostname.startsWith(sub + '.')) {
      return siteId;
    }
  }

  // Si el hostname contiene "elpodiomp" sin subdominio, es el principal
  if (hostname.includes('elpodiomp')) {
    return 'elpodiomp';
  }

  // Fallback
  return DEFAULT_SITE;
}

/**
 * Obtiene la configuración completa de un sitio, con fallback al default.
 */
function getSiteConfig(siteId) {
  const config = readConfig();
  if (config.sites && config.sites[siteId]) {
    return config.sites[siteId];
  }
  // Fallback al sitio default
  if (config.sites && config.sites[DEFAULT_SITE]) {
    return config.sites[DEFAULT_SITE];
  }
  // Hard fallback (nunca debería llegar acá)
  return {
    name: 'El Podio MP',
    domain: 'elpodiomp.com.ar',
    description: 'Los mejores productos al mejor precio.',
    logoText: 'Elpodiomp',
    logoDomain: '.com.ar',
    logoEmoji: '🏆',
    theme: {
      headerBg: '#FFE600',
      heroBg: 'linear-gradient(135deg, #FFE600 0%, #ffcc00 100%)',
      heroTextColor: '#1a1a1a',
      heroSubColor: '#444',
      buttonBg: '#3483FA',
      buttonHover: '#2968c8',
      badgeBg: '#FFE600',
      badgeColor: '#1a1a1a',
      accentColor: '#3483FA',
      starsColor: '#FFE600',
      foodColor: '#e67e22',
      installmentsColor: '#00a650',
      footerBg: '#1a1a1a',
      footerText: '#ccc',
      footerHeading: '#ffffff',
    }
  };
}

function getCachePath(siteId) {
  return path.join(__dirname, `cache_${siteId}.html`);
}

/**
 * Reemplaza todos los tokens {{TOKEN}} en el template con los valores del sitio.
 */
function renderTemplate(template, siteConfig) {
  const config = readConfig();
  const t = siteConfig.theme;
  const ga4Id = config.ga4MeasurementId || '';
  return template
    .replace(/\{\{GA4_MEASUREMENT_ID\}\}/g, ga4Id)
    .replace(/\{\{SITE_TITLE\}\}/g, siteConfig.name)
    .replace(/\{\{SITE_DESCRIPTION\}\}/g, siteConfig.description)
    .replace(/\{\{SITE_DOMAIN\}\}/g, siteConfig.domain)
    .replace(/\{\{LOGO_TEXT\}\}/g, siteConfig.logoText)
    .replace(/\{\{LOGO_DOMAIN\}\}/g, siteConfig.logoDomain)
    .replace(/\{\{LOGO_EMOJI\}\}/g, siteConfig.logoEmoji)
    .replace(/\{\{HEADER_BG\}\}/g, t.headerBg)
    .replace(/\{\{HERO_BG\}\}/g, t.heroBg)
    .replace(/\{\{HERO_TEXT_COLOR\}\}/g, t.heroTextColor)
    .replace(/\{\{HERO_SUB_COLOR\}\}/g, t.heroSubColor)
    .replace(/\{\{BUTTON_BG\}\}/g, t.buttonBg)
    .replace(/\{\{BUTTON_HOVER\}\}/g, t.buttonHover)
    .replace(/\{\{BADGE_BG\}\}/g, t.badgeBg)
    .replace(/\{\{BADGE_COLOR\}\}/g, t.badgeColor)
    .replace(/\{\{ACCENT_COLOR\}\}/g, t.accentColor)
    .replace(/\{\{STARS_COLOR\}\}/g, t.starsColor)
    .replace(/\{\{FOOD_COLOR\}\}/g, t.foodColor)
    .replace(/\{\{INSTALLMENTS_COLOR\}\}/g, t.installmentsColor)
    .replace(/\{\{FOOTER_BG\}\}/g, t.footerBg)
    .replace(/\{\{FOOTER_TEXT\}\}/g, t.footerText)
    .replace(/\{\{FOOTER_HEADING\}\}/g, t.footerHeading);
}

function getDeterministicRating(itemId) {
  let hash = 0;
  for (let i = 0; i < itemId.length; i++) {
    hash = itemId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const ratingVal = 4.4 + (Math.abs(hash % 6) / 10);
  const rating = ratingVal.toFixed(1);
  const reviews = 80 + Math.abs(hash % 900);
  const fullStars = Math.round(ratingVal);
  let starsHtml = '';
  for (let i = 0; i < 5; i++) {
    starsHtml += i < fullStars ? '&#9733;' : '&#9734;';
  }
  return { rating, reviews, starsHtml };
}

function formatPrice(price) {
  if (!price) return '';
  return Math.round(price).toLocaleString('es-AR');
}

// ─────────────────────────────────────
// Scraper de respaldo (cuando la API falla)
// ─────────────────────────────────────
const cheerio = require('cheerio');

async function scrapeTopProducts(query) {
  try {
    const url = `https://listado.mercadolibre.com.ar/${encodeURIComponent(query)}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-AR,es;q=0.9'
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);
    const items = [];

    const cardSelectors = ['.ui-search-layout__item', '.poly-card', '.ui-search-result__wrapper', '.andes-card'];
    let cards = $();
    for (const sel of cardSelectors) {
      cards = $(sel);
      if (cards.length > 0) break;
    }

    cards.slice(0, 3).each((i, el) => {
      const $el = $(el);
      let title = $el.find('h2').first().text().trim() ||
                  $el.find('.ui-search-item__title').text().trim() ||
                  $el.find('.poly-component__title').text().trim();
      if (!title) return;

      let link = $el.find('a').first().attr('href') || '';
      if (link && link.startsWith('/')) link = 'https://mercadolibre.com.ar' + link;

      let img = $el.find('img').first();
      let imageUrl = img.attr('data-src') || img.attr('src') || '';

      let priceText = $el.find('.price-tag-fraction').first().text().trim() ||
                      $el.find('.andes-money-amount__fraction').first().text().trim();
      let price = parseInt(priceText.replace(/\D/g, '')) || 0;

      let oldPriceText = $el.find('.price-tag-line-through').text().trim() ||
                         $el.find('s .price-tag-fraction').first().text().trim();
      let oldPrice = parseInt(oldPriceText.replace(/\D/g, '')) || null;

      let installmentsText = $el.find('.ui-search-installments').text().trim() ||
                             $el.find('.poly-price__installments').text().trim() || 'Ver en El Podio MP';

      const fakeId = 'scrape_' + query + '_' + i;
      const ratingInfo = getDeterministicRating(fakeId);

      items.push({
        id: fakeId,
        title: title,
        price: price || 50000,
        oldPrice: oldPrice,
        imageUrl: imageUrl,
        badge: oldPrice ? Math.round(((oldPrice - price) / oldPrice) * 100) + '% OFF' : 'Destacado',
        rating: ratingInfo.rating,
        reviews: ratingInfo.reviews,
        starsHtml: ratingInfo.starsHtml,
        installmentsText: installmentsText,
        permalink: link,
        isInterestFree: installmentsText.includes('sin interés') ? 1 : 0
      });
    });

    return items.filter(p => p.price > 100 && p.imageUrl);
  } catch (err) {
    log(`[Scraper] Error en "${query}": ` + err.message);
    return [];
  }
}

async function refreshAccessToken() {
  const config = readConfig();
  const refreshToken = config.meliTokens?.refresh_token;
  const clientId = process.env.MELI_CLIENT_ID;
  const clientSecret = process.env.MELI_CLIENT_SECRET;

  if (!refreshToken || !clientId || !clientSecret) {
    log('[Meli] Faltan credenciales OAuth para refrescar token.');
    return null;
  }

  try {
    log('[Meli] Refrescando access_token...');
    const response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
      params: {
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken
      },
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const tokens = response.data;
    config.meliTokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in * 1000)
    };
    saveConfig(config);
    log('[Meli] Token renovado exitosamente.');
    return tokens.access_token;
  } catch (err) {
    log('[Meli] Error al renovar token: ' + (err.response?.data?.message || err.message));
    return null;
  }
}

async function getValidAccessToken() {
  const config = readConfig();
  const tokens = config.meliTokens;
  if (tokens && tokens.access_token) {
    if (tokens.expires_at && tokens.expires_at - Date.now() < 5 * 60 * 1000) {
      const refreshed = await refreshAccessToken();
      if (refreshed) return refreshed;
    }
    return tokens.access_token;
  }
  if (process.env.MELI_ACCESS_TOKEN) {
    return process.env.MELI_ACCESS_TOKEN;
  }
  return null;
}

async function fetchTopProducts(accessToken, query) {
  try {
    const response = await axios.get('https://api.mercadolibre.com/sites/MLA/search', {
      params: { q: query, limit: 20 },
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });

    let products = (response.data.results || []).filter(p => p.id && p.title && p.price);

    const processedProducts = products.map(item => {
      const isInterestFree = item.installments && item.installments.rate === 0;
      const originalPrice = item.original_price;
      const discount = originalPrice && originalPrice > item.price
        ? Math.round(((originalPrice - item.price) / originalPrice) * 100)
        : 0;

      let imageUrl = item.thumbnail || '';
      if (imageUrl.endsWith('-I.jpg')) {
        imageUrl = imageUrl.replace('-I.jpg', '-O.jpg');
      }
      if (imageUrl.startsWith('http://')) {
        imageUrl = imageUrl.replace('http://', 'https://');
      }

      let installmentsText = 'Ver en El Podio MP';
      if (item.installments) {
        if (isInterestFree) {
          installmentsText = `Hasta ${item.installments.quantity} cuotas sin interés`;
        } else {
          installmentsText = `Hasta ${item.installments.quantity} cuotas fijas`;
        }
      } else if (item.shipping && item.shipping.free_shipping) {
        installmentsText = 'Envío gratis a todo el país';
      }

      let badge = discount > 0 ? `${discount}% OFF`
        : (item.shipping && item.shipping.free_shipping) ? 'Envío Gratis'
        : 'Destacado';

      const ratingInfo = getDeterministicRating(item.id);

      return {
        id: item.id,
        title: item.title,
        price: item.price,
        oldPrice: originalPrice,
        imageUrl: imageUrl,
        badge: badge,
        rating: ratingInfo.rating,
        reviews: ratingInfo.reviews,
        starsHtml: ratingInfo.starsHtml,
        installmentsText: installmentsText,
        permalink: item.permalink,
        isInterestFree: isInterestFree ? 1 : 0
      };
    });

    processedProducts.sort((a, b) => b.isInterestFree - a.isInterestFree);
    return processedProducts.slice(0, 3);
  } catch (err) {
    log(`Error buscando "${query}": ` + (err.response?.data?.message || err.message));
    return [];
  }
}

// ─────────────────────────────────────
// Generador de HTML principal (por sitio)
// ─────────────────────────────────────
async function generatePageHtml(siteId) {
  const siteConfig = getSiteConfig(siteId);
  log(`[HTML] Generando página para ${siteId}...`);
  const config = readConfig();
  const foods = readFood();
  let template = '';

  try {
    if (fs.existsSync(TEMPLATE_PATH)) {
      template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    } else {
      throw new Error('No se encontró index.html');
    }
  } catch (err) {
    log('Error al cargar plantilla: ' + err.message);
    return '<html><body><h1>Error del servidor</h1><p>No se pudo cargar la plantilla.</p></body></html>';
  }

  // Aplicar tokens del sitio al template base
  template = renderTemplate(template, siteConfig);

  // Filtrar categorías que pertenecen a este sitio
  const siteCategories = config.categories.filter(cat =>
    cat.sites && cat.sites.includes(siteId)
  );

  const accessToken = await getValidAccessToken();
  let categoriesHtml = '';

  if (!accessToken) {
    log(`[HTML] ${siteId}: Sin token de Mercado Libre. Usando caché o mostrando aviso.`);
    const cachePath = getCachePath(siteId);
    if (fs.existsSync(cachePath)) {
      return fs.readFileSync(cachePath, 'utf8');
    }
    categoriesHtml = `
      <div style="text-align:center;padding:48px;background:#fff;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);margin:48px 0;">
        <h2 style="color:#ff3333;margin-bottom:12px;">Web en Mantenimiento</h2>
        <p>Estamos actualizando los productos. Volvé en unos minutos.</p>
      </div>`;
    return template.replace('<!-- CATEGORIES_AND_PRODUCTS -->', categoriesHtml);
  }

  for (let i = 0; i < siteCategories.length; i++) {
    const cat = siteCategories[i];
    log(`[HTML] ${siteId} - Categoría (${i + 1}/${siteCategories.length}): ${cat.name}`);

    let products = await fetchTopProducts(accessToken, cat.query);
    if (products.length === 0) {
      log(`[HTML] ${siteId}: API sin resultados para "${cat.query}", probando scraper...`);
      products = await scrapeTopProducts(cat.query);
    }
    await new Promise(r => setTimeout(r, 100));

    let cardsHtml = '';
    const catAffLink = config.categoryFallbacks[cat.id] || `https://listado.mercadolibre.com.ar/${encodeURIComponent(cat.query)}`;

    if (products.length > 0) {
      products.forEach(p => {
        const affLink = safeUrl(config.affiliateLinks[p.id] || p.permalink || catAffLink);
        const oldPriceHtml = p.oldPrice && p.oldPrice > p.price
          ? `<p class="old-price">$${formatPrice(p.oldPrice)}</p>` : '';
        cardsHtml += `
        <div class="card" onclick="window.location.href='${escapeHtml(affLink)}'">
          <img class="card-image" src="${safeUrl(p.imageUrl)}" alt="${escapeHtml(p.title)}" loading="lazy">
          <div class="card-body">
            <span class="card-badge">${escapeHtml(p.badge)}</span>
            <h3>${escapeHtml(p.title)}</h3>
            <div class="rating">
              <span class="stars">${p.starsHtml}</span>
              <span class="reviews">(${p.reviews})</span>
            </div>
            <p class="description">Calidad garantizada. Top 3 de los productos mejor valorados en ${escapeHtml(cat.name)}.</p>
            ${oldPriceHtml}
            <p class="price"><span class="price-sup">$</span>${formatPrice(p.price)}</p>
            <p class="installments">${escapeHtml(p.installmentsText)}</p>
            <button class="btn" onclick="event.stopPropagation(); window.location.href='${escapeHtml(affLink)}'">Comprar ahora</button>
          </div>
        </div>`;
      });
    } else {
      // Sin productos de API: usar datos del fixture si existen
      let fixtureProducts = [];
      try {
        if (fs.existsSync(FIXTURE_PATH)) {
          const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
          if (fixture[cat.id]) fixtureProducts = fixture[cat.id];
        }
      } catch (_) {}

      if (fixtureProducts.length > 0) {
        fixtureProducts.forEach(fp => {
          const affLink = safeUrl(fp.link || catAffLink);
          const oldPriceHtml = fp.oldPrice ? `<p class="old-price">$${formatPrice(fp.oldPrice)}</p>` : '';
          const ratingInfo = getDeterministicRating(cat.id + fp.title);
          cardsHtml += `
        <div class="card" onclick="window.location.href='${escapeHtml(affLink)}'">
          <img class="card-image" src="${safeUrl(fp.imageUrl)}" alt="${escapeHtml(fp.title)}" loading="lazy">
          <div class="card-body">
            <span class="card-badge">${escapeHtml(fp.badge || 'Destacado')}</span>
            <h3>${escapeHtml(fp.title)}</h3>
            <div class="rating">
              <span class="stars">${ratingInfo.starsHtml}</span>
              <span class="reviews">(${ratingInfo.reviews})</span>
            </div>
            <p class="description">${escapeHtml(fp.description)}</p>
            ${oldPriceHtml}
            <p class="price"><span class="price-sup">$</span>${formatPrice(fp.price)}</p>
            <p class="installments">Hasta 12 cuotas sin interés</p>
            <button class="btn" onclick="event.stopPropagation(); window.location.href='${escapeHtml(affLink)}'">Comprar ahora</button>
          </div>
        </div>`;
        });
      } else {
        // Último recurso: card genérica
        cardsHtml = `
        <div class="card" style="display:flex;align-items:center;justify-content:center;min-height:200px;cursor:pointer;" onclick="window.location.href='${escapeHtml(catAffLink)}'">
          <div style="text-align:center;padding:32px;">
            <div style="font-size:48px;margin-bottom:12px;">${escapeHtml(cat.icon)}</div>
            <h3 style="margin-bottom:8px;">${escapeHtml(cat.name)}</h3>
            <p style="color:#666;margin-bottom:12px;">Ver los mejores precios en ${escapeHtml(siteConfig.name)}</p>
            <button class="btn">Ver productos</button>
          </div>
        </div>
        <div class="card" style="display:flex;align-items:center;justify-content:center;min-height:200px;cursor:pointer;" onclick="window.location.href='${escapeHtml(catAffLink)}'">
          <div style="text-align:center;padding:32px;">
            <div style="font-size:48px;margin-bottom:12px;">🏷️</div>
            <h3 style="margin-bottom:8px;">Ofertas en ${escapeHtml(cat.name)}</h3>
            <p style="color:#666;margin-bottom:12px;">Descubrí las mejores ofertas del día</p>
            <button class="btn">Ver ofertas</button>
          </div>
        </div>
        <div class="card" style="display:flex;align-items:center;justify-content:center;min-height:200px;cursor:pointer;" onclick="window.location.href='${escapeHtml(catAffLink)}'">
          <div style="text-align:center;padding:32px;">
            <div style="font-size:48px;margin-bottom:12px;">🚚</div>
            <h3 style="margin-bottom:8px;">Envíos en ${escapeHtml(cat.name)}</h3>
            <p style="color:#666;margin-bottom:12px;">Con envío gratis y cuotas sin interés</p>
            <button class="btn">Ver productos</button>
          </div>
        </div>`;
      }
    }

    categoriesHtml += `
    <section class="section">
      <div class="section-header">
        <h2><span class="icon">${cat.icon}</span> ${cat.name}</h2>
        <a href="${catAffLink}" target="_blank" class="view-all">Ver todas &rarr;</a>
        </div>
        <div class="grid">${cardsHtml}</div>
      </section>
      <div class="divider"></div>`;
  }

  // Sección de comidas (solo para sitios que corresponda)
  const siteFoods = foods.filter(f => f.sites && f.sites.includes(siteId));
  if (siteFoods.length > 0) {
    log(`[HTML] ${siteId}: Agregando sección Comidas y Delivery...`);
    let foodCardsHtml = '';
    siteFoods.forEach(f => {
      const fullStars = Math.round(f.rating);
      let starsHtml = '';
      for (let i = 0; i < 5; i++) {
        starsHtml += i < fullStars ? '&#9733;' : '&#9734;';
      }
      const oldPriceHtml = f.oldPrice ? `<p class="old-price">$${formatPrice(f.oldPrice)}</p>` : '';
      foodCardsHtml += `
      <div class="card" onclick="window.location.href='${escapeHtml(safeUrl(f.link))}'">
        <img class="card-image" src="${safeUrl(f.imageUrl)}" alt="${escapeHtml(f.product)}" loading="lazy">
        <div class="card-body">
          <span class="card-badge" style="background:var(--food-color);color:white;">${escapeHtml(f.restaurant)}</span>
          <h3>${escapeHtml(f.product)}</h3>
          <div class="rating">
            <span class="stars" style="color:var(--food-color);">${starsHtml}</span>
            <span class="reviews">(${f.reviews})</span>
          </div>
          <p class="description">${escapeHtml(f.description)}</p>
          ${oldPriceHtml}
          <p class="price"><span class="price-sup">$</span>${formatPrice(f.price)}</p>
          <p class="installments" style="color:var(--food-color);font-weight:bold;">${escapeHtml(f.installments)}</p>
          <button class="btn" style="background:var(--food-color);" onclick="event.stopPropagation(); window.location.href='${escapeHtml(safeUrl(f.link))}'">Pedir ahora</button>
        </div>
      </div>`;
    });
    categoriesHtml += `
    <section class="section">
      <div class="section-header">
        <h2><span class="icon">🍔</span> Recomendados de Comida y Delivery</h2>
        <a href="https://pedidosya.com.ar" target="_blank" class="view-all" style="color:var(--food-color);">Ver locales &rarr;</a>
      </div>
      <div class="grid">${foodCardsHtml}</div>
    </section>`;
  }

  // Sección Oferta del Día — HERO al inicio (solo para elpodiomp)
  const ofertasDia = readOfertasDia();
  let ofertasHeroHtml = '';
  if (ofertasDia && ofertasDia.ofertas && ofertasDia.ofertas.length > 0 && siteId === 'elpodiomp') {
    log(`[HTML] ${siteId}: Agregando HERO Oferta del Día (${ofertasDia.total_ofertas} ofertas)...`);
    let ofertasCardsHtml = '';
    ofertasDia.ofertas.forEach(o => {
      const oldPriceHtml = o.descuento ? `<p class="old-price">$${formatPrice(o.precio_original)}</p>` : '';
      const descuentoBadge = o.descuento ? `<span class="card-badge" style="background:#ef4444;color:white;">-${o.descuento}%</span>` : '';
      const imageHtml = o.imagen
        ? `<img class="card-image" src="${safeUrl(o.imagen)}" alt="${escapeHtml(o.titulo)}" loading="lazy">`
        : `<div class="card-image-placeholder" style="background:var(--food-color);display:flex;align-items:center;justify-content:center;font-size:48px;">${escapeHtml(o.emoji)}</div>`;
      ofertasCardsHtml += `
      <div class="card" ${o.link ? `onclick="window.location.href='${escapeHtml(safeUrl(o.link))}'"` : ''}>
        ${imageHtml}
        <div class="card-body">
          ${descuentoBadge}
          <span class="card-badge" style="background:var(--food-color);color:white;">${escapeHtml(o.fuente)}</span>
          <h3>${escapeHtml(o.emoji)} ${escapeHtml(o.titulo)}</h3>
          <p class="description">${escapeHtml(o.razon || o.envio || '')}</p>
          ${oldPriceHtml}
          <p class="price"><span class="price-sup">$</span>${formatPrice(o.precio)}</p>
          <p class="installments" style="color:var(--food-color);font-weight:bold;">${escapeHtml(o.envio || 'Delivery disponible')}</p>
        </div>
      </div>`;
    });
    ofertasHeroHtml = `
    <section style="background:linear-gradient(135deg, #ff6b35 0%, #f97316 50%, #ea580c 100%);border-radius:16px;padding:32px 24px;margin:16px 0 32px 0;color:white;box-shadow:0 8px 32px rgba(249,115,22,0.3);">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:8px;">
        <h2 style="color:white;margin:0;font-size:28px;">🍔 Oferta del Día</h2>
        <span style="background:rgba(255,255,255,0.2);padding:6px 16px;border-radius:20px;font-size:14px;font-weight:bold;">${escapeHtml(ofertasDia.dia_semana)} ${escapeHtml(ofertasDia.fecha)}</span>
      </div>
      <p style="color:rgba(255,255,255,0.9);margin:0 0 24px 0;font-size:16px;">Las mejores hamburguesas de hoy — elegí la tuya y pedí ya 🛵</p>
      <div class="grid">${ofertasCardsHtml}</div>
      <p style="text-align:center;margin-top:20px;font-size:12px;color:rgba(255,255,255,0.7);">* Precios actualizados hoy. Disponibilidad según zona de delivery.</p>
    </section>`;
  }

  // Prepend ofertas hero al contenido de categorías
  categoriesHtml = ofertasHeroHtml + categoriesHtml;

  const finalHtml = template.replace('<!-- CATEGORIES_AND_PRODUCTS -->', categoriesHtml);

  // Guardar caché por sitio
  try {
    const cachePath = getCachePath(siteId);
    fs.writeFileSync(cachePath, finalHtml, 'utf8');
  } catch (_) {}

  return finalHtml;
}

// ─────────────────────────────────────
// Sitemap dinámico (por sitio)
// ─────────────────────────────────────
function generateSitemap(siteId) {
  const config = readConfig();
  const siteConfig = getSiteConfig(siteId);
  const baseUrl = `https://${siteConfig.domain}`;
  const siteCategories = config.categories.filter(cat =>
    cat.sites && cat.sites.includes(siteId)
  );

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  xml += `  <url><loc>${baseUrl}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>\n`;
  xml += `  <url><loc>${baseUrl}/privacidad</loc><changefreq>monthly</changefreq><priority>0.3</priority></url>\n`;
  xml += `  <url><loc>${baseUrl}/terminos</loc><changefreq>monthly</changefreq><priority>0.3</priority></url>\n`;
  xml += '  <!-- Categorías -->\n';
  siteCategories.forEach(cat => {
    xml += `  <url><loc>${baseUrl}/buscar/${encodeURIComponent(cat.query)}</loc><changefreq>daily</changefreq><priority>0.8</priority></url>\n`;
  });
  xml += '</urlset>';
  return xml;
}

// ─────────────────────────────────────
// RUTAS
// ─────────────────────────────────────

// Robots.txt
app.get('/robots.txt', (req, res) => {
  const siteId = getSiteFromRequest(req);
  const siteConfig = getSiteConfig(siteId);
  const baseUrl = `https://${siteConfig.domain}`;
  res.type('text/plain');
  res.send(`User-agent: *
Allow: /
Sitemap: ${baseUrl}/sitemap.xml
`);
});

// Sitemap
app.get('/sitemap.xml', (req, res) => {
  const siteId = getSiteFromRequest(req);
  res.type('application/xml');
  res.send(generateSitemap(siteId));
});

// Página de privacidad
app.get('/privacidad', (req, res) => {
  const siteId = getSiteFromRequest(req);
  const siteConfig = getSiteConfig(siteId);
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Política de Privacidad — ${siteConfig.domain}</title>
  <style>
    body { font-family: 'Inter', sans-serif; max-width: 800px; margin: 48px auto; padding: 0 24px; color: #333; line-height: 1.7; }
    h1 { color: #1a1a1a; border-bottom: 3px solid ${siteConfig.theme.headerBg}; padding-bottom: 12px; }
    a { color: ${siteConfig.theme.accentColor}; }
  </style>
</head>
<body>
  <h1>Política de Privacidad</h1>
  <p><strong>Última actualización:</strong> Junio 2026</p>
  <p>En <strong>${siteConfig.domain}</strong> no recopilamos datos personales directamente. Actuamos como sitio afiliado de Mercado Libre: cuando hacés clic en un producto, sos redirigido a Mercado Libre, donde aplican sus propias políticas de privacidad.</p>
  <p>Podemos utilizar Google Analytics para medir visitas de forma anónima. No compartimos información con terceros.</p>
  <p><strong>Cookies:</strong> No usamos cookies propias. Mercado Libre puede establecer cookies al seguir un enlace de afiliado.</p>
  <p>Consultas: <a href="mailto:info@${siteConfig.domain}">info@${siteConfig.domain}</a></p>
  <p><a href="/">&larr; Volver al inicio</a></p>
</body>
</html>`);
});

// Página de términos
app.get('/terminos', (req, res) => {
  const siteId = getSiteFromRequest(req);
  const siteConfig = getSiteConfig(siteId);
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Términos y Condiciones — ${siteConfig.domain}</title>
  <style>
    body { font-family: 'Inter', sans-serif; max-width: 800px; margin: 48px auto; padding: 0 24px; color: #333; line-height: 1.7; }
    h1 { color: #1a1a1a; border-bottom: 3px solid ${siteConfig.theme.headerBg}; padding-bottom: 12px; }
    a { color: ${siteConfig.theme.accentColor}; }
  </style>
</head>
<body>
  <h1>Términos y Condiciones</h1>
  <p><strong>Última actualización:</strong> Junio 2026</p>
  <p><strong>${siteConfig.domain}</strong> es un sitio afiliado de Mercado Libre. No vendemos productos directamente: mostramos productos de Mercado Libre y recibimos una comisión por compras realizadas a través de nuestros enlaces, sin costo adicional para vos.</p>
  <p>Todas las compras se realizan en la plataforma de Mercado Libre y están sujetas a sus términos y condiciones. No gestionamos envíos, devoluciones ni garantías.</p>
  <p>Los precios mostrados son aproximados y pueden variar al ingresar a Mercado Libre.</p>
  <p>Consultas: <a href="mailto:info@${siteConfig.domain}">info@${siteConfig.domain}</a></p>
  <p><a href="/">&larr; Volver al inicio</a></p>
</body>
</html>`);
});

// Búsqueda funcional
app.get('/buscar/:query', async (req, res) => {
  const query = req.params.query;
  const siteId = getSiteFromRequest(req);
  const siteConfig = getSiteConfig(siteId);
  const accessToken = await getValidAccessToken();

  if (!accessToken) {
    return res.status(503).send('<html><body><h1>Servicio no disponible</h1><p>Estamos actualizando los productos. <a href="/">Volver.</a></p></body></html>');
  }

  try {
    let products = await fetchTopProducts(accessToken, query);
    if (products.length === 0) {
      products = await scrapeTopProducts(query);
    }
    const config = readConfig();
    let cardsHtml = '';

    if (products.length === 0) {
      cardsHtml = '<p style="text-align:center;padding:48px;">No encontramos productos para <strong>' + escapeHtml(query) + '</strong>. <a href="/">Volver al inicio.</a></p>';
    } else {
      products.forEach(p => {
        const affLink = safeUrl(config.affiliateLinks[p.id] || p.permalink);
        const oldPriceHtml = p.oldPrice && p.oldPrice > p.price
          ? `<p class="old-price">$${formatPrice(p.oldPrice)}</p>` : '';
        cardsHtml += `
        <div class="card" onclick="window.location.href='${affLink}'">
          <img class="card-image" src="${p.imageUrl}" alt="${p.title}" loading="lazy">
          <div class="card-body">
            <span class="card-badge">${p.badge}</span>
            <h3>${p.title}</h3>
            <div class="rating">
              <span class="stars">${p.starsHtml}</span>
              <span class="reviews">(${p.reviews})</span>
            </div>
            ${oldPriceHtml}
            <p class="price"><span class="price-sup">$</span>${formatPrice(p.price)}</p>
            <p class="installments">${p.installmentsText}</p>
            <button class="btn" onclick="event.stopPropagation(); window.location.href='${affLink}'">Comprar ahora</button>
          </div>
        </div>`;
      });
    }

    let template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    template = renderTemplate(template, siteConfig);
    const resultHtml = template.replace('<!-- CATEGORIES_AND_PRODUCTS -->', `
      <section class="section">
        <div class="section-header">
          <h2>🔍 Resultados para: "${query}"</h2>
          <a href="/" class="view-all">&larr; Volver al inicio</a>
        </div>
        <div class="grid">${cardsHtml}</div>
      </section>
    `);
    res.send(resultHtml);
  } catch (err) {
    log('Error en búsqueda: ' + err.message);
    res.status(500).send('<html><body><h1>Error</h1><p>No se pudo realizar la búsqueda. <a href="/">Volver.</a></p></body></html>');
  }
});

// API: búsqueda JSON para la search bar (vía fetch)
app.get('/api/buscar', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ results: [] });

  const accessToken = await getValidAccessToken();
  if (!accessToken) return res.json({ results: [], error: 'Sin conexión a Mercado Libre' });

  try {
    const response = await axios.get('https://api.mercadolibre.com/sites/MLA/search', {
      params: { q: query, limit: 6 },
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    });

    const results = (response.data.results || []).filter(p => p.id && p.title && p.price).slice(0, 6).map(item => ({
      id: item.id,
      title: item.title,
      price: item.price,
      permalink: item.permalink,
      imageUrl: (item.thumbnail || '').replace('-I.jpg', '-O.jpg').replace('http://', 'https://'),
      rating: getDeterministicRating(item.id).rating,
      reviews: getDeterministicRating(item.id).reviews,
    }));

    res.json({ results });
  } catch (err) {
    res.json({ results: [], error: 'Error al buscar' });
  }
});

// Ruta principal — sirve caché por sitio, regenera en background
app.get('/', async (req, res) => {
  const siteId = getSiteFromRequest(req);
  const siteConfig = getSiteConfig(siteId);
  const cachePath = getCachePath(siteId);

  // Siempre servir cache_${siteId}.html del disco si existe
  if (fs.existsSync(cachePath)) {
    try {
      let html = fs.readFileSync(cachePath, 'utf8');
      html = injectCounterCode(html);
      res.send(html);

      // Regenerar en background SOLO si pasaron 6h (no bloquea la respuesta)
      const lastFetch = lastFetchBySite[siteId] || 0;
      if (Date.now() - lastFetch > CACHE_DURATION) {
        lastFetchBySite[siteId] = Date.now();
        generatePageHtml(siteId).then(newHtml => {
          cacheBySite[siteId] = newHtml;
          log(`[Cache] ${siteId}: Regenerada en background.`);
        }).catch(err => log(`[Cache] ${siteId}: Error en regeneración: ` + err.message));
      }
      return;
    } catch (_) {}
  }

  // Si no hay archivo en disco, usar la versión en memoria
  if (cacheBySite[siteId]) {
    let html = cacheBySite[siteId];
    html = injectCounterCode(html);
    res.send(html);
    return;
  }

  // Último recurso: regenerar dinámicamente
  try {
    let html = await generatePageHtml(siteId);
    cacheBySite[siteId] = html;
    lastFetchBySite[siteId] = Date.now();
    html = injectCounterCode(html);
    res.send(html);
  } catch (err) {
    log(`Error generando HTML para ${siteId}: ` + err.message);
    res.status(503).send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>En mantenimiento — ${siteConfig.domain}</title>
<style>body{font-family:'Inter',sans-serif;text-align:center;padding:80px 24px;color:#333;background:#f5f5f5;}h1{font-size:48px;color:${siteConfig.theme.headerBg};text-shadow:2px 2px 0 #1a1a1a;}</style>
</head><body><h1>Volvemos pronto</h1><p>Estamos actualizando los productos. Recargá en unos segundos.</p></body></html>`);
  }
});


// API: contador de visitas (GET = leer, POST = incrementar)
app.get('/api/visitas', (req, res) => {
  res.json({ visitas: contadorData.visitas });
});

app.post('/api/visitas', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.ip || 'desconocida';
  const clientIp = ip.split(',')[0].trim();

  // Verificar rate limiting por IP
  limpiarIpsExpiradas();
  if (visitorIps.has(clientIp)) {
    return res.json({ ok: false, motivo: 'rate_limited', visitas: contadorData.visitas });
  }

  // Incrementar contador
  visitorIps.set(clientIp, Date.now());
  contadorData.visitas = (contadorData.visitas || 0) + 1;
  saveContador();

  log(`[Contador] +1 visita de ${clientIp} → Total: ${contadorData.visitas}`);

  res.json({ ok: true, visitas: contadorData.visitas });
});

// ─────────────────────────────────────
// 404 — siempre al final
// ─────────────────────────────────────
app.use((req, res) => {
  const siteId = getSiteFromRequest(req);
  const siteConfig = getSiteConfig(siteId);
  res.status(404).send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Página no encontrada — ${siteConfig.domain}</title>
  <style>
    body { font-family: 'Inter', sans-serif; text-align: center; padding: 80px 24px; color: #333; background: #f5f5f5; }
    h1 { font-size: 72px; color: ${siteConfig.theme.headerBg}; margin: 0; text-shadow: 2px 2px 0 #1a1a1a; }
    p { margin: 16px 0; font-size: 18px; }
    a { color: ${siteConfig.theme.accentColor}; text-decoration: none; font-weight: 600; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>404</h1>
  <p>La página que buscás no existe o fue movida.</p>
  <p><a href="/">&larr; Volver al inicio</a></p>
</body>
</html>`);
});

// ─────────────────────────────────────
// Variables de caché por sitio
// ─────────────────────────────────────
let cacheBySite = {};
let lastFetchBySite = {};
const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 horas

// Al iniciar, cargar todas las cachés existentes del disco
(function loadAllCaches() {
  const config = readConfig();
  const siteIds = config.sites ? Object.keys(config.sites) : [DEFAULT_SITE];
  siteIds.forEach(siteId => {
    const cachePath = getCachePath(siteId);
    if (fs.existsSync(cachePath)) {
      try {
        cacheBySite[siteId] = fs.readFileSync(cachePath, 'utf8');
        lastFetchBySite[siteId] = fs.statSync(cachePath).mtimeMs;
        log(`[Cache] ${siteId}: Cargada del disco (${cacheBySite[siteId].length} bytes).`);
      } catch (_) {}
    }
  });
  if (Object.keys(cacheBySite).length === 0) {
    log('[Cache] No se encontraron cachés preexistentes.');
  }
})();

// Cargar contador de visitas al iniciar
loadContador();

/**
 * Inyecta el código del contador de visitas en HTML cacheado que no lo tenga.
 * Asegura que el contador aparezca incluso en cachés generadas antes de esta feature.
 */
function injectCounterCode(html) {
  if (html.includes('visit-counter')) return html; // ya tiene el contador

  const counterDiv = `<div class="visit-counter" id="visitCounter" style="margin-bottom:12px;font-size:14px;color:#888;text-align:center;">👀 <span id="visitCount">...</span> visitas</div>`;

  const counterScript = `<script>
(function() {
  var VISIT_KEY='elpodiomp_visit_'+new Date().toISOString().split('T')[0];
  var el=document.getElementById('visitCount');
  function mostrar(){fetch('/api/visitas').then(function(r){return r.json()}).then(function(d){if(el)el.textContent=d.visitas.toLocaleString('es-AR')}).catch(function(){if(el)el.textContent='...'})}
  function registrar(){
    if(localStorage.getItem(VISIT_KEY)){mostrar();return}
    fetch('/api/visitas',{method:'POST'}).then(function(r){return r.json()}).then(function(d){
      if(d.ok){localStorage.setItem(VISIT_KEY,'1');if(el)el.textContent=d.visitas.toLocaleString('es-AR')}
      else{if(el)el.textContent=d.visitas.toLocaleString('es-AR')}
    }).catch(function(){mostrar()})
  }
  registrar();
})();
</script>`;

  // Insertar el div contador justo antes del cierre </footer>
  let result = html.replace('</footer>', counterDiv + '\n</footer>');
  // Insertar el script antes del cierre </body>
  result = result.replace('</body>', counterScript + '\n</body>');
  return result;
}

// ─────────────────────────────────────
// Iniciar servidor
// ─────────────────────────────────────
app.listen(PORT, () => {
  const config = readConfig();
  const siteIds = config.sites ? Object.keys(config.sites) : [DEFAULT_SITE];
  log('═'.repeat(50));
  log(`🚀 Servidor multi-sitio listo en puerto ${PORT}`);
  siteIds.forEach(siteId => {
    const siteConfig = getSiteConfig(siteId);
    log(`   ${siteId}: https://${siteConfig.domain}`);
  });
  log(`   Admin: http://localhost:${PORT}/admin`);
  log('═'.repeat(50));
});
