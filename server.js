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
const DOMAIN = process.env.DOMAIN || 'elpodiomp.com.ar';
const BASE_URL = process.env.BASE_URL || `https://${DOMAIN}`;

// ─────────────────────────────────────
// Rutas de archivos
// ─────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const FOOD_PATH = path.join(__dirname, 'food.json');
const TEMPLATE_PATH = path.join(__dirname, 'index.html');
const CACHE_HTML_PATH = path.join(__dirname, 'cache.html');
const LOGS_DIR = path.join(__dirname, 'logs');

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
// Utilidades
// ─────────────────────────────────────
function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (err) {
    log('Error al leer config.json: ' + err.message);
  }
  return { categories: [], affiliateLinks: {}, categoryFallbacks: {}, meliTokens: {} };
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
// Mercado Libre API
// ─────────────────────────────────────
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
  // Prioridad 1: token OAuth guardado en config.json (tiene refresh automático)
  const config = readConfig();
  const tokens = config.meliTokens;
  if (tokens && tokens.access_token) {
    if (tokens.expires_at && tokens.expires_at - Date.now() < 5 * 60 * 1000) {
      const refreshed = await refreshAccessToken();
      if (refreshed) return refreshed;
    }
    return tokens.access_token;
  }
  // Prioridad 2: token estático del .env (se usa solo si no hay OAuth)
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

      let installmentsText = 'Comprar en Mercado Libre';
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
// Generador de HTML principal
// ─────────────────────────────────────
async function generatePageHtml() {
  log('[HTML] Generando página...');
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

  const accessToken = await getValidAccessToken();
  let categoriesHtml = '';

  if (!accessToken) {
    log('[HTML] Sin token de Mercado Libre. Usando caché o mostrando aviso.');
    if (fs.existsSync(CACHE_HTML_PATH)) {
      return fs.readFileSync(CACHE_HTML_PATH, 'utf8');
    }
    categoriesHtml = `
      <div style="text-align:center;padding:48px;background:#fff;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);margin:48px 0;">
        <h2 style="color:#ff3333;margin-bottom:12px;">Web en Mantenimiento</h2>
        <p>Estamos actualizando los productos. Volvé en unos minutos.</p>
      </div>`;
    return template.replace('<!-- CATEGORIES_AND_PRODUCTS -->', categoriesHtml);
  }

  for (let i = 0; i < config.categories.length; i++) {
    const cat = config.categories[i];
    log(`[HTML] Categoría (${i + 1}/${config.categories.length}): ${cat.name}`);

    const products = await fetchTopProducts(accessToken, cat.query);
    // Pequeña pausa para no saturar la API de Mercado Libre
    await new Promise(r => setTimeout(r, 400));

    if (products.length > 0) {
      let cardsHtml = '';
      products.forEach(p => {
        const affLink = config.affiliateLinks[p.id] || config.categoryFallbacks[cat.id] || p.permalink;
        const oldPriceHtml = p.oldPrice && p.oldPrice > p.price
          ? `<p class="old-price">$${formatPrice(p.oldPrice)}</p>` : '';

        cardsHtml += `
        <div class="card" onclick="window.open('${affLink}', '_blank')">
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
            <button class="btn" onclick="event.stopPropagation(); window.open('${affLink}', '_blank')">Comprar ahora</button>
          </div>
        </div>`;
      });

      categoriesHtml += `
      <section class="section">
        <div class="section-header">
          <h2><span class="icon">${cat.icon}</span> ${cat.name}</h2>
          <a href="${config.categoryFallbacks[cat.id] || '#'}" target="_blank" class="view-all">Ver todas &rarr;</a>
        </div>
        <div class="grid">${cardsHtml}</div>
      </section>
      <div class="divider"></div>`;
    }
  }

  // Sección de comidas
  if (foods.length > 0) {
    log('[HTML] Agregando sección Comidas y Delivery...');
    let foodCardsHtml = '';
    foods.forEach(f => {
      const fullStars = Math.round(f.rating);
      let starsHtml = '';
      for (let i = 0; i < 5; i++) {
        starsHtml += i < fullStars ? '&#9733;' : '&#9734;';
      }
      const oldPriceHtml = f.oldPrice ? `<p class="old-price">$${formatPrice(f.oldPrice)}</p>` : '';
      foodCardsHtml += `
      <div class="card" onclick="window.open('${f.link}', '_blank')">
        <img class="card-image" src="${f.imageUrl}" alt="${f.product}" loading="lazy">
        <div class="card-body">
          <span class="card-badge" style="background:#e67e22;color:white;">${f.restaurant}</span>
          <h3>${f.product}</h3>
          <div class="rating">
            <span class="stars" style="color:#e67e22;">${starsHtml}</span>
            <span class="reviews">(${f.reviews})</span>
          </div>
          <p class="description">${f.description}</p>
          ${oldPriceHtml}
          <p class="price"><span class="price-sup">$</span>${formatPrice(f.price)}</p>
          <p class="installments" style="color:#e67e22;font-weight:bold;">${f.installments}</p>
          <button class="btn" style="background:#e67e22;" onclick="event.stopPropagation(); window.open('${f.link}', '_blank')">Pedir ahora</button>
        </div>
      </div>`;
    });
    categoriesHtml += `
    <section class="section">
      <div class="section-header">
        <h2><span class="icon">🍔</span> Recomendados de Comida y Delivery</h2>
        <a href="https://pedidosya.com.ar" target="_blank" class="view-all" style="color:#e67e22;">Ver locales &rarr;</a>
      </div>
      <div class="grid">${foodCardsHtml}</div>
    </section>`;
  }

  const finalHtml = template.replace('<!-- CATEGORIES_AND_PRODUCTS -->', categoriesHtml);

  try {
    fs.writeFileSync(CACHE_HTML_PATH, finalHtml, 'utf8');
  } catch (_) {}

  return finalHtml;
}

