/**
 * build-tech-from-offers.js
 * ─────────────────────────────────────────────────────────────────────
 * Genera el HTML de El Podio Tech desde la fuente curada de ofertas:
 *
 *   E:\elpodiomp\data\tech_offers.json   (schema v1, red Admitad)
 *
 * Mantiene el MISMO look actual del sitio (header sticky, hero, site-nav,
 * grid de 3 cards, card--gold/silver/bronze, podium-badge #1 #2 #3)
 * tomando como base visual cache_elpodiotech.html, pero regenerando
 * SIEMPRE el contenido de <main> y el footer desde los datos.
 *
 * Reglas de datos (contrato, ver PLAN_ELPODIO_ADMITAD_TECH sección 7):
 *   - affiliate_url OBLIGATORIA para active:true.
 *   - PROHIBIDO mercadolibre.com.ar en affiliate_url en esta fase.
 *   - Solo productos active:true se navegan; active:false muestra
 *     "Próximamente" (sin link, sin evento de afiliado).
 *   - Si NINGÚN producto está activo (faltan IDs Admitad del dueño),
 *     se renderiza la página completa en modo borrador con un banner
 *     discreto. Cuando el dueño active productos, el banner desaparece.
 *
 * Uso:
 *   node scripts/build-tech-from-offers.js        → escribe cache_elpodiotech.html
 *   const { generateTechHtml } = require('./build-tech-from-offers.js')
 *   build-cloudflare.js usa generateTechHtml() para dist/tech/index.html
 *   (inmune a que generate-cache.js pise cache_elpodiotech.html con ML).
 *
 * NOTA subid Admitad: cuando existan deep links reales del panel, pasar
 * el origen como subid. Parámetro estándar de Admitad: "subid"
 * (verificar en panel; algunos programas usan sub_id / publish_sub_id).
 * ─────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const OFFERS_PATH = path.join(ROOT, 'data', 'tech_offers.json');
const TEMPLATE_PATH = path.join(ROOT, 'cache_elpodiotech.html');
const OUTPUT_PATH = path.join(ROOT, 'cache_elpodiotech.html');

const GA4_PLACEHOLDER = '{{GA4_MEASUREMENT_ID}}';
const ADMITAD_PENDING = 'ADMITAD_TODO'; // marcador de link pendiente

// ── Carga de fuentes ────────────────────────────────────────────────
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function loadOffers() {
  if (!fs.existsSync(OFFERS_PATH)) return null;
  return JSON.parse(fs.readFileSync(OFFERS_PATH, 'utf8'));
}

// ── Helpers de formato ──────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatARS(n) {
  if (n == null) return '';
  return Number(n).toLocaleString('es-AR');
}

function starsFor(rating) {
  if (rating == null) return null;
  const full = Math.floor(rating);
  const half = rating - full >= 0.25 ? 1 : 0;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(Math.max(0, 5 - full - half));
}

const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
const CARD_CLASS = { 1: 'card--gold', 2: 'card--silver', 3: 'card--bronze' };
const PODIUM_LABEL = { 1: '#1 Mejor valorado', 2: '#2', 3: '#3' };

function isPendingUrl(url) {
  return !url || url.indexOf(ADMITAD_PENDING) !== -1;
}

// ── Render de una card ──────────────────────────────────────────────
function renderCard(product, category, siteName) {
  const rank = product.rank || 1;
  const active = !!product.active && !isPendingUrl(product.affiliate_url);
  const dataAttrs = [
    `data-url="${active ? escapeHtml(product.affiliate_url) : ''}"`,
    `data-network="admitad"`,
    `data-merchant="${escapeHtml(product.merchant || '')}"`,
    `data-sku="${escapeHtml(product.sku || '')}"`,
    `data-name="${escapeHtml(product.title || '')}"`,
    `data-cat="${escapeHtml(category.id || '')}"`,
  ].join(' ');

  const clickCard = active
    ? `onclick="goAffiliate(this)"`
    : `onclick="goAffiliate(this); event.preventDefault(); return false;"`;

  const btnLabel = active ? 'Ver oferta' : 'Próximamente';
  const btnClick = active
    ? `onclick="event.stopPropagation(); goAffiliate(this.closest('.card'))"`
    : `onclick="event.stopPropagation(); goAffiliate(this.closest('.card')); return false;"`;

  let ratingHtml = '';
  const stars = starsFor(product.rating);
  if (stars) {
    ratingHtml = `<div class="rating">
              <span class="stars">${stars}</span>
              ${product.reviews ? `<span class="reviews">(${product.reviews})</span>` : ''}
            </div>`;
  }

  let oldPriceHtml = '';
  if (product.old_price) {
    oldPriceHtml = `<p class="old-price">$ ${formatARS(product.old_price)}</p>`;
  }

  // Precio solo si está verificado (null = se ve el precio en la tienda destino)
  let priceHtml = '';
  if (product.price) {
    priceHtml = `<p class="price"><span class="price-sup">$</span>${formatARS(product.price)}</p>`;
  }

  let installmentsHtml = '';
  if (product.cuotas) {
    installmentsHtml = `<p class="installments">Hasta ${product.cuotas} cuotas sin interés</p>`;
  }

  return `        <div class="card ${CARD_CLASS[rank] || 'card--bronze'}" ${dataAttrs} ${clickCard}>
          <img class="card-image" src="${escapeHtml(product.image)}" alt="${escapeHtml(product.title || category.name)}" loading="lazy">
          <div class="card-body">
            <span class="card-badge">${escapeHtml(product.badge || 'Oferta destacada')}<span class="podium-badge">${MEDAL[rank] || ''} ${PODIUM_LABEL[rank] || '#' + rank}</span></span>
            <h3>${escapeHtml(product.title)}</h3>
            ${ratingHtml}
            <p class="description">${escapeHtml(product.description)}</p>
            ${oldPriceHtml}
            ${priceHtml}
            ${installmentsHtml}
            <button class="btn" ${btnClick}>${btnLabel}</button>
          </div>
        </div>`;
}

// ── Render de una sección (categoría) ───────────────────────────────
function renderSection(category) {
  const products = (category.products || [])
    .slice()
    .sort((a, b) => (a.rank || 99) - (b.rank || 99))
    .slice(0, 3);

  const viewAll = category.view_all_url
    ? `href="${escapeHtml(category.view_all_url)}" target="_blank"`
    : `href="#cat-${escapeHtml(category.id)}"`;

  const cards = products.map(p => renderCard(p, category)).join('\n');

  return `    <section class="section" id="cat-${escapeHtml(category.id)}">
      <div class="section-header">
        <h2><span class="icon">${category.icon || '🛒'}</span> ${escapeHtml(category.name)}</h2>
        <a ${viewAll} class="view-all">Ver todos &rarr;</a>
      </div>
      <div class="grid">
${cards}
      </div>
    </section>`;
}

// ── Footer legal multi-afiliado (plan sección 8.4) ──────────────────
function renderFooter() {
  return `<footer class="footer">
    <div class="footer-inner">
      <div>
        <h4>💻 tech.elpodiomp.com.ar</h4>
        <p>Sitio de comparación y enlaces de afiliados. Podemos recibir una comisión si comprás a través de nuestros enlaces, sin costo extra para vos. Los precios pueden variar. Las compras se realizan en tiendas de terceros.</p>
      </div>
      <div>
        <h4>Ayuda</h4>
        <a href="#">Preguntas frecuentes</a>
        <a href="#">Cómo comprar</a>
        <a href="#">Envíos</a>
        <a href="#">Devoluciones</a>
      </div>
      <div>
        <h4>Legal</h4>
        <a href="/privacidad">Política de Privacidad</a>
        <a href="/terminos">Términos y Condiciones</a>
      </div>
      <div>
        <h4>Contacto</h4>
        <p>grupomontesdelnorte@gmail.com</p>
        <p>Lun a Vie 9:00 - 18:00</p>
      </div>
    </div>
    <div class="footer-sites">
      <span>🔗 También visitá nuestros otros sitios:</span>
      <a href="/">🏆 El Podio MP</a>
      <a href="/tech/">💻 El Podio Tech</a>
      <a href="/food/">🍔 El Podio Food</a>
      <a href="/hogar/">🏠 El Podio Hogar</a>
    </div>
    <div class="footer-bottom">
      <div class="visit-counter" id="visitCounter" style="margin-bottom:12px;font-size:14px;color:#888;">
        👀 <span id="visitCount">...</span> visitas
      </div>
      &copy; 2026 tech.elpodiomp.com.ar &mdash; Todos los derechos reservados. Los precios pueden variar; las compras se realizan en tiendas de terceros.
    </div>
  </footer>`;
}

// ── Scripts (GA4 real + outbound + search neutral) ──────────────────
function renderExtraScripts(ga4Id, draftMode) {
  return `<script>
  // ── Búsqueda: navega entre categorías de esta página (sin ML) ──
  (function() {
    var input = document.getElementById('searchInput');
    var btn = document.getElementById('searchBtn');
    if (!input || !btn) return;
    function buscar() {
      var q = input.value.trim().toLowerCase();
      if (!q) return;
      var found = null;
      var sections = document.querySelectorAll('main .section');
      sections.forEach(function(s) {
        var h2 = s.querySelector('h2');
        if (!found && h2 && h2.textContent.toLowerCase().indexOf(q) !== -1) found = s;
      });
      if (found) { found.scrollIntoView({ behavior: 'smooth' }); }
      else { showToast('No se encontró esa categoría'); }
    }
    btn.addEventListener('click', buscar);
    input.addEventListener('keydown', function(e) { if (e.key === 'Enter') buscar(); });
  })();

  // ── Clic de afiliado (outbound_affiliate_click en GA4) ──
  function goAffiliate(el) {
    var url = el.getAttribute('data-url');
    if (!url || url.indexOf('${ADMITAD_PENDING}') !== -1) {
      showToast('Disponible muy pronto ⏳');
      return;
    }
    // Atribución por canal (plan sección 7.2): si el visitante llegó con
    // utm_source (river, facebook, etc.), pasarlo como subid de Admitad.
    try {
      var src = new URLSearchParams(window.location.search).get('utm_source');
      if (src) {
        url = url.split('#')[0] + (url.indexOf('?') !== -1 ? '&' : '?') + 'subid=' + encodeURIComponent(src);
      }
    } catch (_) {}
    if (typeof gtag === 'function') {
      gtag('event', 'outbound_affiliate_click', {
        network: el.getAttribute('data-network') || 'admitad',
        merchant: el.getAttribute('data-merchant') || '',
        item_id: el.getAttribute('data-sku') || '',
        item_name: el.getAttribute('data-name') || '',
        item_category: el.getAttribute('data-cat') || ''
      });
    }
    setTimeout(function () { window.location.href = url; }, 150);
  }
</script>`;
}

// ── Generación principal ────────────────────────────────────────────
function generateTechHtml(opts = {}) {
  const config = opts.config || loadConfig();
  const offers = opts.offers || loadOffers();

  if (!offers) {
    console.warn('⚠️  data/tech_offers.json no existe. No se generó HTML Tech.');
    return null;
  }
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error('❌ Template base cache_elpodiotech.html no encontrado.');
    return null;
  }

  const ga4Id = (config.ga4MeasurementId || '').trim() || GA4_PLACEHOLDER;
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  // ── Partes del template que se conservan (look actual) ──
  const mainStartMarker = '<main class="container">';
  const mainEndMarker = '</main>';
  const mainStart = template.indexOf(mainStartMarker);
  const mainEnd = template.indexOf(mainEndMarker);
  const footerStart = template.indexOf('<footer class="footer">');
  const footerEnd = template.indexOf('</footer>') + '</footer>'.length;
  const htmlStartMarker = '</head>';

  if (mainStart < 0 || mainEnd < 0 || footerStart < 0 || footerEnd < 0) {
    console.error('❌ Template base con estructura inesperada. Abortando.');
    return null;
  }

  // ── Draft mode: ningún producto activo (IDs Admitad pendientes) ──
  const anyActive = (offers.categories || []).some(c =>
    (c.products || []).some(p => p.active && !isPendingUrl(p.affiliate_url))
  );

  // ── Head: GA4 real + SEO coherente con /tech/ + verificación Admitad ──
  const headEnd = template.indexOf(htmlStartMarker) + htmlStartMarker.length;
  let head = template.slice(0, headEnd)
    .split(GA4_PLACEHOLDER).join(ga4Id)
    .split('https://tech.elpodiomp.com.ar/').join('https://elpodiomp.com.ar/tech/')
    .split('tech.elpodiomp.com.ar/og-image.png').join('elpodiomp.com.ar/public/og-image.png')
    .replace('</head>', '  <!-- Verificación de propiedad Admitad (red de afiliados) -->\n  <meta name="verify-admitad" content="fc4cdbc4c8" />\n</head>');

  // ── Header + hero + site-nav (sin cambios de look) ──
  const bodyHeader = template.slice(headEnd, mainStart);

  // ── Banner borrador (solo mientras no haya ofertas activas) ──
  let draftBanner = '';
  if (!anyActive) {
    draftBanner = `  <div style="max-width:1200px;margin:20px auto 0;padding:0 24px;">
    <div style="background:#0f172a;border:1px solid #38bdf8;color:#e2e8f0;border-radius:10px;padding:14px 18px;font-size:14px;text-align:center;">
      ⏳ Estamos preparando los enlaces de compra directa de las tiendas partner.
      Las ofertas ya están seleccionadas; los links se activan muy pronto.
    </div>
  </div>
`;
  }

  // ── Secciones desde datos ──
  const sections = (offers.categories || [])
    .map(renderSection)
    .join('\n\n');

  // ── Ensamblado ──
  const mainHtml = `${mainStartMarker}\n${draftBanner}${sections}\n  ${mainEndMarker}`;
  const afterMain = template.slice(footerEnd);
  const html = head + bodyHeader + mainHtml + '\n\n  ' + renderFooter() + '\n' + afterMain;

  // ── Insertar scripts extra (búsqueda neutral + goAffiliate) antes de </body> ──
  const finalHtml = html.replace('</body>', renderExtraScripts(ga4Id, !anyActive) + '\n</body>');

  return finalHtml;
}

// ── CLI: escribe cache_elpodiotech.html ─────────────────────────────
if (require.main === module) {
  const html = generateTechHtml();
  if (html) {
    fs.writeFileSync(OUTPUT_PATH, html, 'utf8');
    const nActive = (loadOffers()?.categories || []).reduce(
      (a, c) => a + (c.products || []).filter(p => p.active).length, 0
    );
    console.log(`✅ cache_elpodiotech.html generado (${Buffer.byteLength(html, 'utf8')} bytes). Productos activos: ${nActive}`);
  } else {
    process.exit(1);
  }
}

module.exports = { generateTechHtml };
