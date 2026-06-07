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
const TEMPLATE_PATH = path.join(__dirname, 'index.html');
const FIXTURE_PATH = path.join(__dirname, 'products-fixture.json');
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

// Rate limiting más estricto para admin
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Demasiados intentos al panel admin. Esperá 15 minutos.',
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir archivos estáticos desde la raíz (index: false para que no sirva index.html sin pasar por el generador)
app.use(express.static(__dirname, {
  index: false,
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.json')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
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
  const t = siteConfig.theme;
  return template
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
        const affLink = config.affiliateLinks[p.id] || p.permalink || catAffLink;
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
            <p class="description">Calidad garantizada. Top 3 de los productos mejor valorados en ${cat.name}.</p>
            ${oldPriceHtml}
            <p class="price"><span class="price-sup">$</span>${formatPrice(p.price)}</p>
            <p class="installments">${p.installmentsText}</p>
            <button class="btn" onclick="event.stopPropagation(); window.location.href='${affLink}'">Comprar ahora</button>
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
          const affLink = fp.link || catAffLink;
          const oldPriceHtml = fp.oldPrice ? `<p class="old-price">$${formatPrice(fp.oldPrice)}</p>` : '';
          const ratingInfo = getDeterministicRating(cat.id + fp.title);
          cardsHtml += `
        <div class="card" onclick="window.location.href='${affLink}'">
          <img class="card-image" src="${fp.imageUrl}" alt="${fp.title}" loading="lazy">
          <div class="card-body">
            <span class="card-badge">${fp.badge || 'Destacado'}</span>
            <h3>${fp.title}</h3>
            <div class="rating">
              <span class="stars">${ratingInfo.starsHtml}</span>
              <span class="reviews">(${ratingInfo.reviews})</span>
            </div>
            <p class="description">${fp.description}</p>
            ${oldPriceHtml}
            <p class="price"><span class="price-sup">$</span>${formatPrice(fp.price)}</p>
            <p class="installments">Hasta 12 cuotas sin interés</p>
            <button class="btn" onclick="event.stopPropagation(); window.location.href='${affLink}'">Comprar ahora</button>
          </div>
        </div>`;
        });
      } else {
        // Último recurso: card genérica
        cardsHtml = `
        <div class="card" style="display:flex;align-items:center;justify-content:center;min-height:200px;cursor:pointer;" onclick="window.location.href='${catAffLink}'">
          <div style="text-align:center;padding:32px;">
            <div style="font-size:48px;margin-bottom:12px;">${cat.icon}</div>
            <h3 style="margin-bottom:8px;">${cat.name}</h3>
            <p style="color:#666;margin-bottom:12px;">Ver los mejores precios en ${siteConfig.name}</p>
            <button class="btn">Ver productos</button>
          </div>
        </div>
        <div class="card" style="display:flex;align-items:center;justify-content:center;min-height:200px;cursor:pointer;" onclick="window.location.href='${catAffLink}'">
          <div style="text-align:center;padding:32px;">
            <div style="font-size:48px;margin-bottom:12px;">🏷️</div>
            <h3 style="margin-bottom:8px;">Ofertas en ${cat.name}</h3>
            <p style="color:#666;margin-bottom:12px;">Descubrí las mejores ofertas del día</p>
            <button class="btn">Ver ofertas</button>
          </div>
        </div>
        <div class="card" style="display:flex;align-items:center;justify-content:center;min-height:200px;cursor:pointer;" onclick="window.location.href='${catAffLink}'">
          <div style="text-align:center;padding:32px;">
            <div style="font-size:48px;margin-bottom:12px;">🚚</div>
            <h3 style="margin-bottom:8px;">Envíos en ${cat.name}</h3>
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
      <div class="card" onclick="window.location.href='${f.link}'">
        <img class="card-image" src="${f.imageUrl}" alt="${f.product}" loading="lazy">
        <div class="card-body">
          <span class="card-badge" style="background:var(--food-color);color:white;">${f.restaurant}</span>
          <h3>${f.product}</h3>
          <div class="rating">
            <span class="stars" style="color:var(--food-color);">${starsHtml}</span>
            <span class="reviews">(${f.reviews})</span>
          </div>
          <p class="description">${f.description}</p>
          ${oldPriceHtml}
          <p class="price"><span class="price-sup">$</span>${formatPrice(f.price)}</p>
          <p class="installments" style="color:var(--food-color);font-weight:bold;">${f.installments}</p>
          <button class="btn" style="background:var(--food-color);" onclick="event.stopPropagation(); window.location.href='${f.link}'">Pedir ahora</button>
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
Disallow: /admin
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
      cardsHtml = '<p style="text-align:center;padding:48px;">No encontramos productos para <strong>' + query + '</strong>. <a href="/">Volver al inicio.</a></p>';
    } else {
      products.forEach(p => {
        const affLink = config.affiliateLinks[p.id] || p.permalink;
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
      const html = fs.readFileSync(cachePath, 'utf8');
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
    res.send(cacheBySite[siteId]);
    return;
  }

  // Último recurso: regenerar dinámicamente
  try {
    const html = await generatePageHtml(siteId);
    cacheBySite[siteId] = html;
    lastFetchBySite[siteId] = Date.now();
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

// ─────────────────────────────────────
// Middleware de autenticación para admin
// ─────────────────────────────────────
function adminAuth(req, res, next) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || req.query.key === password) {
    return next();
  }
  res.status(401).send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Acceso Restringido</title>
<style>body{font-family:'Inter',sans-serif;text-align:center;padding:80px 24px;color:#333;background:#f5f5f5;}h1{font-size:48px;color:#1a1a1a;}p{margin:16px 0;}</style>
</head><body><h1>🔒 Acceso Restringido</h1><p>Necesitás una clave para entrar al panel de administración.</p></body></html>`);
}

