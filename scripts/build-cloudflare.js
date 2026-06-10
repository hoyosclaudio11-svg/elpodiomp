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

// ── Transformar links de navegación ──────────────────
function transformNavLinks(html) {
  return html
    .replace(/href="\/\?site=elpodiomp"/g, 'href="/"')
    .replace(/href="\/\?site=elpodiotech"/g, 'href="/tech/"')
    .replace(/href="\/\?site=elpodiofood"/g, 'href="/food/"')
    .replace(/href="\/\?site=elpodiohogar"/g, 'href="/hogar/"')
    .replace(/href="\/\?site=elpodiomoda"/g, 'href="/moda/"')
    // Links de footer también
    .replace(/\/\?site=elpodiotech/g, '/tech/')
    .replace(/\/\?site=elpodiofood/g, '/food/')
    .replace(/\/\?site=elpodiohogar/g, '/hogar/')
    .replace(/\/\?site=elpodiomoda/g, '/moda/')
    // El logo también apunta a /
    .replace(/href="\/"/g, 'href="/"');
}

let totalFiles = 0;

// ── Procesar cada sitio ─────────────────────────────
for (const [siteId, info] of Object.entries(SITE_MAP)) {
  const cachePath = path.join(ROOT, `cache_${siteId}.html`);
  if (!fs.existsSync(cachePath)) {
    console.log(`⚠️  ${siteId}: No se encontró cache_${siteId}.html`);
    continue;
  }

  let html = fs.readFileSync(cachePath, 'utf8');

  // Aplicar transformaciones
  html = transformNavLinks(html);

  // Quitar el script de búsqueda AJAX (requiere server)
  html = html.replace(/<script>\s*\/\/ ── Búsqueda con sugerencias[\s\S]*?<\/script>/m, `
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
</script>`);

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

  // Escribir index.html
  fs.writeFileSync(path.join(destDir, 'index.html'), html, 'utf8');
  console.log(`✅ ${info.name} → ${info.dir || '.'}/index.html (${Buffer.byteLength(html, 'utf8')} bytes)`);
  totalFiles++;
}

// ── Páginas estáticas ───────────────────────────────
const staticPages = {
  'privacidad.html': createPrivacidadPage(),
  'terminos.html': createTerminosPage(),
  '404.html': create404Page(),
  'robots.txt': createRobotsTxt(),
  'sitemap.xml': createSitemap(),
};
Object.entries(staticPages).forEach(([file, content]) => {
  fs.writeFileSync(path.join(DIST, file), content, 'utf8');
  console.log(`✅ ${file}`);
  totalFiles++;
});

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
  <title>Política de Privacidad — El Podio MP</title>
  <style>
    body { font-family: 'Inter', sans-serif; max-width: 800px; margin: 48px auto; padding: 0 24px; color: #333; line-height: 1.7; background: #f5f5f5; }
    h1 { color: #1a1a1a; border-bottom: 3px solid #FFE600; padding-bottom: 12px; }
    a { color: #3483FA; }
  </style>
</head>
<body>
  <h1>Política de Privacidad</h1>
  <p><strong>Última actualización:</strong> Junio 2026</p>
  <p>En <strong>El Podio MP</strong> no recopilamos datos personales. Solo mostramos información de productos disponibles en Mercado Libre. Al hacer clic en un producto, sos redirigido a Mercado Libre, donde aplican sus propias políticas de privacidad.</p>
  <p>Utilizamos Google Analytics para medir visitas de forma anónima.</p>
  <p><strong>Cookies:</strong> No usamos cookies propias. Mercado Libre puede establecer cookies al seguir un enlace.</p>
  <p>Consultas: <a href="mailto:info@elpodiomp.com.ar">info@elpodiomp.com.ar</a></p>
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
  <title>Términos y Condiciones — El Podio MP</title>
  <style>
    body { font-family: 'Inter', sans-serif; max-width: 800px; margin: 48px auto; padding: 0 24px; color: #333; line-height: 1.7; background: #f5f5f5; }
    h1 { color: #1a1a1a; border-bottom: 3px solid #FFE600; padding-bottom: 12px; }
    a { color: #3483FA; }
  </style>
</head>
<body>
  <h1>Términos y Condiciones</h1>
  <p><strong>Última actualización:</strong> Junio 2026</p>
  <p><strong>El Podio MP</strong> es un sitio informativo que muestra productos de Mercado Libre. No vendemos productos directamente: mostramos información de productos disponibles en Mercado Libre y redirigimos a su plataforma.</p>
  <p>Todas las compras se realizan en Mercado Libre y están sujetas a sus términos y condiciones.</p>
  <p>Los precios mostrados son aproximados y pueden variar al ingresar a Mercado Libre.</p>
  <p>Consultas: <a href="mailto:info@elpodiomp.com.ar">info@elpodiomp.com.ar</a></p>
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

  const paths = ['', '/tech/', '/food/', '/hogar/', '/moda/'];
  paths.forEach(p => {
    xml += `  <url><loc>https://elpodiomp.com.ar${p}</loc><changefreq>daily</changefreq><priority>${p === '' ? '1.0' : '0.8'}</priority></url>\n`;
  });
  xml += '  <url><loc>https://elpodiomp.com.ar/privacidad</loc><changefreq>monthly</changefreq><priority>0.3</priority></url>\n';
  xml += '  <url><loc>https://elpodiomp.com.ar/terminos</loc><changefreq>monthly</changefreq><priority>0.3</priority></url>\n';
  xml += '</urlset>';
  return xml;
}
