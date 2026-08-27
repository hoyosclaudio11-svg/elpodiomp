/**
 * Prepara archivos para Cloudflare Pages.
 * Convierte los cache_*.html en una estructura de directorios estáticos.
 *
 * Estructura de salida:
 *   dist/
 *     index.html          → El Podio MP (default)
 *     tech/index.html     → El Podio Tech
 *     food/index.html     → El Podio Food
 *     hogar/index.html    → El Podio Hogar
 *     moda/index.html     → El Podio Moda
 *     privacidad.html
 *     terminos.html
 *     robots.txt
 *     sitemap.xml
 *     404.html
 *     public/             → archivos estáticos (og-image.png, etc.)
 *
 * Ejecutar: node scripts/build-cloudflare.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// Mapeo de siteId → carpeta
const SITE_MAP = {
  'elpodiomp': { dir: '', name: 'El Podio MP' },
  'elpodiotech': { dir: 'tech', name: 'El Podio Tech' },
  'elpodiofood': { dir: 'food', name: 'El Podio Food' },
  'elpodiohogar': { dir: 'hogar', name: 'El Podio Hogar' },
  'elpodiomoda': { dir: 'moda', name: 'El Podio Moda' },
  'elpodioaliexpress': { dir: 'aliexpress', name: 'El Podio AliExpress' },
};

// Limpiar dist
if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true });
}
fs.mkdirSync(DIST, { recursive: true });

// Copiar archivos públicos
if (fs.existsSync(PUBLIC)) {
  const distPublic = path.join(DIST, 'public');
  fs.mkdirSync(distPublic, { recursive: true });
  copyDir(PUBLIC, distPublic);
}

function copyDir(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// ── Verificación de propiedad Impact (red de afiliados) ──
const IMPACT_VERIFICATION_META =
  "<meta name='impact-site-verification' value='6a94980b-72ec-4ae7-bfc9-cd77253b5c8f'>";

function injectImpactVerification(html) {
  if (!html || html.indexOf('impact-site-verification') !== -1) return html;
  return html.replace('<head>', '<head>\n  ' + IMPACT_VERIFICATION_META);
}

// ── Transformar links de navegación ──────────────────
function transformNavLinks(html) {
  return html
    .replace(/href="\/\?site=elpodiomp"/g, 'href="/"')
    .replace(/href="\/\?site=elpodiotech"/g, 'href="/tech/"')
    .replace(/href="\/\?site=elpodiofood"/g, 'href="/food/"')
    .replace(/href="\/\?site=elpodiohogar"/g, 'href="/hogar/"')
    .replace(/href="\/\?site=elpodiomoda"/g, 'href="/moda/"')
    .replace(/href="\/\?site=elpodioaliexpress"/g, 'href="/aliexpress/"')
    // Links de footer también
    .replace(/\/\?site=elpodiotech/g, '/tech/')
    .replace(/\/\?site=elpodiofood/g, '/food/')
    .replace(/\/\?site=elpodiohogar/g, '/hogar/')
    .replace(/\/\?site=elpodiomoda/g, '/moda/')
    .replace(/\/\?site=elpodioaliexpress/g, '/aliexpress/')
    // El logo también apunta a /
    .replace(/href="\/"/g, 'href="/"');
}

// ── Copiar imágenes de bakery a dist/images/bakery/ ──
const BAKERY_IMAGES_SRC = path.join(ROOT, 'public', 'images', 'bakery');
const BAKERY_IMAGES_DEST = path.join(DIST, 'images', 'bakery');
if (fs.existsSync(BAKERY_IMAGES_SRC)) {
  fs.mkdirSync(BAKERY_IMAGES_DEST, { recursive: true });
  copyDir(BAKERY_IMAGES_SRC, BAKERY_IMAGES_DEST);
  const count = fs.readdirSync(BAKERY_IMAGES_SRC).filter(f => f !== '.gitkeep').length;
  console.log(`✅ ${count} imágenes de bakery → dist/images/bakery/`);
}

let totalFiles = 0;

// ── Procesar cada sitio ─────────────────────────────
for (const [siteId, info] of Object.entries(SITE_MAP)) {
  let html = null;

  // El Podio Tech: SIEMPRE se genera desde data/tech_offers.json (red Admitad),
  // nunca desde cache_elpodiotech.html scrapeado con Mercado Libre.
  if (siteId === 'elpodiotech' && fs.existsSync(path.join(ROOT, 'data', 'tech_offers.json'))) {
    html = require('./build-tech-from-offers.js').generateTechHtml();
    if (!html) {
      console.log(`⚠️  ${siteId}: generateTechHtml() falló.`);
      continue;
    }
  } else {
    const cachePath = path.join(ROOT, `cache_${siteId}.html`);
    if (!fs.existsSync(cachePath)) {
      console.log(`⚠️  ${siteId}: No se encontró cache_${siteId}.html`);
      continue;
    }
    html = fs.readFileSync(cachePath, 'utf8');
  }

  // Placeholder GA4 legacy → ID real (config o env)
  html = html.split('{{GA4_MEASUREMENT_ID}}').join(config.ga4MeasurementId || '');

  // Aplicar transformaciones
  html = transformNavLinks(html);

  // Home (El Podio MP): inyectar "Artículo de hoy" al tope del contenido
  if (siteId === 'elpodiomp' && !info.dir) {
    html = inyectarArticuloDestacado(html);
  }

  // Quitar el script de búsqueda AJAX (requiere server)
  // Tech usa fallback neutral (sin Mercado Libre); el resto redirige a ML como antes.
  const searchFallback = siteId === 'elpodiotech' ? `
<script>
  // ── Búsqueda: navega entre categorías de esta página ──
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
      else if (window.showToast) { showToast('No se encontró esa categoría'); }
    }
    btn.addEventListener('click', buscar);
    input.addEventListener('keydown', function(e) { if (e.key === 'Enter') buscar(); });
  })();
</script>` : `
<script>
  // ── Búsqueda: redirige a Mercado Libre ──
  (function() {
    var input = document.getElementById('searchInput');
    var btn = document.getElementById('searchBtn');
    if (!input || !btn) return;
    function buscar() {
      var q = input.value.trim();
      if (q) window.location.href = 'https://listado.mercadolibre.com.ar/' + encodeURIComponent(q);
    }
    btn.addEventListener('click', buscar);
    input.addEventListener('keydown', function(e) { if (e.key === 'Enter') buscar(); });
  })();
</script>`;
  html = html.replace(/<script>\s*\/\/ ── Búsqueda con sugerencias[\s\S]*?<\/script>/m, searchFallback);

  // Quitar script de contador (POST /api/visitas no funciona en estático)
  html = html.replace(/[\s\S]*?\/\/ ── Contador de Visitas[\s\S]*?registrarVisita\(\);[\s\S]*?\}\)\(\);[\s\S]*?<\/script>/m, `
<script>
  // Contador solo visual (no persiste sin servidor)
  (function() {
    var el = document.getElementById('visitCount');
    if (el) el.textContent = '...';
  })();
</script>`);

  // Crear directorio destino
  const destDir = info.dir ? path.join(DIST, info.dir) : DIST;
  if (info.dir) fs.mkdirSync(destDir, { recursive: true });

  // Inyectar verificación de Impact
  html = injectImpactVerification(html);

  // Escribir index.html
  fs.writeFileSync(path.join(destDir, 'index.html'), html, 'utf8');
  console.log(`✅ ${info.name} → ${info.dir || '.'}/index.html (${Buffer.byteLength(html, 'utf8')} bytes)`);
  totalFiles++;
}

// ── Verificación: sin placeholders {{...}} en salida ──
let placeholderCount = 0;
for (const [siteId, info] of Object.entries(SITE_MAP)) {
  const indexPath = info.dir ? path.join(DIST, info.dir, 'index.html') : path.join(DIST, 'index.html');
  if (!fs.existsSync(indexPath)) continue;
  const found = (fs.readFileSync(indexPath, 'utf8').match(/\{\{[^}]+\}\}/g) || []).length;
  if (found) {
    placeholderCount += found;
    console.log(`⚠️  ${siteId}: ${found} placeholders {{...}} en salida`);
  }
}
if (placeholderCount) {
  console.error(`❌ ${placeholderCount} placeholders quedaron en dist/. Revisar antes de deploy.`);
  process.exit(1);
}
console.log('✅ Sin placeholders {{...}} en dist/.');

// ── Páginas estáticas ───────────────────────────────
const staticPages = {
  'privacidad.html': createPrivacidadPage(),
  'terminos.html': createTerminosPage(),
  '404.html': create404Page(),
  'robots.txt': createRobotsTxt(),
  'sitemap.xml': createSitemap(),
};
Object.entries(staticPages).forEach(([file, content]) => {
  if (file.endsWith('.html')) content = injectImpactVerification(content);
  fs.writeFileSync(path.join(DIST, file), content, 'utf8');
  console.log(`✅ ${file}`);
  totalFiles++;
});

// ── Artículo destacado: página estática /<slug>/ ────
const articulo = leerArticuloDestacado();
if (articulo && articulo.slug) {
  const articuloDir = path.join(DIST, articulo.slug);
  fs.mkdirSync(articuloDir, { recursive: true });
  const articuloHtml = injectImpactVerification(createArticuloPage(articulo));
  fs.writeFileSync(path.join(articuloDir, 'index.html'), articuloHtml, 'utf8');
  console.log(`✅ Artículo estático → /${articulo.slug}/ (${articulo.titulo})`);
  totalFiles++;
}

// ── Redirects para Cloudflare Pages (_redirects) ─────
// Soporte legacy: ?site=xxx → /xxx/
const redirects = `
# Redirigir query params legacy a paths
/  /  200

# Sitemap y robots
/sitemap.xml  /sitemap.xml  200
/robots.txt   /robots.txt   200
`.trim();
fs.writeFileSync(path.join(DIST, '_redirects'), redirects, 'utf8');

console.log(`\n═══ ${totalFiles} archivos generados en dist/ ═══`);
console.log('Listo para deployar en Cloudflare Pages.');

// ── Helpers ─────────────────────────────────────────
function createPrivacidadPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Política de Privacidad — El Podio</title>
  <style>
    body { font-family: 'Inter', sans-serif; max-width: 800px; margin: 48px auto; padding: 0 24px; color: #333; line-height: 1.7; background: #f5f5f5; }
    h1 { color: #1a1a1a; border-bottom: 3px solid #38bdf8; padding-bottom: 12px; }
    a { color: #38bdf8; }
  </style>
</head>
<body>
  <h1>Política de Privacidad</h1>
  <p><strong>Última actualización:</strong> Agosto 2026</p>
  <p>En <strong>El Podio</strong> no recopilamos datos personales. Mostramos ofertas seleccionadas de tiendas de terceros y te redirigimos a sus sitios para completar la compra.</p>
  <p>Utilizamos Google Analytics 4 (GA4) para medir visitas y clics de forma anónima y agregada.</p>
  <p><strong>Cookies:</strong> No usamos cookies propias. GA4 puede almacenar datos de navegación en tu navegador. Las tiendas de terceros a las que te redirigimos pueden establecer sus propias cookies según sus políticas.</p>
  <p>Consultas: <a href="mailto:grupomontesdelnorte@gmail.com">grupomontesdelnorte@gmail.com</a></p>
  <p><a href="/">&larr; Volver al inicio</a></p>
</body>
</html>`;
}

function createTerminosPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Términos y Condiciones — El Podio</title>
  <style>
    body { font-family: 'Inter', sans-serif; max-width: 800px; margin: 48px auto; padding: 0 24px; color: #333; line-height: 1.7; background: #f5f5f5; }
    h1 { color: #1a1a1a; border-bottom: 3px solid #38bdf8; padding-bottom: 12px; }
    a { color: #38bdf8; }
  </style>
</head>
<body>
  <h1>Términos y Condiciones</h1>
  <p><strong>Última actualización:</strong> Agosto 2026</p>
  <p><strong>El Podio</strong> es un sitio de comparación de ofertas y enlaces de afiliados. No vendemos productos directamente y no tenemos stock propio: mostramos ofertas de tiendas de terceros y te redirigimos a sus sitios, donde se realiza la compra.</p>
  <p>Podemos recibir una comisión si comprás a través de nuestros enlaces, sin costo extra para vos.</p>
  <p>Los precios mostrados son aproximados y pueden variar al ingresar a la tienda de destino.</p>
  <p>Las compras se realizan en tiendas de terceros y están sujetas a sus términos y condiciones.</p>
  <p>Consultas: <a href="mailto:grupomontesdelnorte@gmail.com">grupomontesdelnorte@gmail.com</a></p>
  <p><a href="/">&larr; Volver al inicio</a></p>
</body>
</html>`;
}

function create404Page() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Página no encontrada — El Podio MP</title>
  <style>
    body { font-family: 'Inter', sans-serif; text-align: center; padding: 80px 24px; color: #333; background: #f5f5f5; }
    h1 { font-size: 72px; color: #FFE600; margin: 0; text-shadow: 2px 2px 0 #1a1a1a; }
    p { margin: 16px 0; font-size: 18px; }
    a { color: #3483FA; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <h1>404</h1>
  <p>La página que buscás no existe.</p>
  <p><a href="/">&larr; Volver al inicio</a></p>
</body>
</html>`;
}

function createRobotsTxt() {
  return `User-agent: *
Allow: /
Sitemap: https://elpodiomp.com.ar/sitemap.xml
`;
}

function createSitemap() {
  const siteConfig = config.sites ? Object.values(config.sites) : [{ domain: 'elpodiomp.com.ar' }];
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  const paths = ['', '/tech/', '/food/', '/hogar/', '/moda/', '/aliexpress/'];
  paths.forEach(p => {
    xml += `  <url><loc>https://elpodiomp.com.ar${p}</loc><changefreq>daily</changefreq><priority>${p === '' ? '1.0' : '0.8'}</priority></url>\n`;
  });

  // Artículo destacado (último post publicado)
  const articulo = leerArticuloDestacado();
  if (articulo && articulo.slug) {
    xml += `  <url><loc>https://elpodiomp.com.ar/${articulo.slug}/</loc><changefreq>daily</changefreq><priority>0.9</priority></url>\n`;
  }

  xml += '  <url><loc>https://elpodiomp.com.ar/privacidad</loc><changefreq>monthly</changefreq><priority>0.3</priority></url>\n';
  xml += '  <url><loc>https://elpodiomp.com.ar/terminos</loc><changefreq>monthly</changefreq><priority>0.3</priority></url>\n';
  xml += '</urlset>';
  return xml;
}

// ── Artículo destacado (data/articulo_destacado.json) ──
function leerArticuloDestacado() {
  const jsonPath = path.join(ROOT, 'data', 'articulo_destacado.json');
  if (!fs.existsSync(jsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    console.log(`⚠️ articulo_destacado.json ilegible: ${e.message}`);
    return null;
  }
}

// Inyecta "Artículo de hoy" al tope del <main> de la home
function inyectarArticuloDestacado(html) {
  const a = leerArticuloDestacado();
  if (!a || !a.titulo) return html;

  const imagen = a.imagen
    ? `<img src="${a.imagen}" alt="${a.titulo.replace(/"/g, '&quot;')}" style="width:220px;max-width:40%;border-radius:12px;object-fit:cover;" loading="lazy">`
    : '';

  const botones = (a.links_productos || [])
    .map((url, i) => `<a class="btn" href="${url}" target="_blank" rel="noopener" style="text-decoration:none;">Ver oferta #${i + 1} &rarr;</a>`)
    .join(' ');

  const bloque = `
    <section class="section">
      <div class="section-header">
        <h2><span class="icon">📰</span> Artículo de hoy</h2>
        <a href="/${a.slug}/" class="view-all">Leer artículo completo &rarr;</a>
      </div>
      <div class="articulo-destacado" style="display:flex;gap:20px;flex-wrap:wrap;align-items:center;background:#fff;border:2px solid #FFE600;border-radius:16px;padding:16px;box-shadow:0 4px 12px rgba(0,0,0,.08);">
        ${imagen}
        <div style="flex:1;min-width:220px;">
          <h3 style="margin:0 0 8px;color:#1a1a1a;font-size:1.15rem;">${a.titulo}</h3>
          <p style="margin:0 0 12px;color:#555;">${a.excerpt || ''}</p>
          ${botones}
          <a href="/${a.slug}/" style="display:inline-block;margin-top:8px;color:#3483FA;text-decoration:none;font-weight:600;">Leer artículo completo &rarr;</a>
        </div>
      </div>
    </section>`;

  return html.replace('<main class="container">', '<main class="container">' + bloque);
}

// Página estática del artículo (dist/<slug>/index.html)
function createArticuloPage(a) {
  const imagen = a.imagen
    ? `<img src="${a.imagen}" alt="${a.titulo.replace(/"/g, '&quot;')}" style="max-width:100%;border-radius:12px;margin:16px 0;">`
    : '';

  const botones = (a.links_productos || [])
    .map((url, i) => `<a class="btn" href="${url}" target="_blank" rel="noopener">Ver oferta #${i + 1} &rarr;</a>`)
    .join(' ');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${a.titulo} — El Podio MP</title>
  <meta name="description" content="${(a.excerpt || '').replace(/"/g, '&quot;').slice(0, 155)}">
  <link rel="canonical" href="https://elpodiomp.com.ar/${a.slug}/">
  <style>
    body { font-family: 'Inter', sans-serif; max-width: 780px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.7; background: #f5f5f5; }
    .logo a { color: #1a1a1a; text-decoration: none; font-weight: 800; }
    .logo span { color: #3483FA; }
    h1 { font-size: 1.6rem; line-height: 1.3; margin: 16px 0 4px; }
    .fecha { color: #777; font-size: .85rem; margin-bottom: 16px; }
    a { color: #3483FA; }
    .articulo-contenido { background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    .articulo-contenido p { margin: 12px 0; }
    .articulo-contenido strong { color: #1a1a1a; }
    .btn { display: inline-block; background: #3483FA; color: #fff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 700; margin: 4px 8px 4px 0; }
    .volver { display: block; margin-top: 24px; text-align: center; color: #3483FA; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <div class="logo"><a href="/">Elpodiomp<span>.com.ar</span></a></div>
  <h1>${a.titulo}</h1>
  <div class="fecha">${a.fecha ? new Date(a.fecha).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' }) : ''}</div>
  <div class="articulo-contenido">
    ${imagen}
    ${a.contenido_html || ''}
    <p style="margin-top:20px;">${botones}</p>
    <p style="margin-top:16px;"><a href="/" style="font-weight:700;">&larr; Volver a El Podio MP</a></p>
  </div>
  <a class="volver" href="/">⬅ Volver a la home de El Podio</a>
</body>
</html>`;
}
