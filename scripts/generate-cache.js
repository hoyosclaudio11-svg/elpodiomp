/**
 * Genera cache.html desde los datos del fixture (offline, sin API de Meli).
 * Usa las imágenes y links reales de products-fixture.json.
 * Ejecutar: node scripts/generate-cache.js
 */
const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', 'index.html');
const FIXTURE_PATH = path.join(__dirname, '..', 'products-fixture.json');
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const FOOD_PATH = path.join(__dirname, '..', 'food.json');
const CACHE_PATH = path.join(__dirname, '..', 'cache.html');

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

console.log('📦 Generando cache.html desde fixture...\n');

// ── Cargar datos ────────────────────────────────
let template;
try {
  template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
} catch (e) {
  console.error('❌ No se encontró index.html');
  process.exit(1);
}

// Helper para leer JSON sin problemas de BOM
function readJson(path) {
  let raw = fs.readFileSync(path, 'utf8');
  // Quitar BOM si existe
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return JSON.parse(raw);
}

let fixture, config, foods;
try {
  fixture = readJson(FIXTURE_PATH);
  config = readJson(CONFIG_PATH);
  foods = readJson(FOOD_PATH);
} catch (e) {
  console.error('❌ Error al cargar datos:', e.message);
  process.exit(1);
}

// ── Generar HTML de categorías ──────────────────
let categoriesHtml = '';
let totalCards = 0;

for (const cat of config.categories) {
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
    // Fallback genérico si no hay fixture
    cardsHtml = `
        <div class="card" style="display:flex;align-items:center;justify-content:center;min-height:200px;cursor:pointer;" onclick="window.location.href='${catAffLink}'">
          <div style="text-align:center;padding:32px;">
            <div style="font-size:48px;margin-bottom:12px;">${cat.icon || '📦'}</div>
            <h3 style="margin-bottom:8px;">${cat.name}</h3>
            <p style="color:#666;margin-bottom:12px;">Ver los mejores precios en El Podio MP</p>
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

// ── Sección de comida ───────────────────────────
let foodCards = '';
if (foods && foods.length > 0) {
  foods.forEach(f => {
    const affLink = f.link || 'https://listado.mercadolibre.com.ar/_OrderId_Alimentos_Bebidas_';
    foodCards += `
        <div class="card" onclick="window.location.href='${affLink}'">
          <img class="card-image" src="${f.imageUrl}" alt="${f.product || f.name}" loading="lazy">
          <div class="card-body">
            <span class="card-badge">${f.badge || 'Recomendado'}</span>
            <h3>${f.product || f.name}</h3>
            <p class="description">${f.description || ''}</p>
            <p class="price"><span class="price-sup">$</span>${formatPrice(f.price)}</p>
            <p class="installments">Hasta 12 cuotas sin interés</p>
            <button class="btn" onclick="event.stopPropagation(); window.location.href='${affLink}'">Comprar ahora</button>
          </div>
        </div>`;
        totalCards++;
  });
}

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

// ── Armar HTML final ────────────────────────────
const html = template.replace('<!-- CATEGORIES_AND_PRODUCTS -->', categoriesHtml);

// ── Guardar ─────────────────────────────────────
fs.writeFileSync(CACHE_PATH, html, 'utf8');
console.log(`✅ cache.html generado: ${config.categories.length} categorías, ${totalCards} productos.`);
console.log(`💾 Guardado en ${CACHE_PATH}`);
console.log('\n📋 Ahora hacé:');
console.log('   git add cache.html server.js scripts/generate-cache.js');
console.log('   git commit -m "fix: servir cache.html desde disco, generar offline desde fixture"');
console.log('   git push');
console.log('\nY Render desplegará con todos los productos e imágenes en 1 minuto.');
