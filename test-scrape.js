const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

async function testScrape() {
  const query = 'zapatillas';
  console.log(`🔍 Intentando raspar la web pública de Mercado Libre para: "${query}"...`);
  
  try {
    const url = `https://listado.mercadolibre.com.ar/${encodeURIComponent(query)}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8'
      }
    });
    
    const $ = cheerio.load(response.data);
    fs.writeFileSync('temp.html', response.data, 'utf8');
    console.log('✓ Guardado HTML en temp.html para inspeccionar.');
    const items = [];
    
    // Selectores comunes
    const selectors = [
      '.ui-search-layout__item',
      '.ui-search-result__wrapper',
      '.poly-card',
      '.ui-search-result'
    ];
    
    let foundElements = [];
    let activeSelector = '';
    for (const selector of selectors) {
      foundElements = $(selector);
      if (foundElements.length > 0) {
        activeSelector = selector;
        console.log(`✓ Encontrado selector: "${selector}" con ${foundElements.length} elementos.`);
        break;
      }
    }
    
    if (foundElements.length === 0) {
      console.log('❌ No se encontró ningún contenedor de producto en el HTML.');
      return;
    }
    
    foundElements.slice(0, 3).each((index, el) => {
      const element = $(el);
      
      // Intentar extraer título
      let title = element.find('.ui-search-item__title').text().trim() || 
                  element.find('.poly-component__title').text().trim() ||
                  element.find('.poly-component__title-link').text().trim() ||
                  element.find('h2').text().trim();
      
      // Intentar extraer enlace (permalink)
      let link = element.find('a.ui-search-link').attr('href') ||
                 element.find('a.poly-component__title-link').attr('href') ||
                 element.find('a').attr('href') ||
                 '';
                 
      // Intentar extraer imagen
      const img = element.find('img');
      let imageUrl = img.attr('data-src') || img.attr('src') || '';
      
      // Intentar extraer precio
      let priceText = element.find('.price-tag-fraction').first().text().trim() ||
                      element.find('.poly-price__current .price-tag-fraction').text().trim() ||
                      element.find('.price-tag-amount').first().text().trim();
                      
      let price = parseInt(priceText.replace(/\D/g, '')) || 0;
      
      // Intentar extraer precio original (anterior) si hay descuento
      let oldPriceText = element.find('.price-tag-line-through').text().trim() ||
                         element.find('.poly-price__old .price-tag-fraction').text().trim() ||
                         element.find('s').text().trim();
      let oldPrice = parseInt(oldPriceText.replace(/\D/g, '')) || null;
      
      // Intentar extraer cuotas
      let installments = element.find('.ui-search-installments').text().trim() ||
                         element.find('.poly-price__installments').text().trim() ||
                         '';
      
      // Si la URL de la imagen empieza con http://, la convertimos a https://
      if (imageUrl.startsWith('http://')) {
        imageUrl = imageUrl.replace('http://', 'https://');
      }
      
      items.push({
        index: index + 1,
        title,
        link,
        imageUrl,
        price,
        oldPrice,
        installments
      });
    });
    
    console.log('\n--- Productos extraídos ---');
    console.log(JSON.stringify(items, null, 2));
    
  } catch (err) {
    console.error('❌ Error raspando la página:', err.message);
  }
}

testScrape();
