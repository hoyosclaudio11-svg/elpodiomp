/**
 * Script para generar cache.html desde una PC local en Argentina.
 * Ejecutar: node scripts/generate-cache.js
 * Esto arranca el servidor localmente, genera la página completa
 * con productos de Mercado Libre (API o scraper), y guarda cache.html.
 * Luego commiteás y pusheás cache.html para actualizar el sitio en Render.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const CACHE_PATH = path.join(__dirname, '..', 'cache.html');

console.log('🚀 Iniciando servidor local para generar cache.html...\n');

// Renombrar temporalmente el cache viejo para que el servidor
// genere HTML fresco desde products-fixture.json (no desde cache.html)
const CACHE_OLD = CACHE_PATH + '.old';
if (fs.existsSync(CACHE_PATH)) {
  fs.renameSync(CACHE_PATH, CACHE_OLD);
  console.log('📦 Cache vieja respaldada temporalmente.');
}

// Arrancar el servidor como proceso hijo
const server = spawn('node', [SERVER_PATH], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: '3099' },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
server.stdout.on('data', d => { output += d.toString(); });
server.stderr.on('data', d => { output += d.toString(); });

// Esperar a que el servidor esté listo
setTimeout(() => {
  console.log('📡 Solicitando página al servidor local...');

  http.get('http://localhost:3099/', (res) => {
    let html = '';
    res.on('data', chunk => html += chunk);
    res.on('end', () => {
      // Contar productos
      const sections = (html.match(/section class="section"/g) || []).length;
      const cards = (html.match(/class="card"/g) || []).length;

      console.log(`✅ Página generada: ${sections} secciones, ${cards} productos.`);

      if (cards > 3) {
        fs.writeFileSync(CACHE_PATH, html, 'utf8');
        console.log(`💾 Guardado en ${CACHE_PATH}`);
        console.log('\n📋 Ahora hacé:');
        console.log('   git add cache.html');
        console.log('   git commit -m "actualizar productos"');
        console.log('   git push');
        console.log('\nY Render desplegará los productos nuevos en 1 minuto.');
      } else {
        console.log('⚠️  Solo se cargó la sección de comida. La API de Meli no respondió.');
        console.log('   Probá correr el script de nuevo más tarde.');
      }

      server.kill();
      // Limpiar backup
      if (fs.existsSync(CACHE_OLD)) fs.unlinkSync(CACHE_OLD);
      process.exit(0);
    });
  }).on('error', (err) => {
    console.error('❌ Error conectando al servidor:', err.message);
    console.log('\nLog del servidor:', output);
    server.kill();
    // Restaurar cache vieja
    if (fs.existsSync(CACHE_OLD)) {
      fs.renameSync(CACHE_OLD, CACHE_PATH);
      console.log('📦 Cache anterior restaurada.');
    }
    process.exit(1);
  });
}, 5000);
