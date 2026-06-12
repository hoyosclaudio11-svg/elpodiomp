/**
 * Valida productos premium con DeepSeek IA.
 * Filtra accesorios/repuestos que pasaron los filtros de keywords,
 * rankea calidad y mejora descripciones.
 *
 * Paso 1.5 del pipeline auto-update.
 * Ejecutar: node scripts/rank-premium-ia.js
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ override: true });

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const FIXTURE_PATH = path.join(__dirname, '..', 'products-fixture.json');
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// Categorías premium (las que tienen minPrice) — son las que validamos
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const premiumIds = new Set(
  config.categories.filter(c => c.minPrice && c.minPrice > 0).map(c => c.id)
);

function log(msg) {
  const ts = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  console.log(`[${ts}] ${msg}`);
}

async function validateCategory(catId, catName, products, minPrice) {
  if (!DEEPSEEK_API_KEY) {
    log(`⚠️  Sin DEEPSEEK_API_KEY. Omitiendo validación IA de "${catName}".`);
    return products;
  }
  if (!products || products.length === 0) return products;

  const productList = products
    .map((p, i) => `[${i + 1}] "${p.title}" — $${p.price?.toLocaleString() || '?'} — Link: ${p.link || 'sin link'}`)
    .join('\n');

  const prompt = `Sos un validador de productos para un sitio de ofertas argentino.

CATEGORÍA: "${catName}"
PRECIO MÍNIMO ESPERADO: $${minPrice?.toLocaleString() || '0'} ARS

Productos scrapeados de Mercado Libre Argentina:

${productList}

Para cada producto, determiná si es REALMENTE un "${catName}" o si es un ACCESORIO/REPUESTO/FUNDA/CARGADOR/PANTALLA/etc.

Devolvé SOLO este JSON (sin explicaciones, sin markdown):

{
  "valid": [1, 3, 5],
  "invalid": [2, 4],
  "fixes": {
    "2": "Es un cargador, no una notebook",
    "4": "Es una funda/protector, no una notebook"
  }
}

Reglas CRÍTICAS:
- "valid": índices de productos que SÍ son realmente lo que dice la categoría
- "invalid": índices de productos que NO son (accesorios, repuestos, fundas, cargadores, coolers, pantallas de repuesto, baterías sueltas, etc.)
- "fixes": motivo corto por cada inválido
- Si un producto es el artículo principal MÁS accesorios (ej: "Notebook + mochila + mouse"), es VÁLIDO
- Si el producto ES SOLO el accesorio (ej: "Cargador para Notebook"), es INVÁLIDO
- No marques como inválido solo porque el precio parezca bajo — a veces hay ofertas reales`;

  try {
    const res = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.05,
      max_tokens: 1000
    }, {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const text = res.data.choices[0].message.content.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log(`   ⚠️  DeepSeek no devolvió JSON válido. Manteniendo todos los productos.`);
      return products;
    }

    const result = JSON.parse(jsonMatch[0]);
    const validSet = new Set(result.valid || []);
    const invalidSet = new Set(result.invalid || []);

    const validated = products.filter((_, i) => validSet.has(i + 1));
    const removed = products.filter((_, i) => invalidSet.has(i + 1));

    if (removed.length > 0) {
      log(`   🧹 DeepSeek eliminó ${removed.length} accesorio(s):`);
      removed.forEach(p => {
        const idx = products.indexOf(p) + 1;
        const motivo = (result.fixes || {})[String(idx)] || 'accesorio/repuesto';
        log(`      ❌ "${p.title?.substring(0, 70)}..." → ${motivo}`);
      });
    }
    if (validated.length === products.length) {
      log(`   ✅ DeepSeek validó los ${products.length} productos. Ningún accesorio.`);
    }

    return validated;
  } catch (err) {
    log(`   ⚠️  Error DeepSeek: ${err.message}. Manteniendo productos originales.`);
    return products;
  }
}

async function main() {
  log('🧠 Ranker IA Premium — Validando productos con DeepSeek...\n');

  if (!fs.existsSync(FIXTURE_PATH)) {
    log('❌ No existe products-fixture.json. Ejecutá primero scrape-real-products.js.');
    process.exit(1);
  }

  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  let totalRemoved = 0;

  for (const catId of Object.keys(fixture)) {
    if (!premiumIds.has(catId)) continue;
    const cat = config.categories.find(c => c.id === catId);
    if (!cat) continue;

    const products = fixture[catId];
    if (!products || products.length === 0) continue;

    log(`🔍 Validando ${cat.icon} ${cat.name} (${products.length} productos, minPrice: $${cat.minPrice?.toLocaleString()})...`);

    const validated = await validateCategory(catId, cat.name, products, cat.minPrice);
    fixture[catId] = validated;
    totalRemoved += products.length - validated.length;
  }

  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2), 'utf8');

  if (totalRemoved > 0) {
    log(`\n🧹 Total eliminados por IA: ${totalRemoved} accesorios/repuestos.`);
  } else {
    log(`\n✅ Ningún accesorio detectado por IA.`);
  }
  log(`💾 Fixture actualizado.`);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
