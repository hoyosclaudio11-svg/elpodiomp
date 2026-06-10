/**
 * Genera cache_*.html intentando primero la API de Mercado Libre.
 * Si la API tiene token válido, llena todas las categorías con productos reales.
 * Si falla, usa products-fixture.json como respaldo.
 * Ejecutar: node scripts/generate-cache.js
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ override: true });

const TEMPLATE_PATH = path.join(__dirname, '..', 'index.html');
const FIXTURE_PATH = path.join(__dirname, '..', 'products-fixture.json');
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const FOOD_PATH = path.join(__dirname, '..', 'food.json');
const BAKERY_PATH = path.join(__dirname, '..', 'bakery-offers.json');
const EXPRESS_PATH = path.join(__dirname, '..', 'express-offers.json');
const EXPRESS_EVENTS_PATH = path.join(__dirname, '..', 'express-events.json');

const DEFAULT_SITE = 'elpodiomp';

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

// ── Helpers ─────────────────────────────────────
function formatPrice(n) {
  return Math.round(n).toLocaleString('es-AR');
}

function getDeterministicRating(seed) {
  let str = String(seed);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  const rating = 4.0 + (Math.abs(hash) % 15) / 10;
  const full = Math.floor(rating);
  const half = rating - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  const starsHtml = '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
  const reviews = 120 + (Math.abs(hash) % 380);
  return { rating: Math.round(rating * 10) / 10, reviews, starsHtml };
}

function readJson(filePath) {
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return JSON.parse(raw);
}

function getSiteConfig(config, siteId) {
  if (config.sites && config.sites[siteId]) return config.sites[siteId];
  if (config.sites && config.sites[DEFAULT_SITE]) return config.sites[DEFAULT_SITE];
  return null;
}

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

function escapeHtml(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeUrl(url) {
  if (!url || typeof url !== 'string') return '#';
  const trimmed = url.trim();
  if (/^(https?:|\/|mailto:|data:image\/)/i.test(trimmed)) return trimmed.replace(/"/g, '%22').replace(/'/g, '%27');
  return '#';
}

function toNonAffiliateUrl(url) {
  if (!url || typeof url !== 'string') return url;
  return url
    .replace(/articulo\.mercadolibre\.com\.ar/g, 'www.mercadolibre.com.ar')
    .replace(/https:\/\/mercadolibre\.com\.ar/g, 'https://www.mercadolibre.com.ar');
}

// ── API de Mercado Libre ─────────────────────────
async function fetchFromApi(query, proxyConfig) {
  const token = process.env.MELI_ACCESS_TOKEN;
  if (!token) return null;

  const axiosOpts = {
    params: { q: query, limit: 20 },
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json'
    },
    timeout: 10000
  };

  // Proxy para axios si está configurado
  if (proxyConfig) {
    const p = new URL(proxyConfig.server.replace(/^socks5/, 'http')); // axios no soporta socks5 nativamente
    axiosOpts.proxy = {
      protocol: p.protocol.replace(':', ''),
      host: p.hostname,
      port: parseInt(p.port) || 8080
    };
    if (proxyConfig.username && proxyConfig.password) {
      axiosOpts.proxy.auth = {
        username: proxyConfig.username,
        password: proxyConfig.password
      };
    }
  }

  try {
    const res = await axios.get('https://api.mercadolibre.com/sites/MLA/search', axiosOpts);

    const products = (res.data.results || []).filter(p => p.id && p.title && p.price);
    if (products.length === 0) return null;

    return products.slice(0, 3).map(item => {
      const isInterestFree = item.installments && item.installments.rate === 0;
      const originalPrice = item.original_price;
      const discount = originalPrice && originalPrice > item.price
        ? Math.round(((originalPrice - item.price) / originalPrice) * 100) : 0;

      let imageUrl = (item.thumbnail || '').replace('-I.jpg', '-O.jpg').replace('http://', 'https://');
      let badge = discount > 0 ? `${discount}% OFF`
        : (item.shipping?.free_shipping) ? 'Envío Gratis' : 'Destacado';

      const ratingInfo = getDeterministicRating(item.id);
      const installmentsText = item.installments && item.installments.quantity
        ? `Hasta ${item.installments.quantity} cuotas sin interés`
        : (item.shipping?.free_shipping ? 'Envío gratis a todo el país' : 'Ver en El Podio MP');

      return {
        title: item.title,
        price: item.price,
        oldPrice: originalPrice,
        imageUrl,
        badge,
        rating: ratingInfo.rating,
        reviews: ratingInfo.reviews,
        starsHtml: ratingInfo.starsHtml,
        installmentsText,
        link: item.permalink
      };
    });
  } catch (err) {
    return null;
  }
}

// ── Generar HTML para un sitio ───────────────────
function generateSiteCache(siteId, template, fixture, config, foods, bakeryOffers, apiProducts, expressOffers, expressEvent) {
  const siteConfig = getSiteConfig(config, siteId);
  if (!siteConfig) {
    console.log(`⚠️  Sitio "${siteId}" no encontrado. Saltando.`);
    return null;
  }

  let siteTemplate = renderTemplate(template, siteConfig);

  const siteCategories = config.categories.filter(cat =>
    cat.sites && cat.sites.includes(siteId)
  );

  console.log(`\n📄 Generando cache_${siteId}.html — ${siteCategories.length} categorías`);

  let categoriesHtml = '';
  let totalCards = 0;
  // ============================================================
  // SECCION EXPRESS BAKERY (al inicio, visible 16:00-18:00)
  // ============================================================
  if (siteId === 'elpodiofood' && bakeryOffers && bakeryOffers.length > 0) {
    let bakeryCards = '';
    bakeryOffers.forEach(b => {
      var affLink = safeUrl(toNonAffiliateUrl(b.link));
      var oldPriceHtml = (b.oldPrice && b.oldPrice > b.price) ? '<p class="old-price">$' + formatPrice(b.oldPrice) + '</p>' : '';
      var estimadoHtml = b.precio_estimado ? '<span style="font-size:11px;color:#f97316;margin-left:6px;" title="Precio estimado - puede variar segun zona">&#9888;&#65039; aprox.</span>' : '';
      bakeryCards += '<div class="card" onclick="window.location.href=\'' + escapeHtml(affLink) + '\'">' +
        '<img class="card-image" src="' + safeUrl(b.imageUrl) + '" alt="' + escapeHtml(b.product) + '" loading="lazy">' +
        '<div class="card-body">' +
        '<span class="card-badge">' + escapeHtml(b.badge || 'Destacado') + '</span>' +
        '<h3>' + escapeHtml(b.product) + '</h3>' +
        '<p class="description">' + escapeHtml(b.description || '') + '</p>' +
        '<p style="font-size:13px;color:#666;margin:4px 0;">&#128205; ' + escapeHtml(b.bakery) + ' - ' + escapeHtml(b.location) + '</p>' +
        oldPriceHtml +
        '<p class="price"><span class="price-sup">$</span>' + formatPrice(b.price) + estimadoHtml + '</p>' +
        '<p class="installments">' + escapeHtml(b.installments) + '</p>' +
        '<button class="btn" onclick="event.stopPropagation(); window.location.href=\'' + escapeHtml(affLink) + '\'">Ver oferta</button>' +
        '</div></div>';
        totalCards++;
    });
    categoriesHtml = '<section id="bakery-express" class="section" style="background:linear-gradient(135deg, #fff8f0 0%, #fff3e0 100%);border:2px solid #f97316;border-radius:16px;padding:24px;margin-bottom:32px;animation:pulse-border 2s ease-in-out infinite;">' +
      '<style>@keyframes pulse-border{0%,100%{border-color:#f97316}50%{border-color:#ffb380}}#bakery-express,#cena-express{transition:opacity .5s,max-height .5s;overflow:hidden}#bakery-express.hidden,#cena-express.hidden{opacity:0;max-height:0;padding:0;margin:0;border:0}#cena-express .section-header h2{color:#fff}#cena-express .view-all{color:#e67e22}#cena-express p{color:#ccc}#cena-express .installments{color:#f97316!important}#cena-express .description{color:#aaa!important}</style>' +
      '<div class="section-header"><h2><span class="icon">&#129370;</span> Seccion Express - Para la Merienda! &#9889;</h2>' +
      '<span style="background:#f97316;color:#fff;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:bold;">&#9200; Hasta las 18:00</span></div>' +
      '<p style="color:#888;font-size:14px;margin:-8px 0 16px 0;">&#128204; Actualizado hoy a las 16:00 - Las 3 mejores ofertas con envio a todo CABA</p>' +
      '<div class="grid">' + bakeryCards + '</div></section>' +
      categoriesHtml;
  }

  // ============================================================
  // SECCION EXPRESS CENA (al inicio, visible 19:30 en adelante)
  // ============================================================
  if (siteId === 'elpodiofood' && foods && foods.length > 0) {
    let cenaCards = '';
    foods.forEach(f => {
      var affLink = safeUrl(toNonAffiliateUrl(f.link));
      var oldPriceHtml = (f.oldPrice && f.oldPrice > f.price) ? '<p class="old-price">$' + formatPrice(f.oldPrice) + '</p>' : '';
      cenaCards += '<div class="card" onclick="window.location.href=\'' + escapeHtml(affLink) + '\'">' +
        '<img class="card-image" src="' + safeUrl(f.imageUrl) + '" alt="' + escapeHtml(f.product) + '" loading="lazy">' +
        '<div class="card-body">' +
        '<span class="card-badge">' + escapeHtml(f.badge || 'Recomendado') + '</span>' +
        '<h3>' + escapeHtml(f.product) + '</h3>' +
        '<p class="description">' + escapeHtml(f.description || '') + '</p>' +
        '<p style="font-size:13px;color:#666;margin:4px 0;">&#127860; ' + escapeHtml(f.restaurant || 'Delivery') + '</p>' +
        oldPriceHtml +
        '<p class="price"><span class="price-sup">$</span>' + formatPrice(f.price) + '</p>' +
        '<p class="installments">' + escapeHtml(f.installments) + '</p>' +
        '<button class="btn" onclick="event.stopPropagation(); window.location.href=\'' + escapeHtml(affLink) + '\'">Pedir ahora</button>' +
        '</div></div>';
        totalCards++;
    });
    categoriesHtml += '<section id="cena-express" class="section hidden" style="background:linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);border:2px solid #e67e22;border-radius:16px;padding:24px;margin-bottom:32px;">' +
      '<div class="section-header"><h2><span class="icon">&#127828;</span> Cena Express - Pedia tu Cena! &#127769;</h2>' +
      '<span style="background:#e67e22;color:#fff;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:bold;">&#127769; Desde las 19:30</span></div>' +
      '<p style="color:#888;font-size:14px;margin:-8px 0 16px 0;">&#128204; Las mejores opciones para cenar con delivery en CABA</p>' +
      '<div class="grid">' + cenaCards + '</div></section>';
  }

  // ============================================================
  // TIMER JS - Toggle entre bakery (dia) y cena (noche)
  // ============================================================
  if (siteId === 'elpodiofood') {
    categoriesHtml += '<script>(function(){var b=document.getElementById("bakery-express");var c=document.getElementById("cena-express");function t(){if(!b||!c)return;var n=new Date();var h=n.getUTCHours()-3;if(h<0)h+=24;var m=n.getUTCMinutes();var mostrarBakery=(h>=16&&h<18);var mostrarCena=(h>19||(h===19&&m>=30));if(mostrarCena){b.classList.add("hidden");c.classList.remove("hidden")}else if(mostrarBakery){b.classList.remove("hidden");c.classList.add("hidden")}else{b.classList.add("hidden");c.classList.add("hidden")}}t();setInterval(t,60000)})();</script>';
  }



  for (const cat of siteCategories) {
    const catAffLink = config.categoryFallbacks && config.categoryFallbacks[cat.id]
      ? config.categoryFallbacks[cat.id]
      : `https://listado.mercadolibre.com.ar/${encodeURIComponent(cat.query)}`;

    let cardsHtml = '';

    // 1. Intentar datos de la API (recién obtenidos)
    if (apiProducts[cat.id] && apiProducts[cat.id].length > 0) {
      apiProducts[cat.id].forEach(p => {
        const affLink = safeUrl(toNonAffiliateUrl(p.link || catAffLink));
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
        totalCards++;
      });
      // Guardar en fixture para uso futuro
      if (!fixture[cat.id]) fixture[cat.id] = [];
      fixture[cat.id] = apiProducts[cat.id].map(p => ({
        title: p.title, price: p.price, oldPrice: p.oldPrice,
        imageUrl: p.imageUrl, badge: p.badge,
        description: `Calidad garantizada. Top 3 en ${cat.name}.`,
        link: p.link
      }));
    }

    // 2. Si no hay API, usar fixture del disco
    if (!cardsHtml) {
      const products = fixture[cat.id] || [];
      if (products.length > 0) {
        products.slice(0, 3).forEach(fp => {
          const affLink = safeUrl(toNonAffiliateUrl(fp.link || catAffLink));
          const oldPriceHtml = fp.oldPrice && fp.oldPrice > fp.price
            ? `<p class="old-price">$${formatPrice(fp.oldPrice)}</p>` : '';
          const ratingInfo = getDeterministicRating(cat.id + (fp.title || ''));
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
            <p class="description">${escapeHtml(fp.description || '')}</p>
            ${oldPriceHtml}
            <p class="price"><span class="price-sup">$</span>${formatPrice(fp.price)}</p>
            <p class="installments">Hasta 12 cuotas sin interés</p>
            <button class="btn" onclick="event.stopPropagation(); window.location.href='${escapeHtml(affLink)}'">Comprar ahora</button>
          </div>
        </div>`;
          totalCards++;
        });
      }
    }

    // 3. Último recurso: card genérica con link a ML
    if (!cardsHtml) {
      cardsHtml = `
        <div class="card" style="display:flex;align-items:center;justify-content:center;min-height:200px;cursor:pointer;" onclick="window.location.href='${escapeHtml(toNonAffiliateUrl(catAffLink))}'">
          <div style="text-align:center;padding:32px;">
            <div style="font-size:48px;margin-bottom:12px;">${escapeHtml(cat.icon || '📦')}</div>
            <h3 style="margin-bottom:8px;">${escapeHtml(cat.name)}</h3>
            <p style="color:#666;margin-bottom:12px;">Ver los mejores precios en ${escapeHtml(siteConfig.name)}</p>
            <button class="btn">Ver productos</button>
          </div>
        </div>`;
    }

    categoriesHtml += `
    <section class="section">
      <div class="section-header">
        <h2><span class="icon">${escapeHtml(cat.icon || '📦')}</span> ${escapeHtml(cat.name)}</h2>
        <a href="${catAffLink}" target="_blank" class="view-all">Ver todos &rarr;</a>
      </div>
      <div class="grid">${cardsHtml}</div>
    </section>`;
  }



  const html = siteTemplate.replace('<!-- CATEGORIES_AND_PRODUCTS -->', categoriesHtml);
  const cachePath = path.join(__dirname, '..', `cache_${siteId}.html`);
  fs.writeFileSync(cachePath, html, 'utf8');
  console.log(`   ✅ ${siteCategories.length} categorías, ${totalCards} productos (${Buffer.byteLength(html, 'utf8')} bytes)`);

  return { categories: siteCategories.length, products: totalCards };
}

// ── MAIN ──────────────────────────────────────────
async function main() {
  console.log('🔍 Buscando productos en Mercado Libre API...\n');

  let template, fixture, config, foods;
  try { template = fs.readFileSync(TEMPLATE_PATH, 'utf8'); }
  catch (e) { console.error('❌ No se encontró index.html'); process.exit(1); }
  try {
    fixture = readJson(FIXTURE_PATH);
    config = readJson(CONFIG_PATH);
    foods = readJson(FOOD_PATH);
    var bakeryOffers = [];
    try { if (fs.existsSync(BAKERY_PATH)) bakeryOffers = readJson(BAKERY_PATH); } catch (_) {}
  } catch (e) { console.error('❌ Error al cargar datos:', e.message); process.exit(1); }

  // ── Configurar proxy desde .env ──
  const proxyConfig = parseProxyUrl(process.env.PROXY_URL);
  if (proxyConfig) {
    console.log(`🌐 Usando proxy para API: ${proxyConfig.server}\n`);
  }

  // ── Intentar la API para TODAS las categorías ──
  const apiProducts = {};
  const allCategories = config.categories;

  for (let i = 0; i < allCategories.length; i++) {
    const cat = allCategories[i];
    console.log(`   ${i + 1}/${allCategories.length} ${cat.icon} ${cat.name}...`);
    const products = await fetchFromApi(cat.query, proxyConfig);
    if (products) {
      apiProducts[cat.id] = products;
      console.log(`      ✅ ${products.length} productos`);
    } else {
      console.log(`      ⚠️  sin resultados (se usará fixture o card genérica)`);
    }
    if (i < allCategories.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  // Guardar fixture actualizado
  Object.keys(apiProducts).forEach(catId => {
    if (!fixture[catId]) fixture[catId] = [];
    fixture[catId] = apiProducts[catId].map(p => ({
      title: p.title, price: p.price, oldPrice: p.oldPrice, imageUrl: p.imageUrl,
      badge: p.badge, description: `Calidad garantizada. Top 3 en productos similares.`, link: p.link
    }));
  });
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2), 'utf8');
  console.log(`\n💾 Fixture actualizado con ${Object.keys(fixture).length} categorías.`);

  // ── Generar cachés por sitio ──
  console.log('\n📦 Generando cachés...');
  const siteIds = config.sites ? Object.keys(config.sites) : [DEFAULT_SITE];
  let grandTotalCats = 0, grandTotalCards = 0;

  for (const siteId of siteIds) {
    const result = generateSiteCache(siteId, template, fixture, config, foods, bakeryOffers, apiProducts);
    if (result) { grandTotalCats += result.categories; grandTotalCards += result.products; }
  }

  console.log('\n═══════════════════════════════════════');
  console.log(`✅ ${siteIds.length} sitios, ${grandTotalCats} categorías, ${grandTotalCards} productos.`);
  console.log('═══════════════════════════════════════');
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
