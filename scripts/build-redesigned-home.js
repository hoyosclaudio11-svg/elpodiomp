/**
 * Genera la home rediseñada desde el catálogo que actualizan los scrapers.
 * La plantilla visual vive en public/redesign/ y se copia a dist/ para
 * Cloudflare Pages junto con sus recursos estáticos.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DESIGN = path.join(ROOT, 'public', 'redesign');
const TEMPLATE = path.join(DESIGN, 'index.template.html');
const FIXTURE = path.join(ROOT, 'products-fixture.json');
const CONFIG = path.join(ROOT, 'config.json');

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

function groupFor(name) {
  if (/zapatillas|botines|ojotas|sandalias/i.test(name)) return 'zapatillas';
  if (/celulares|notebook/i.test(name)) return 'tecnologia';
  if (/auriculares/i.test(name)) return 'audio';
  if (/gamer/i.test(name)) return 'gaming';
  if (/termos|mates/i.test(name)) return 'hogar';
  if (/bicicletas/i.test(name)) return 'deportes';
  return 'accesorios';
}

function fallbackUrl(category, config) {
  const configured = config.categoryFallbacks && config.categoryFallbacks[category.id];
  if (typeof configured === 'string' && /^https:\/\//i.test(configured)) return configured;
  return `https://listado.mercadolibre.com.ar/${encodeURIComponent(category.query || category.name)}`;
}

function productUrl(value, fallback) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol === 'https:' && (host.endsWith('mercadolibre.com.ar') || host === 'meli.la' || host.endsWith('mercadolib.re'))) return url.href;
  } catch (_) { /* use the category fallback */ }
  return fallback;
}

function buildCatalog(fixture, config) {
  const categories = [];
  const products = [];
  const mainCategories = (config.categories || []).filter(category =>
    category.sites && category.sites.includes('elpodiomp') && Array.isArray(fixture[category.id]) && fixture[category.id].length
  );
  for (const category of mainCategories) {
    const group = groupFor(category.name);
    categories.push({ id: category.id, group, name: category.name });
    const fallback = fallbackUrl(category, config);
    fixture[category.id].slice(0, 3).forEach((item, index) => {
      const url = productUrl(item.link, fallback);
      products.push({
        id: `${category.id}-${index + 1}`,
        category: category.id,
        group,
        rank: index + 1,
        name: String(item.title || item.product || category.name),
        price: Number(item.price) || 0,
        image: String(item.imageUrl || ''),
        url,
        destination: url === fallback ? 'category' : 'product'
      });
    });
  }
  return { source: 'products-fixture.json', capturedAt: new Date().toISOString(), categories, products };
}

function replaceCatalog(template, catalog) {
  const payload = JSON.stringify(catalog).replace(/</g, '\\u003c');
  let html = template.replace(
    /<script id="catalog-data" type="application\/json">[\s\S]*?<\/script>/,
    `<script id="catalog-data" type="application/json">${payload}</script>`
  );
  html = html.replace('54 productos · 18 categorías', `${catalog.products.length} productos · ${catalog.categories.length} categorías`);
  html = html.replace(/<meta name="robots" content="noindex, nofollow">/, '<meta name="robots" content="index, follow">');
  html = html.replace('</head>', `<script async src="https://www.googletagmanager.com/gtag/js?id=G-DLGYCKX3RW"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-DLGYCKX3RW');</script><meta name="impact-site-verification" content="6a94980b-72ec-4ae7-bfc9-cd77253b5c8f"><meta name="verify-admitad" content="fc4cdbc4c8"></head>`);
  if (!html.includes('catalog-data')) throw new Error('No se encontró el catálogo en la plantilla del rediseño.');
  return html;
}

function buildRedesignedHome() {
  if (!fs.existsSync(TEMPLATE)) throw new Error(`Falta la plantilla: ${TEMPLATE}`);
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const catalog = buildCatalog(fixture, config);
  if (!catalog.products.length) throw new Error('No hay productos de El Podio MP en products-fixture.json.');
  copyDirectory(path.join(DESIGN, 'assets'), path.join(DIST, 'assets'));
  fs.copyFileSync(path.join(DESIGN, 'site.js'), path.join(DIST, 'site.js'));
  fs.writeFileSync(path.join(DIST, 'catalogo.json'), JSON.stringify(catalog), 'utf8');
  fs.writeFileSync(path.join(DIST, 'index.html'), replaceCatalog(fs.readFileSync(TEMPLATE, 'utf8'), catalog), 'utf8');
  console.log(`✅ Home rediseñada → index.html (${catalog.products.length} productos · ${catalog.categories.length} categorías)`);
  return catalog;
}

module.exports = { buildRedesignedHome };
