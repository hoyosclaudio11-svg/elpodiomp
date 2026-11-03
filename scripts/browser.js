/**
 * Resuelve un navegador ya instalado en Windows para Puppeteer.
 * Evita depender de la descarga de Chrome en C:, que puede fallar por falta
 * de espacio (pasó el 3/11/2026: la carpeta quedó con archivos de 0 bytes).
 */
const fs = require('fs');

const CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

function findBrowser() {
  return CANDIDATES.find(candidate => candidate && fs.existsSync(candidate));
}

module.exports = { findBrowser };
