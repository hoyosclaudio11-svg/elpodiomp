/**
 * Pipeline automático: scrape → regenerate cache → commit → push
 * Ejecutar: node scripts/auto-update.js
 *
 * Hace todo en secuencia:
 * 1. Scrapea productos reales de Mercado Libre (Puppeteer + stealth)
 * 2. Extrae MLA IDs de imágenes para categorías bloqueadas (fallback)
 * 3. Scrapea productos del evento express activo (Día del Padre, etc.)
 * 4. Regenera cache.html con links reales
 * 5. Commitea y pushea solo si hubo cambios
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { sendAlert } = require('./notifier');

const ROOT = path.join(__dirname, '..');
const FIXTURE_PATH = path.join(ROOT, 'products-fixture.json');
const CACHE_PATH = path.join(ROOT, 'cache.html');

function log(msg) {
  const ts = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  console.log(`[${ts}] ${msg}`);
}

async function run(cmd, label, timeoutMs = 600000) {
  log(`▶ ${label}...`);
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs });
    log(`✅ ${label} completado.`);
    return true;
  } catch (err) {
    const errorMsg = `El comando falló:\n${cmd}\n\nError: ${err.message}`;
    log(`❌ ${label} falló: ${err.message}`);
    await sendAlert(`Fallo en Pipeline: ${label}`, errorMsg);
    return false;
  }
}

async function main() {
  log('══════ PIPELINE AUTO-UPDATE INICIADO ══════');

  const scrapeOk = await run('node scripts/scrape-real-products.js', '1/5 Scraping productos');

  // ── Paso 2: Extraer MLA IDs de imágenes (fallback) ──────────────
  log('2/5 Extrayendo MLA IDs de imágenes para links faltantes...');
  try {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
    let fixed = 0;
    Object.keys(fixture).forEach(cat => {
      fixture[cat].forEach(p => {
        if (p.link && /MLA-?\d{7,12}/.test(p.link)) return; // ya tiene link real
        const mlaMatch = (p.imageUrl || '').match(/MLA[_-]?(\d{7,12})/);
        if (mlaMatch) {
          const slugFn = (t) => (t || 'producto').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 80);
          p.link = 'https://www.mercadolibre.com.ar/MLA-' + mlaMatch[1] + '-' + slugFn(p.title) + '-_JM';
          fixed++;
        }
      });
    });
    fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2), 'utf8');
    log(`   ${fixed} links corregidos desde imágenes.`);
  } catch (err) {
    const errorMsg = `Error al procesar imágenes para fallback:\n${err.message}`;
    log(`   ⚠️  Fallback de imágenes: ${err.message}`);
    await sendAlert('Fallo en Pipeline: Fallback de Imágenes', errorMsg);
  }

  // ── Paso 3: Scraping evento express (Día del Padre, Navidad, etc.) ─
  const expressOk = await run('node scripts/scrape-express-event.js', '3/5 Scraping evento express');

  // ── Paso 4: Regenerar caché ─────────────────────────────────────
  const cacheOk = await run('node scripts/generate-cache.js', '4/5 Regenerando cache.html');

  // ── Paso 5: Commit y push si hay cambios ────────────────────────
  log('5/5 Verificando cambios para commit...');
  try {
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    if (status.trim()) {
      const changedFiles = status.trim().split('\n').map(l => l.trim()).filter(Boolean);
      log(`   Archivos modificados: ${changedFiles.length}`);
      changedFiles.forEach(f => console.log(`     - ${f}`));

      execSync('git add cache_*.html products-fixture.json contador.json express-offers.json', { cwd: ROOT });
      const commitMsg = `auto-update: productos actualizados (${new Date().toISOString().split('T')[0]})`;
      execSync(`git commit -m "${commitMsg}"`, { cwd: ROOT });
      log('   ✅ Commit realizado.');

      execSync('git push', { cwd: ROOT });
      log('   ✅ Push a origin/master completado.');
    } else {
      log('   Sin cambios. Nada para committear.');
    }
  } catch (err) {
    const errorMsg = `Fallo al empujar cambios a GitHub:\n${err.message}`;
    log(`❌ Git falló: ${err.message}`);
    await sendAlert('Fallo en Pipeline: Git Push', errorMsg);
  }

  log('══════ PIPELINE COMPLETADO ══════');
}

main().catch(async (err) => {
  log(`❌ Error crítico inesperado: ${err.message}`);
  try {
    await sendAlert('Fallo Crítico en Pipeline', `Ocurrió un error inesperado:\n${err.message}`);
  } catch (_) {}
  process.exit(1);
});

