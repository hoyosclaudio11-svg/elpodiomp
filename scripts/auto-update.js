/**
 * Pipeline automático: scrape → regenerate cache → commit → push
 * Ejecutar: node scripts/auto-update.js
 *
 * Hace todo en secuencia:
 * 1. Scrapea productos reales de Mercado Libre (Puppeteer + stealth)
 * 2. Extrae MLA IDs de imágenes para categorías bloqueadas (fallback)
 * 3. Regenera cache.html con links reales
 * 4. Commitea y pushea solo si hubo cambios
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_PATH = path.join(ROOT, 'products-fixture.json');
const CACHE_PATH = path.join(ROOT, 'cache.html');

function log(msg) {
  const ts = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  console.log(`[${ts}] ${msg}`);
}

function run(cmd, label) {
  log(`▶ ${label}...`);
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', timeout: 300000 });
    log(`✅ ${label} completado.`);
    return true;
  } catch (err) {
    log(`❌ ${label} falló: ${err.message}`);
    return false;
  }
}

// ── Paso 1: Scrape ──────────────────────────────────────────────
log('══════ PIPELINE AUTO-UPDATE INICIADO ══════');

const scrapeOk = run('node scripts/scrape-real-products.js', '1/4 Scraping productos');

// ── Paso 2: Extraer MLA IDs de imágenes (fallback) ──────────────
log('2/4 Extrayendo MLA IDs de imágenes para links faltantes...');
try {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  let fixed = 0;
  Object.keys(fixture).forEach(cat => {
    fixture[cat].forEach(p => {
      if (p.link && /MLA-?\d{7,12}/.test(p.link)) return; // ya tiene link real
      const mlaMatch = (p.imageUrl || '').match(/MLA[_-]?(\d{7,12})/);
      if (mlaMatch) {
        const slugFn = (t) => (t || 'producto').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 80);
        p.link = 'https://articulo.mercadolibre.com.ar/MLA-' + mlaMatch[1] + '-' + slugFn(p.title) + '-_JM';
        fixed++;
      }
    });
  });
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2), 'utf8');
  log(`   ${fixed} links corregidos desde imágenes.`);
} catch (err) {
  log(`   ⚠️  Fallback de imágenes: ${err.message}`);
}

// ── Paso 3: Regenerar caché ─────────────────────────────────────
const cacheOk = run('node scripts/generate-cache.js', '3/4 Regenerando cache.html');

// ── Paso 4: Commit y push si hay cambios ────────────────────────
log('4/4 Verificando cambios para commit...');
try {
  const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
  if (status.trim()) {
    const changedFiles = status.trim().split('\n').map(l => l.trim()).filter(Boolean);
    log(`   Archivos modificados: ${changedFiles.length}`);
    changedFiles.forEach(f => console.log(`     - ${f}`));

    execSync('git add cache.html products-fixture.json', { cwd: ROOT });
    const commitMsg = `auto-update: productos actualizados (${new Date().toISOString().split('T')[0]})`;
    execSync(`git commit -m "${commitMsg}"`, { cwd: ROOT });
    log('   ✅ Commit realizado.');

    execSync('git push', { cwd: ROOT });
    log('   ✅ Push a origin/master completado.');
  } else {
    log('   Sin cambios. Nada para committear.');
  }
} catch (err) {
  log(`❌ Git falló: ${err.message}`);
}

log('══════ PIPELINE COMPLETADO ══════');
