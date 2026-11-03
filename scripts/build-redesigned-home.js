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
  if (/gamer/i.test(name)) return 'gaming';
  if (/celulares|notebook/i.test(name)) return 'tecnologia';
  if (/auriculares/i.test(name)) return 'audio';
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

const GROUPS = {
  todos: { name: 'Todo' },
  zapatillas: { name: 'Zapatillas' },
  tecnologia: { name: 'Tecnología' },
  audio: { name: 'Audio' },
  gaming: { name: 'Gaming' },
  hogar: { name: 'Hogar' },
  accesorios: { name: 'Accesorios' },
  deportes: { name: 'Deportes' }
};

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = value => '$ ' + Number(value).toLocaleString('es-AR');

function initialProducts(catalog) {
  return ['zapatillas', 'tecnologia', 'audio', 'gaming']
    .flatMap(group => catalog.products.filter(product => product.group === group).slice(0, 3));
}

function cardHTML(product, catalog) {
  const category = catalog.categories.find(item => item.id === product.category)?.name || GROUPS[product.group]?.name || 'Productos';
  const group = GROUPS[product.group]?.name || 'Productos';
  const destination = product.destination === 'category' ? 'Explorar esta categoría en Mercado Libre' : 'Ver este producto en Mercado Libre';
  const hint = product.destination === 'category' ? 'Explorá opciones en Mercado Libre' : 'Consultá la publicación en Mercado Libre';
  return `<article class="pcard group flex flex-col" data-product="${escapeHTML(product.id)}"><div class="relative"><div class="product-photo relative overflow-hidden aspect-square"><img src="${escapeHTML(product.image)}" alt="${escapeHTML(product.name)}" loading="lazy" class="pimg w-full h-full" referrerpolicy="no-referrer"></div><div class="absolute top-3.5 left-3.5"><span class="medal medal-${product.rank} w-9 h-9 text-[15px] shrink-0" title="Posición en nuestra selección">${product.rank}</span></div><span class="glass-chip px-3 py-1.5 text-[10px] font-disp font-semibold tracking-widest text-white/90 !bg-[#15151f]/85 absolute top-3.5 right-3.5 uppercase">${escapeHTML(group)}</span></div><div class="p-5 flex flex-col gap-2.5 flex-1"><div class="text-[10px] font-disp font-semibold tracking-[.12em] text-white/45 uppercase">${escapeHTML(category)}</div><h3 class="product-title font-disp font-bold text-[16px] leading-snug">${escapeHTML(product.name)}</h3><div class="mt-auto pt-2"><span class="block text-[10px] text-white/45">Precio de referencia</span><span class="font-disp font-bold text-[21px] text-[#c8ff3e] tracking-tight">${money(product.price)}</span></div><a href="${escapeHTML(product.url)}" target="_blank" rel="sponsored noopener noreferrer" class="btn-lime w-full py-3 text-[12px] mt-2" aria-label="${escapeHTML(destination + ': ' + product.name + ' (abre en otra pestaña)')}" title="${escapeHTML(destination)}">Ver en Mercado Libre <i data-lucide="arrow-up-right" class="w-4 h-4" aria-hidden="true"></i></a><p class="text-[10px] text-white/45 text-center">${hint}</p></div></article>`;
}

function renderGrid(catalog) {
  return `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-5">${initialProducts(catalog).map(product => cardHTML(product, catalog)).join('')}</div>`;
}

function renderSubcategoryOptions(catalog) {
  return '<select id="subcategory" class="catalog-select"><option value="todos">Todas las categorías</option>' +
    catalog.categories.map(category => `<option value="${escapeHTML(category.id)}">${escapeHTML(category.name)}</option>`).join('') +
    '</select>';
}

function replaceCatalog(template, catalog) {
  const payload = JSON.stringify(catalog).replace(/</g, '\\u003c');
  let html = template.replace(
    /<script id="catalog-data" type="application\/json">[\s\S]*?<\/script>/,
    `<script id="catalog-data" type="application/json">${payload}</script>`
  );
  html = html.replace('54 productos · 18 categorías', `${catalog.products.length} productos · ${catalog.categories.length} categorías`);
  html = html.replace(/<select id="subcategory" class="catalog-select">[\s\S]*?<\/select>/, renderSubcategoryOptions(catalog));
  html = html.replace(
    /(<div id="grid" class="[^"]*">)[\s\S]*?(<div class="text-center mt-10">)/,
    `$1${renderGrid(catalog)}</div>\n\n    $2`
  );
  const captured = new Date(catalog.capturedAt).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  html = html.replace(/Precios de referencia del catálogo guardado el \d{2}\/\d{2}\/\d{4}\./, `Precios de referencia del catálogo guardado el ${captured}.`);
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
