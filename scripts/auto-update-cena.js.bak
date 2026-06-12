/**
 * Pipeline automático de Ofertas de Cena
 * Ejecutar: node scripts/auto-update-cena.js
 *
 * Hace todo en secuencia:
 * 1. Scrapea ofertas de cena con delivery en CABA (Puppeteer + DeepSeek/Gemini)
 * 2. Regenera todos los cache_*.html (incluye la sección de cena)
 * 3. Commitea y pushea solo si hubo cambios
 *
 * Diseñado para ejecutarse a las 19:00 ART (antes de la cena)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { sendAlert } = require('./notifier');

const ROOT = path.join(__dirname, '..');

function log(msg) {
  const ts = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  console.log(`[${ts}] ${msg}`);
}

async function run(cmd, label) {
  log(`▶ ${label}...`);
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', timeout: 300000 });
    log(`✅ ${label} completado.`);
    return true;
  } catch (err) {
    const errorMsg = `El comando falló:\n${cmd}\n\nError: ${err.message}`;
    log(`❌ ${label} falló: ${err.message}`);
    try {
      await sendAlert(`Fallo en Pipeline Cena: ${label}`, errorMsg);
    } catch (_) {}
    return false;
  }
}

async function main() {
  log('🍔 ══════ PIPELINE CENA EXPRESS INICIADO ══════');

  // Paso 1: Scraping de ofertas de cena
  const scrapeOk = await run(
    'node scripts/scrape-cena-offers.js',
    '1/3 Scraping ofertas de cena delivery CABA'
  );

  if (!scrapeOk) {
    log('⚠️  El scraping falló, pero continuamos con los datos existentes.');
  }

  // Paso 2: Regenerar cachés
  const cacheOk = await run(
    'node scripts/generate-cache.js',
    '2/3 Regenerando cache_*.html'
  );

  if (!cacheOk) {
    log('❌ Falló la regeneración de caché. Abortando.');
    process.exit(1);
  }

  // Paso 3: Commit y push si hay cambios
  log('3/3 Verificando cambios para commit...');
  try {
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    if (status.trim()) {
      const changedFiles = status.trim().split('\n').map(l => l.trim()).filter(Boolean);
      log(`   Archivos modificados: ${changedFiles.length}`);
      changedFiles.forEach(f => console.log(`     - ${f}`));

      execSync('git add cache_*.html cena-offers.json cena-history.json contador.json', { cwd: ROOT });
      const today = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
      const commitMsg = `auto-update: ofertas de cena actualizadas (${today})`;
      execSync(`git commit -m "${commitMsg}"`, { cwd: ROOT });
      log('   ✅ Commit realizado.');

      execSync('git push', { cwd: ROOT });
      log('   ✅ Push a origin/master completado.');
      log('   🚀 Render desplegará automáticamente en ~1 minuto.');
    } else {
      log('   Sin cambios. Nada para committear.');
    }
  } catch (err) {
    const errorMsg = `Fallo al empujar cambios a GitHub:\n${err.message}`;
    log(`❌ Git falló: ${err.message}`);
    try {
      await sendAlert(`Fallo en Pipeline Cena: Git Push`, errorMsg);
    } catch (_) {}
  }

  log('🍔 ══════ PIPELINE CENA EXPRESS COMPLETADO ══════');
}

main().catch(async (err) => {
  log(`❌ Error crítico inesperado: ${err.message}`);
  try {
    await sendAlert('Fallo Crítico en Pipeline Cena', `Ocurrió un error inesperado:\n${err.message}`);
  } catch (_) {}
  process.exit(1);
});