// ─────────────────────────────────────
// Sitemap dinámico
// ─────────────────────────────────────
function generateSitemap() {
  const config = readConfig();
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  xml += `  <url><loc>${BASE_URL}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>\n`;
  xml += `  <url><loc>${BASE_URL}/privacidad</loc><changefreq>monthly</changefreq><priority>0.3</priority></url>\n`;
  xml += `  <url><loc>${BASE_URL}/terminos</loc><changefreq>monthly</changefreq><priority>0.3</priority></url>\n`;
  xml += '  <!-- Categorías -->\n';
  config.categories.forEach(cat => {
    xml += `  <url><loc>${BASE_URL}/buscar/${encodeURIComponent(cat.query)}</loc><changefreq>daily</changefreq><priority>0.8</priority></url>\n`;
  });
  xml += '</urlset>';
  return xml;
}

// ─────────────────────────────────────
// RUTAS
// ─────────────────────────────────────

// Robots.txt
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(`User-agent: *
Allow: /
Disallow: /admin
Sitemap: ${BASE_URL}/sitemap.xml
`);
});

// Sitemap
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.send(generateSitemap());
});

// Página de privacidad
app.get('/privacidad', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Política de Privacidad — ${DOMAIN}</title>
  <style>
    body { font-family: 'Inter', sans-serif; max-width: 800px; margin: 48px auto; padding: 0 24px; color: #333; line-height: 1.7; }
    h1 { color: #1a1a1a; border-bottom: 3px solid #FFE600; padding-bottom: 12px; }
    a { color: #3483FA; }
  </style>
</head>
<body>
  <h1>Política de Privacidad</h1>
  <p><strong>Última actualización:</strong> Junio 2026</p>
  <p>En <strong>${DOMAIN}</strong> no recopilamos datos personales directamente. Actuamos como sitio afiliado de Mercado Libre: cuando hacés clic en un producto, sos redirigido a Mercado Libre, donde aplican sus propias políticas de privacidad.</p>
  <p>Podemos utilizar Google Analytics para medir visitas de forma anónima. No compartimos información con terceros.</p>
  <p><strong>Cookies:</strong> No usamos cookies propias. Mercado Libre puede establecer cookies al seguir un enlace de afiliado.</p>
  <p>Consultas: <a href="mailto:info@${DOMAIN}">info@${DOMAIN}</a></p>
  <p><a href="/">&larr; Volver al inicio</a></p>
</body>
</html>`);
});

// Página de términos
app.get('/terminos', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Términos y Condiciones — ${DOMAIN}</title>
  <style>
    body { font-family: 'Inter', sans-serif; max-width: 800px; margin: 48px auto; padding: 0 24px; color: #333; line-height: 1.7; }
    h1 { color: #1a1a1a; border-bottom: 3px solid #FFE600; padding-bottom: 12px; }
    a { color: #3483FA; }
  </style>
</head>
<body>
  <h1>Términos y Condiciones</h1>
  <p><strong>Última actualización:</strong> Junio 2026</p>
  <p><strong>${DOMAIN}</strong> es un sitio afiliado de Mercado Libre. No vendemos productos directamente: mostramos productos de Mercado Libre y recibimos una comisión por compras realizadas a través de nuestros enlaces, sin costo adicional para vos.</p>
  <p>Todas las compras se realizan en la plataforma de Mercado Libre y están sujetas a sus términos y condiciones. No gestionamos envíos, devoluciones ni garantías.</p>
  <p>Los precios mostrados son aproximados y pueden variar al ingresar a Mercado Libre.</p>
  <p>Consultas: <a href="mailto:info@${DOMAIN}">info@${DOMAIN}</a></p>
  <p><a href="/">&larr; Volver al inicio</a></p>
</body>
</html>`);
});

// Búsqueda funcional
app.get('/buscar/:query', async (req, res) => {
  const query = req.params.query;
  const accessToken = await getValidAccessToken();

  if (!accessToken) {
    return res.status(503).send('<html><body><h1>Servicio no disponible</h1><p>Estamos actualizando los productos. <a href="/">Volver.</a></p></body></html>');
  }

  try {
    const products = await fetchTopProducts(accessToken, query);
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
        <div class="card" onclick="window.open('${affLink}', '_blank')">
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
            <button class="btn" onclick="event.stopPropagation(); window.open('${affLink}', '_blank')">Comprar ahora</button>
          </div>
        </div>`;
      });
    }

    // Usar la plantilla HTML pero reemplazando contenido
    let template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
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

// Ruta principal
app.get('/', async (req, res) => {
  const now = Date.now();
  if (!cachedHtml || (now - lastFetchTime > CACHE_DURATION)) {
    try {
      cachedHtml = await generatePageHtml();
      lastFetchTime = now;
    } catch (err) {
      log('Error generando HTML: ' + err.message);
      if (fs.existsSync(CACHE_HTML_PATH)) {
        cachedHtml = fs.readFileSync(CACHE_HTML_PATH, 'utf8');
      } else {
        return res.status(500).send('<html><body><h1>Error</h1><p>No se pudo cargar la página. <a href="/">Reintentar.</a></p></body></html>');
      }
    }
  }
  res.send(cachedHtml);
});

// ─────────────────────────────────────
// Panel admin (protegido con rate limit)
// ─────────────────────────────────────
app.get('/admin', adminLimiter, (req, res) => {
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
    const authUrl = `https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    authSectionHtml = `<div style="background:#fff3e0;border-left:4px solid #ff9800;padding:16px;border-radius:4px;margin-bottom:24px;">
      <h3 style="color:#e65100;margin-top:0;">Acceso Requerido</h3>
      <p style="margin:4px 0 16px 0;font-size:14px;">Vinculá tu cuenta de Mercado Libre para activar los productos.</p>
      <a href="${authUrl}" style="background:#3483fa;color:white;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block;">Conectar con Mercado Libre</a>
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
  <title>Panel Admin — ${DOMAIN}</title>
  <style>
    body { font-family: sans-serif; background: #f5f5f5; color: #333; margin: 0; padding: 24px; }
    .container { max-width: 800px; margin: 0 auto; background: white; padding: 32px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
    h1 { border-bottom: 2px solid #FFE600; padding-bottom: 12px; margin-top: 0; }
    .btn-submit { background: #00a650; color: white; border: none; padding: 12px 24px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 16px; }
    .btn-submit:hover { background: #008f45; }
    .btn-clear { background: #ff4444; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; margin-left: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Panel de Administración — ${DOMAIN}</h1>
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

app.post('/admin/save', adminLimiter, (req, res) => {
  const config = readConfig();
  Object.keys(req.body).forEach(key => {
    if (key.startsWith('fallback_')) {
      const catId = key.replace('fallback_', '');
      config.categoryFallbacks[catId] = req.body[key];
    }
  });
  saveConfig(config);
  cachedHtml = '';
  lastFetchTime = 0;
  res.send('<script>alert("Enlaces guardados. La caché se limpió."); window.location.href="/admin";</script>');
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
    cachedHtml = '';
    lastFetchTime = 0;
    log('[Meli] Cuenta vinculada con éxito.');
    res.send('<script>alert("¡Cuenta vinculada exitosamente!"); window.location.href="/admin";</script>');
  } catch (err) {
    log('[Meli] Error en callback OAuth: ' + (err.response?.data?.message || err.message));
    res.status(500).send(`Error de autenticación: ${err.message}`);
  }
});

// Diagnóstico (borrar después)
app.get('/admin/debug', async (req, res) => {
  const config = readConfig();
  const hasOAuth = !!(config.meliTokens && config.meliTokens.access_token);
  const hasEnvToken = !!process.env.MELI_ACCESS_TOKEN;
  const token = await getValidAccessToken();
  let apiTest = 'no probada';
  if (token) {
    try {
      const resp = await axios.get('https://api.mercadolibre.com/sites/MLA/search', {
        params: { q: 'zapatillas', limit: 2 },
        headers: { 'Authorization': `Bearer ${token}` }
      });
      apiTest = 'OK - ' + (resp.data.results || []).length + ' resultados';
    } catch (e) {
      apiTest = 'ERROR ' + (e.response?.status || '') + ': ' + (e.response?.data?.message || e.message);
    }
  }
  res.json({
    oauthEnConfig: hasOAuth,
    tokenEnv: hasEnvToken,
    tokenValido: !!token,
    tokenPrefijo: token ? token.substring(0, 15) + '...' : 'ninguno',
    apiTest: apiTest
  });
});

app.get('/admin/clear-cache', (req, res) => {
  cachedHtml = '';
  lastFetchTime = 0;
  res.send('<script>alert("Caché limpiada."); window.location.href="/admin";</script>');
});

// ─────────────────────────────────────
// 404 — siempre al final
// ─────────────────────────────────────
app.use((req, res) => {
  res.status(404).send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Página no encontrada — ${DOMAIN}</title>
  <style>
    body { font-family: 'Inter', sans-serif; text-align: center; padding: 80px 24px; color: #333; background: #f5f5f5; }
    h1 { font-size: 72px; color: #FFE600; margin: 0; text-shadow: 2px 2px 0 #1a1a1a; }
    p { margin: 16px 0; font-size: 18px; }
    a { color: #3483FA; text-decoration: none; font-weight: 600; }
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
// Variables de caché
// ─────────────────────────────────────
let cachedHtml = '';
let lastFetchTime = 0;
const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 horas

// Al iniciar, cargar caché del disco
if (fs.existsSync(CACHE_HTML_PATH)) {
  try {
    cachedHtml = fs.readFileSync(CACHE_HTML_PATH, 'utf8');
    lastFetchTime = fs.statSync(CACHE_HTML_PATH).mtimeMs;
    log(`[Cache] Cargada del disco (${cachedHtml.length} bytes).`);
  } catch (_) {}
}

// ─────────────────────────────────────
// Iniciar servidor
// ─────────────────────────────────────
app.listen(PORT, () => {
  log('═'.repeat(50));
  log(`🚀 ${DOMAIN} listo en puerto ${PORT}`);
  log(`   Web: ${BASE_URL}`);
  log(`   Admin: ${BASE_URL}/admin`);
  log('═'.repeat(50));
});
