/**
 * Genera cache_*.html desde los datos del fixture (offline, sin API de Meli).
 * Usa las imágenes y links reales de products-fixture.json.
 * Genera un archivo por cada sitio definido en config.json.
 * Ejecutar: node scripts/generate-cache.js
 */
const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', 'index.html');
const FIXTURE_PATH = path.join(__dirname, '..', 'products-fixture.json');
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const FOOD_PATH = path.join(__dirname, '..', 'food.json');

const DEFAULT_SITE = 'elpodiomp';

// ── Helpers ─────────────────────────────────────
function formatPrice(n) {
  return Math.round(n).toLocaleString('es-AR');
}

function getDeterministicRating(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
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

// Helper para leer JSON sin problemas de BOM
function readJson(filePath) {
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return JSON.parse(raw);
}

/**
 * Obtiene la configuración de un sitio, con fallback al default.
 */
function getSiteConfig(config, siteId) {
  if (config.sites && config.sites[siteId]) {
    return config.sites[siteId];
  }
  if (config.sites && config.sites[DEFAULT_SITE]) {
    return config.sites[DEFAULT_SITE];
  }
  return null;
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

/**
 * Genera el HTML para un sitio específico.
 */
function generateSiteCache(siteId, template, fixture, config, foods) {
  const siteConfig = getSiteConfig(config, siteId);
  if (!siteConfig) {
    console.log(`⚠️  Sitio "${siteId}" no encontrado en config.json. Saltando.`);
    return null;
  }

  // Aplicar tokens del sitio
  let siteTemplate = renderTemplate(template, siteConfig);

  // Filtrar categorías que pertenecen a este sitio
  const siteCategories = config.categories.filter(cat =>
    cat.sites && cat.sites.includes(siteId)
  );

  console.log(`\n📄 Generando cache_${siteId}.html — ${siteCategories.length} categorías`);

  let categoriesHtml = '';
  let totalCards = 0;

  for (const cat of siteCategories) {
    const products = fixture[cat.id] || [];
    const catAffLink = config.categoryFallbacks && config.categoryFallbacks[cat.id]
      ? config.categoryFallbacks[cat.id]
      : `https://listado.mercadolibre.com.ar/${encodeURIComponent(cat.query || cat.name)}`;

    let cardsHtml = '';

    if (products.length > 0) {
      products.slice(0, 3).forEach(fp => {
        const affLink = fp.link || catAffLink;
        const oldPriceHtml = fp.oldPrice && fp.oldPrice > fp.price
          ? `<p class="old-price">$${formatPrice(fp.oldPrice)}</p>` : '';
        const ratingInfo = getDeterministicRating(cat.id + (fp.title || ''));

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
            <p class="description">${fp.description || `Calidad garantizada. Top 3 de los productos mejor valorados en ${cat.name}.`}</p>
            ${oldPriceHtml}
            <p class="price"><span class="price-sup">$</span>${formatPrice(fp.price)}</p>
            <p class="installments">Hasta 12 cuotas sin interés</p>
            <button class="btn" onclick="event.stopPropagation(); window.location.href='${affLink}'">Comprar ahora</button>
          </div>
        </div>`;
        totalCards++;
      });
    }

    if (!cardsHtml) {
      cardsHtml = `
        <div class="card" style="display:flex;align-items:center;justify-content:center;min-height:200px;cursor:pointer;" onclick="window.location.href='${catAffLink}'">
          <div style="text-align:center;padding:32px;">
            <div style="font-size:48px;margin-bottom:12px;">${cat.icon || '📦'}</div>
            <h3 style="margin-bottom:8px;">${cat.name}</h3>
            <p style="color:#666;margin-bottom:12px;">Ver los mejores precios en ${siteConfig.name}</p>
            <button class="btn">Ver productos</button>
          </div>
        </div>`;
    }

    categoriesHtml += `
    <section class="section">
      <div class="section-header">
        <h2><span class="icon">${cat.icon || '📦'}</span> ${cat.name}</h2>
        <a href="${catAffLink}" target="_blank" class="view-all">Ver todos &rarr;</a>
      </div>
      <div class="grid">
        ${cardsHtml}
      </div>
    </section>`;
  }

  // ── Sección de comida (solo para sitios que corresponda) ──
  const siteFoods = foods.filter(f => f.sites && f.sites.includes(siteId));
  if (siteFoods.length > 0) {
    let foodCards = '';
    siteFoods.forEach(f => {
      const affLink = f.link || 'https://listado.mercadolibre.com.ar/_OrderId_Alimentos_Bebidas_';
      foodCards += `
        <div class="card" onclick="window.location.href='${affLink}'">
          <img class="card-image" src="${f.imageUrl}" alt="${f.product || f.name}" loading="lazy">
          <div class="card-body">
            <span class="card-badge">${f.badge || 'Recomendado'}</span>
            <h3>${f.product || f.name}</h3>
            <p class="description">${f.description || ''}</p>
            <p class="price"><span class="price-sup">$</span>${formatPrice(f.price)}</p>
            <p class="installments">${f.installments}</p>
            <button class="btn" onclick="event.stopPropagation(); window.location.href='${affLink}'">Pedir ahora</button>
          </div>
        </div>`;
        totalCards++;
    });

    if (foodCards) {
      categoriesHtml += `
    <section class="section">
      <div class="section-header">
        <h2><span class="icon">🍔</span> Comida del Momento</h2>
        <a href="https://listado.mercadolibre.com.ar/_OrderId_Alimentos_Bebidas_" target="_blank" class="view-all">Ver todos &rarr;</a>
      </div>
      <div class="grid">
        ${foodCards}
      </div>
    </section>`;
    }
  }

  // ── Armar HTML final ────────────────────────────
  const html = siteTemplate.replace('<!-- CATEGORIES_AND_PRODUCTS -->', categoriesHtml);

  // ── Guardar ─────────────────────────────────────
  const cachePath = path.join(__dirname, '..', `cache_${siteId}.html`);
  fs.writeFileSync(cachePath, html, 'utf8');
  console.log(`   ✅ cache_${siteId}.html: ${siteCategories.length} categorías, ${totalCards} productos (${Buffer.byteLength(html, 'utf8')} bytes)`);

  return { categories: siteCategories.length, products: totalCards };
}

// ── MAIN ──────────────────────────────────────────
console.log('📦 Generando cachés multi-sitio desde fixture...\n');

// Cargar template
let template;
try {
  template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
} catch (e) {
  console.error('❌ No se encontró index.html');
  process.exit(1);
}

// Cargar datos
let fixture, config, foods;
try {
  fixture = readJson(FIXTURE_PATH);
  config = readJson(CONFIG_PATH);
  foods = readJson(FOOD_PATH);
} catch (e) {
  console.error('❌ Error al cargar datos:', e.message);
  process.exit(1);
}

// Obtener sitios configurados
const siteIds = config.sites ? Object.keys(config.sites) : [DEFAULT_SITE];
console.log(`🌐 ${siteIds.length} sitios configurados: ${siteIds.join(', ')}\n`);

let grandTotalCats = 0;
let grandTotalCards = 0;

for (const siteId of siteIds) {
  const result = generateSiteCache(siteId, template, fixture, config, foods);
  if (result) {
    grandTotalCats += result.categories;
    grandTotalCards += result.products;
  }
}

console.log('\n═══════════════════════════════════════');
console.log(`✅ Cachés generadas: ${siteIds.length} sitios, ${grandTotalCats} categorías, ${grandTotalCards} productos.`);
console.log('═══════════════════════════════════════\n');
