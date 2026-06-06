const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const FOOD_PATH = path.join(__dirname, '..', 'food.json');

// Obtener el texto del menú desde la línea de comandos
const menuText = process.argv.slice(2).join(' ');

if (!menuText) {
  console.error('\n❌ Error: Por favor ingresa el texto descriptivo del local de comida.');
  console.log('\nEjemplo de uso:');
  console.log('  npm run add-food "McDonalds - Combo Cuarto de Libra: carne, queso cheddar, cebolla. Precio $8500. Link a PedidosYa: https://pedidosya.com/..."\n');
  process.exit(1);
}

// Verificar la API Key de Gemini
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('\n❌ Error: La variable GEMINI_API_KEY no está definida en el archivo .env.');
  console.log('Por favor, edita tu archivo .env e ingresa tu API Key de Gemini para poder usar la IA.\n');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

async function run() {
  console.log('🤖 Procesando texto del menú con Inteligencia Artificial (Gemini)...');
  
  const systemPrompt = `
    Eres un asistente experto en extracción de datos. Tu tarea es analizar el texto que describe un menú, plato de comida, local de delivery o comida rápida y devolver un objeto JSON estructurado con la información extraída.

    El formato JSON de salida debe ser exactamente el siguiente:
    {
      "restaurant": "Nombre del restaurante o local (ej: McDonald's, Kentucky, Pizzería Don Luis)",
      "product": "Nombre específico del plato, hamburguesa o combo (ej: Combo Doble Bacon)",
      "description": "Una descripción muy breve y tentadora (máximo 2 líneas, ej: Doble carne con queso cheddar derretido y panceta crujiente en pan de papa)",
      "price": 8500, (número entero que representa el precio en pesos argentinos),
      "oldPrice": 10000, (número entero que representa el precio anterior si hay descuento, o null si no se menciona),
      "installments": "Tipo de entrega o frase de envío (ej: 'Envío rápido por Delivery', 'Delivery Gratis en la zona', o 'Retiro por local')",
      "imageUrl": "Un enlace de imagen de Unsplash de alta calidad relevante para el tipo de comida (ej: si es hamburguesa usa una foto de hamburguesa de unsplash, si es pizza usa una de pizza, etc.). Formato: https://images.unsplash.com/photo-...",
      "link": "Enlace del local a PedidosYa, Rappi, su web o WhatsApp (si se menciona en el texto, de lo contrario colocar 'https://pedidosya.com.ar')"
    }

    Reglas:
    - Retorna ÚNICAMENTE el código JSON. No incluyas explicaciones ni bloques de código markdown (\`\`\`json).
    - Asegúrate de que las propiedades del JSON coincidan exactamente con el formato solicitado.
    - Si no se encuentra un campo (como oldPrice), ponle null o usa un valor lógico por defecto como se indica.
  `;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent({
      contents: [
        { role: 'user', parts: [{ text: `${systemPrompt}\n\nTexto a analizar:\n"${menuText}"` }] }
      ],
      generationConfig: {
        responseMimeType: 'application/json'
      }
    });

    const responseText = result.response.text().trim();
    const parsedData = JSON.parse(responseText);

    // Agregar campos automáticos de rating y reviews para que coincida con el diseño visual
    parsedData.id = `food_${Date.now()}`;
    parsedData.rating = parseFloat((4.5 + Math.random() * 0.4).toFixed(1)); // Rating aleatorio entre 4.5 y 4.9
    parsedData.reviews = Math.floor(120 + Math.random() * 800); // Reviews entre 120 y 920

    // Si la imagen está vacía, asignar una por defecto de hamburguesa premium de Unsplash
    if (!parsedData.imageUrl) {
      parsedData.imageUrl = 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&h=600&fit=crop';
    }

    // Cargar comidas existentes
    let foods = [];
    if (fs.existsSync(FOOD_PATH)) {
      try {
        foods = JSON.parse(fs.readFileSync(FOOD_PATH, 'utf8'));
      } catch (e) {
        foods = [];
      }
    }

    // Agregar el nuevo producto
    foods.push(parsedData);

    // Escribir en el archivo
    fs.writeFileSync(FOOD_PATH, JSON.stringify(foods, null, 2), 'utf8');

    console.log('\n✅ ¡Producto de comida agregado exitosamente!');
    console.log('--------------------------------------------------');
    console.log(`📍 Local:      ${parsedData.restaurant}`);
    console.log(`🍔 Producto:   ${parsedData.product}`);
    console.log(`📝 Detalle:    ${parsedData.description}`);
    console.log(`💵 Precio:     $${parsedData.price} ${parsedData.oldPrice ? `(Antes: $${parsedData.oldPrice})` : ''}`);
    console.log(`⭐ Valoración: ${parsedData.rating} (${parsedData.reviews} reviews)`);
    console.log(`🔗 Enlace:     ${parsedData.link}`);
    console.log('--------------------------------------------------');
    console.log('La próxima vez que cargues la página web, verás este local al final en la sección de Comidas.\n');

  } catch (err) {
    console.error('\n❌ Error al procesar con la IA o guardar el archivo:', err.message);
    process.exit(1);
  }
}

run();
