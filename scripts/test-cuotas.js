/**
 * Analiza estructura HTML de Mercado Libre para encontrar cuotas sin interés
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  // Buscar iPhones (gama alta con cuotas)
  await page.goto('https://listado.mercadolibre.com.ar/iphone-16-pro-max-256gb', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForSelector('.ui-search-layout__item, .poly-card, .andes-card', { timeout: 8000 });

  const cardsInfo = await page.evaluate(() => {
    const cards = document.querySelectorAll('.ui-search-layout__item, .poly-card, .andes-card');
    const info = [];
    for (let i = 0; i < Math.min(cards.length, 3); i++) {
      const el = cards[i];
      // Obtener el texto completo del card
      const text = el.innerText.substring(0, 600);
      // Buscar elementos con clases de cuotas/financiación
      const html = el.innerHTML.substring(0, 3000);
      info.push({ index: i + 1, text, html });
    }
    return info;
  });

  cardsInfo.forEach(c => {
    console.log(`\n========== CARD ${c.index} ==========`);
    console.log('TEXTO:', c.text);
    console.log('');
    // Buscar patrones de cuotas en el HTML
    const cuotasMatch = c.html.match(/<[^>]*class="[^"]*installment[^"]*"[^>]*>[^<]*<\/[^>]*>/gi);
    if (cuotasMatch) console.log('INSTALLMENT ELEMENTS:', cuotasMatch);
    const cuotasMatch2 = c.html.match(/<[^>]*class="[^"]*cuota[^"]*"[^>]*>[^<]*<\/[^>]*>/gi);
    if (cuotasMatch2) console.log('CUOTA ELEMENTS:', cuotasMatch2);
    // Buscar "sin interés" en el HTML
    const sinInteres = c.html.match(/[^>]*sin inter[^<]*/gi);
    if (sinInteres) console.log('SIN INTERES:', sinInteres.slice(0, 3));
    // Buscar clases con "free" o "shipping"
    const envio = c.html.match(/<[^>]*class="[^"]*(?:free|full|shipping)[^"]*"[^>]*>[^<]*<\/[^>]*>/gi);
    if (envio) console.log('ENVIO ELEMENTS:', envio.slice(0, 3));
  });

  await browser.close();
})();
