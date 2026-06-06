const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const CONFIG_PATH = path.join(__dirname, 'config.json');

function readConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  return { categories: [], affiliateLinks: {}, categoryFallbacks: {}, meliTokens: {} };
}

async function testApi() {
  console.log('🧪 Iniciando prueba de conexión con la API de Mercado Libre...');
  
  const config = readConfig();
  const tokens = config.meliTokens;
  
  if (!tokens || !tokens.access_token) {
    console.error('\n❌ Error: No se encontró ningún access_token en config.json.');
    console.log('Para iniciar sesión, primero corre el servidor (`npm start`), entra a http://localhost:3000/admin y haz clic en "Conectar con Mercado Libre".');
    console.log('Luego de autorizar tu cuenta, vuelve a correr este test.\n');
    process.exit(1);
  }

  const accessToken = tokens.access_token;
  console.log(`✓ Access Token encontrado: ...${accessToken.substring(accessToken.length - 15)}`);
  
  const query = 'zapatillas';
  console.log(`\n🔍 Realizando consulta de prueba para: "${query}"...`);
  
  try {
    const response = await axios.get('https://api.mercadolibre.com/sites/MLA/search', {
      params: {
        q: query,
        limit: 5
      },
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    const results = response.data.results || [];
    console.log(`✓ Éxito! Se obtuvieron ${results.length} resultados.`);
    
    if (results.length === 0) {
      console.log('⚠ Advertencia: La API no devolvió resultados para la búsqueda.');
      return;
    }
    
    console.log('\n--- Muestra de los primeros productos recibidos ---');
    results.forEach((item, index) => {
      const isInterestFree = item.installments && item.installments.rate === 0;
      const originalPrice = item.original_price;
      const discount = originalPrice && originalPrice > item.price
        ? Math.round(((originalPrice - item.price) / originalPrice) * 100)
        : 0;

      // Obtener imagen de alta calidad
      let imageUrl = item.thumbnail || '';
      if (imageUrl.endsWith('-I.jpg')) {
        imageUrl = imageUrl.replace('-I.jpg', '-O.jpg');
      }

      console.log(`\n[Producto #${index + 1}]`);
      console.log(`- ID: ${item.id}`);
      console.log(`- Título: ${item.title}`);
      console.log(`- Precio Actual: $${item.price.toLocaleString('es-AR')}`);
      if (originalPrice) {
        console.log(`- Precio Original: $${originalPrice.toLocaleString('es-AR')} (${discount}% OFF)`);
      }
      console.log(`- Cuotas sin interés: ${isInterestFree ? 'SÍ' : 'NO'}`);
      if (item.installments) {
        console.log(`- Detalle Cuotas: ${item.installments.quantity} cuotas de $${item.installments.amount.toLocaleString('es-AR')} (tasa: ${item.installments.rate})`);
      }
      console.log(`- Imagen Alta Res: ${imageUrl}`);
      console.log(`- Enlace Directo: ${item.permalink}`);
    });
    console.log('\n--------------------------------------------------');
    console.log('✓ La prueba de la API se completó con éxito. La integración funciona perfectamente.\n');
    
  } catch (err) {
    console.error('\n❌ Error al llamar a la API de Mercado Libre:', err.response?.data || err.message);
    if (err.response?.status === 401 || err.response?.status === 403) {
      console.log('\n💡 Consejo: Tu access_token podría estar expirado o ser inválido. Intenta reconectar tu cuenta desde el panel /admin.');
    }
    process.exit(1);
  }
}

testApi();