// ─────────────────────────────────────
// Panel admin (protegido con rate limit + contraseña)
// ─────────────────────────────────────
app.get('/admin', adminLimiter, adminAuth, (req, res) => {
  const siteId = getSiteFromRequest(req);
  const siteConfig = getSiteConfig(siteId);
  const config = readConfig();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const redirectUri = `https://${host}/admin/callback`;
  const clientId = process.env.MELI_CLIENT_ID;

  let authSectionHtml = '';
  if (config.meliTokens && config.meliTokens.access_token) {
    authSectionHtml = `<div style="background:#e3f2fd;border-left:4px solid #1976d2;padding:16px;border-radius:4px;margin-bottom:24px;">
      <h3 style="color:#0d47a1;margin-top:0;">✓ Conectado a Mercado Libre</h3>
      <p style="margin:4px 0 0 0;font-size:14px;">El token está activo y se renovará automáticamente.</p>
    </div>`;
  } else if (!clientId) {
    authSectionHtml = `<div style="background:#ffebee;border-left:4px solid #f44336;padding:16px;border-radius:4px;margin-bottom:24px;">
      <h3 style="color:#c62828;margin-top:0;">✗ Falta configuración</h3>
      <p style="margin:4px 0 0 0;font-size:14px;">Definí <strong>MELI_CLIENT_ID</strong> en las variables de entorno.</p>
    </div>`;
  } else {
    const authUrl = `https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read`;
    authSectionHtml = `<div style="background:#fff3e0;border-left:4px solid #ff9800;padding:16px;border-radius:4px;margin-bottom:24px;">
      <h3 style="color:#e65100;margin-top:0;">Acceso Requerido</h3>
      <p style="margin:4px 0 16px 0;font-size:14px;">Vinculá tu cuenta de Mercado Libre para activar los productos.</p>
      <a href="${authUrl}" style="background:${siteConfig.theme.buttonBg};color:white;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block;">Conectar con Mercado Libre</a>
    </div>`;
  }

  let linksListHtml = '';
  config.categories.forEach(cat => {
    linksListHtml += `<div style="margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #eee;">
      <label style="font-weight:bold;display:block;margin-bottom:4px;">${cat.icon} Link Afiliado - ${cat.name}:</label>
      <input type="text" name="fallback_${cat.id}" value="${config.categoryFallbacks[cat.id] || ''}" placeholder="Pegá tu link de afiliado de ${cat.name}" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:4px;">
    </div>`;
  });

  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Panel Admin — ${siteConfig.domain}</title>
  <style>
    body { font-family: sans-serif; background: #f5f5f5; color: #333; margin: 0; padding: 24px; }
    .container { max-width: 800px; margin: 0 auto; background: white; padding: 32px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
    h1 { border-bottom: 2px solid ${siteConfig.theme.headerBg}; padding-bottom: 12px; margin-top: 0; }
    .btn-submit { background: #00a650; color: white; border: none; padding: 12px 24px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 16px; }
    .btn-submit:hover { background: #008f45; }
    .btn-clear { background: #ff4444; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; margin-left: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Panel de Administración — ${siteConfig.domain}</h1>
    ${authSectionHtml}
    <form action="/admin/save" method="POST">
      <h2>Enlaces de Afiliado por Categoría</h2>
      <p style="color:#666;font-size:14px;margin-bottom:20px;">Estos links se usan como destino de los productos cuando no hay un link individual cargado. <strong>Son obligatorios para monetizar.</strong></p>
      ${linksListHtml}
      <button type="submit" class="btn-submit">Guardar Enlaces</button>
      <a href="/admin/clear-cache" class="btn-clear" style="text-decoration:none;color:white;display:inline-block;margin-top:12px;">Limpiar Caché</a>
    </form>
    <p style="margin-top:24px;font-size:13px;color:#999;"><a href="/">&larr; Ir a la web</a></p>
  </div>
</body>
</html>`);
});

app.post('/admin/save', adminLimiter, adminAuth, (req, res) => {
  const config = readConfig();
  Object.keys(req.body).forEach(key => {
    if (key.startsWith('fallback_')) {
      const catId = key.replace('fallback_', '');
      config.categoryFallbacks[catId] = req.body[key];
    }
  });
  saveConfig(config);
  // Limpiar todas las cachés
  cacheBySite = {};
  lastFetchBySite = {};
  res.send('<script>alert("Enlaces guardados. Todas las cachés se limpiaron."); window.location.href="/admin";</script>');
});

app.get('/admin/callback', async (req, res) => {
  const code = req.query.code;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const redirectUri = `https://${host}/admin/callback`;
  const clientId = process.env.MELI_CLIENT_ID;
  const clientSecret = process.env.MELI_CLIENT_SECRET;

  if (!code) return res.status(400).send('Error: Código de autorización ausente.');

  try {
    log('[Meli] Intercambiando código OAuth por tokens...');
    const response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
      params: { grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri },
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const tokens = response.data;
    const config = readConfig();
    config.meliTokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in * 1000)
    };
    saveConfig(config);
    cacheBySite = {};
    lastFetchBySite = {};
    log('[Meli] Cuenta vinculada con éxito.');
    res.send('<script>alert("¡Cuenta vinculada exitosamente!"); window.location.href="/admin";</script>');
  } catch (err) {
    log('[Meli] Error en callback OAuth: ' + (err.response?.data?.message || err.message));
    res.status(500).send(`Error de autenticación: ${err.message}`);
  }
});

app.get('/admin/clear-cache', (req, res) => {
  cacheBySite = {};
  lastFetchBySite = {};
  res.send('<script>alert("Todas las cachés fueron limpiadas."); window.location.href="/admin";</script>');
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
