/**
 * GENERADOR DE IMÁGENES DE PANADERÍA CON IA
 *
 * Genera imágenes fotorrealistas de productos de panadería (medialunas, facturas,
 * churros, etc.) usando OpenRouter (Gemini 2.5 Flash Image) como primario
 * y Leonardo.ai como fallback.
 *
 * Las imágenes se cachean en public/images/bakery/ y se registran en
 * bakery-image-cache.json para no regenerar ofertas ya conocidas.
 *
 * Ejecutar: node scripts/generate-bakery-images.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config({ override: true });

const ROOT = path.join(__dirname, '..');
const IMAGES_DIR = path.join(ROOT, 'public', 'images', 'bakery');
const CACHE_PATH = path.join(ROOT, 'bakery-image-cache.json');

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const LEONARDO_KEY = process.env.LEONARDO_API_KEY;

// Modelos
const OPENROUTER_MODEL = 'google/gemini-2.5-flash-image';
const LEONARDO_MODEL_ID = 'b24e16ff-06e3-43eb-8d33-4416c2d75876';

// Timeouts
const GENERATION_TIMEOUT_MS = 90000;
const POLL_INTERVAL_MS = 3000;

// ── Helpers ──
function log(msg) {
  const ts = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function makeBakeryKey(bakery, product) {
  // Normalizar: lowercase, sin tildes, sin espacios extras
  const norm = (s) => (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${norm(bakery)}|${norm(product)}`;
}

function hashKey(key) {
  return crypto.createHash('md5').update(key).digest('hex').substring(0, 12);
}

// ── Caché de imágenes ──
function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

function getCachedImage(bakery, product) {
  const key = makeBakeryKey(bakery, product);
  const cache = loadCache();
  const entry = cache[key];
  if (entry && entry.file) {
    const filePath = path.join(IMAGES_DIR, entry.file);
    if (fs.existsSync(filePath)) {
      log(`   💾 Caché HIT: ${key} → ${entry.file}`);
      return `/images/bakery/${entry.file}`;
    }
    // Archivo no encontrado en disco → invalidar caché
    log(`   ⚠️  Caché STALE (archivo no existe): ${entry.file}`);
    delete cache[key];
    saveCache(cache);
  }
  return null;
}

function saveCachedImage(bakery, product, filename, source) {
  const key = makeBakeryKey(bakery, product);
  const cache = loadCache();
  cache[key] = {
    file: filename,
    generated: new Date().toISOString().split('T')[0],
    source: source
  };
  saveCache(cache);
  log(`   💾 Caché SAVED: ${key} → ${filename}`);
}

// ── Generación con OpenRouter (Gemini 2.5 Flash Image) ──
async function generateWithOpenRouter(bakery, product) {
  if (!OPENROUTER_KEY) {
    log('   ⚠️  OPENROUTER_API_KEY no configurada. Saltando OpenRouter.');
    return null;
  }

  const prompt = `Professional food photography of ${product} from ${bakery}, golden brown Argentine pastry on a rustic wooden table with a linen napkin, natural daylight from a window, shallow depth of field focusing on the pastry, appetizing and warm atmosphere, crumbs scattered artistically, steam rising subtly, high resolution, realistic, no text, no watermark, no logos, no letters`;

  log(`   🎨 OpenRouter: Generando "${product}" de ${bakery}...`);

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
            ],
          },
        ],
        max_tokens: 4096,
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://elpodiomp.com.ar',
          'X-Title': 'El Podio MP - Bakery Images',
        },
        timeout: GENERATION_TIMEOUT_MS,
      }
    );

    // Extraer imagen base64 de la respuesta
    const message = response.data?.choices?.[0]?.message;
    if (!message) {
      log('   ⚠️  OpenRouter: respuesta sin message');
      return null;
    }

    // Gemini 2.5 Flash Image puede devolver la imagen en el content
    const content = message.content;
    if (typeof content === 'string') {
      // Puede ser markdown con ![image](data:...) o solo base64
      const b64Match = content.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
      if (b64Match) {
        return Buffer.from(b64Match[1], 'base64');
      }
      // Intentar markdown image tag
      const mdMatch = content.match(/!\[.*?\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)\)/);
      if (mdMatch) {
        const innerB64 = mdMatch[1].match(/base64,([A-Za-z0-9+/=]+)/);
        if (innerB64) return Buffer.from(innerB64[1], 'base64');
      }
      log(`   ⚠️  OpenRouter: no se pudo extraer base64 del content (${content.substring(0, 100)}...)`);
      return null;
    }

    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'image_url' && part.image_url?.url) {
          const url = part.image_url.url;
          if (url.startsWith('data:')) {
            const b64 = url.match(/base64,([A-Za-z0-9+/=]+)/);
            if (b64) return Buffer.from(b64[1], 'base64');
          }
          // URL directa → descargar
          const imgResp = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
          return Buffer.from(imgResp.data);
        }
        if (part.type === 'image' && part.data) {
          return Buffer.from(part.data, 'base64');
        }
      }
    }

    log('   ⚠️  OpenRouter: formato de respuesta no reconocido');
    return null;
  } catch (err) {
    log(`   ❌ OpenRouter: ${err.message}`);
    if (err.response) {
      log(`      Status: ${err.response.status}, Data: ${JSON.stringify(err.response.data).substring(0, 200)}`);
    }
    return null;
  }
}

// ── Generación con Leonardo.ai (fallback) ──
async function generateWithLeonardo(bakery, product) {
  if (!LEONARDO_KEY) {
    log('   ⚠️  LEONARDO_API_KEY no configurada. Saltando Leonardo.ai.');
    return null;
  }

  const prompt = `Professional food photography of ${product} from ${bakery}, golden brown Argentine pastry on a rustic wooden table, natural daylight, shallow depth of field, appetizing, warm atmosphere, high resolution, realistic, no text no watermark no logos`;

  log(`   🎨 Leonardo.ai: Generando "${product}" de ${bakery}...`);

  try {
    // 1. Iniciar generación
    const genResp = await axios.post(
      'https://cloud.leonardo.ai/api/rest/v1/generations',
      {
        prompt: prompt,
        modelId: LEONARDO_MODEL_ID,
        num_images: 1,
        width: 768,
        height: 576,
        alchemy: false,
        negative_prompt: 'blurry, watermark, text, letters, distorted, bad anatomy, deformed, ugly, low quality',
      },
      {
        headers: {
          'Authorization': `Bearer ${LEONARDO_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );

    const generationId = genResp.data?.sdGenerationJob?.generationId;
    if (!generationId) {
      log('   ⚠️  Leonardo.ai: no se obtuvo generationId');
      return null;
    }

    // 2. Polling hasta que esté listo
    const startTime = Date.now();
    while (Date.now() - startTime < GENERATION_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);

      const pollResp = await axios.get(
        `https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`,
        { headers: { 'Authorization': `Bearer ${LEONARDO_KEY}` }, timeout: 10000 }
      );

      const status = pollResp.data?.generations_by_pk?.status;
      if (status === 'COMPLETE') {
        const imageUrl = pollResp.data?.generations_by_pk?.generated_images?.[0]?.url;
        if (imageUrl) {
          const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
          log(`   ✅ Leonardo.ai: imagen generada (${(imgResp.data.length / 1024).toFixed(1)} KB)`);
          return Buffer.from(imgResp.data);
        }
        log('   ⚠️  Leonardo.ai: COMPLETE pero sin URL de imagen');
        return null;
      }
      if (status === 'FAILED') {
        log(`   ❌ Leonardo.ai: generación fallida`);
        return null;
      }
    }

    log('   ⚠️  Leonardo.ai: timeout de polling');
    return null;
  } catch (err) {
    log(`   ❌ Leonardo.ai: ${err.message}`);
    return null;
  }
}

// ── Pipeline principal ──
async function generateBakeryImage(bakery, product) {
  const key = makeBakeryKey(bakery, product);
  const hash = hashKey(key);
  const filename = `bakery_${hash}.jpg`;
  const filePath = path.join(IMAGES_DIR, filename);

  // 1. Intentar OpenRouter (primario)
  let imageBuffer = await generateWithOpenRouter(bakery, product);

  // 2. Fallback a Leonardo.ai
  if (!imageBuffer) {
    log('   🔄 Fallback a Leonardo.ai...');
    imageBuffer = await generateWithLeonardo(bakery, product);
  }

  if (!imageBuffer) {
    log(`   ❌ No se pudo generar imagen para "${key}"`);
    return null;
  }

  // Guardar imagen
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }
  fs.writeFileSync(filePath, imageBuffer);
  log(`   🖼️  Imagen guardada: ${filename} (${(imageBuffer.length / 1024).toFixed(1)} KB)`);

  // Registrar en caché
  const source = OPENROUTER_KEY ? 'openrouter' : 'leonardo';
  saveCachedImage(bakery, product, filename, source);

  return `/images/bakery/${filename}`;
}

// ── Batch: generar imágenes para una lista de ofertas ──
async function generateImagesForOffers(offers) {
  if (!offers || offers.length === 0) {
    log('📸 Sin ofertas para procesar.');
    return offers;
  }

  log(`📸 Procesando imágenes para ${offers.length} ofertas...\n`);

  for (const offer of offers) {
    const cachedUrl = getCachedImage(offer.bakery, offer.product);
    if (cachedUrl) {
      offer.imageUrl = cachedUrl;
      continue;
    }

    // Intentar generar con IA
    log(`\n🥐 ${offer.bakery} — ${offer.product}`);
    const generatedUrl = await generateBakeryImage(offer.bakery, offer.product);
    if (generatedUrl) {
      offer.imageUrl = generatedUrl;
    } else {
      log(`   ⚠️  Usando imagen existente (no se pudo generar IA)`);
      // Mantener la imagen actual si ya tiene una
    }
  }

  return offers;
}

// ── Limpieza de imágenes viejas ──
function cleanupOldImages(daysToKeep = 30) {
  if (!fs.existsSync(IMAGES_DIR)) return;

  const cache = loadCache();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysToKeep);

  const activeFiles = new Set(Object.values(cache).map(e => e.file).filter(Boolean));

  const files = fs.readdirSync(IMAGES_DIR);
  let deleted = 0;

  for (const file of files) {
    if (file === '.gitkeep') continue;
    const filePath = path.join(IMAGES_DIR, file);
    const stat = fs.statSync(filePath);

    // Si no está en caché y es más viejo que el cutoff, eliminar
    if (!activeFiles.has(file) && stat.mtime < cutoff) {
      fs.unlinkSync(filePath);
      deleted++;
      log(`   🗑️  Eliminada: ${file}`);
    }
  }

  if (deleted > 0) log(`   🧹 Limpieza: ${deleted} imágenes viejas eliminadas.`);
}

// ── MAIN (cuando se ejecuta standalone) ──
async function main() {
  log('🎨 INICIANDO GENERADOR DE IMÁGENES DE PANADERÍA...\n');

  // Verificar API keys
  if (!OPENROUTER_KEY && !LEONARDO_KEY) {
    log('❌ ERROR: Ni OPENROUTER_API_KEY ni LEONARDO_API_KEY configuradas.');
    log('   Agregá al menos una en el archivo .env');
    log('   OPENROUTER_API_KEY=sk-or-v1-...');
    log('   LEONARDO_API_KEY=...');
    process.exit(1);
  }

  log(`   OpenRouter: ${OPENROUTER_KEY ? '✅ Configurado' : '❌ No configurado'}`);
  log(`   Leonardo.ai: ${LEONARDO_KEY ? '✅ Configurado' : '❌ No configurado'}\n`);

  // Cargar bakery-offers.json
  const offersPath = path.join(ROOT, 'bakery-offers.json');
  if (!fs.existsSync(offersPath)) {
    log('⚠️  bakery-offers.json no encontrado. Nada que generar.');
    process.exit(0);
  }

  const offers = JSON.parse(fs.readFileSync(offersPath, 'utf8'));
  log(`📋 ${offers.length} ofertas cargadas de bakery-offers.json\n`);

  // Generar imágenes para cada oferta
  await generateImagesForOffers(offers);

  // Guardar bakery-offers.json actualizado con las nuevas URLs de imagen
  fs.writeFileSync(offersPath, JSON.stringify(offers, null, 2), 'utf8');
  log('\n✅ bakery-offers.json actualizado con URLs de imágenes IA.');

  // Limpiar imágenes viejas cada 7 ejecuciones (~1 vez por semana)
  if (Math.random() < 0.14) {
    log('\n🧹 Ejecutando limpieza programada de imágenes viejas...');
    cleanupOldImages(30);
  }

  log('\n🎨 ══════ GENERADOR DE IMÁGENES COMPLETADO ══════');
}

// Si se ejecuta directamente
if (require.main === module) {
  main().catch(err => {
    console.error('❌ Error crítico:', err.message);
    process.exit(1);
  });
}

module.exports = { generateImagesForOffers, getCachedImage, generateBakeryImage, cleanupOldImages };
