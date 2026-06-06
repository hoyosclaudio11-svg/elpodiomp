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
      process.exit(0);
    });
  }).on('error', (err) => {
    console.error('❌ Error conectando al servidor:', err.message);
    console.log('\nLog del servidor:', output);
    server.kill();
    process.exit(1);
  });
}, 5000);
