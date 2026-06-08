const path = require('path');
// Cargar el archivo .env del proyecto central de forma absoluta para poder ser ejecutado desde cualquier directorio
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');

/**
 * Envía una alerta a través de los canales configurados en el archivo .env
 * @param {string} title Título o etiqueta de la alerta
 * @param {string} message Contenido detallado del error o mensaje
 * @param {object} options Opciones adicionales
 */
async function sendAlert(title, message, options = {}) {
  const channels = (process.env.NOTIFIER_CHANNELS || '')
    .split(',')
    .map(c => c.trim().toLowerCase())
    .filter(Boolean);

  if (channels.length === 0) {
    console.warn('⚠️ No hay canales de notificación configurados en NOTIFIER_CHANNELS. Alerta omitida.');
    console.log(`[ALERTA SIN ENVIAR] [${title}] ${message}`);
    return;
  }

  const promises = [];

  if (channels.includes('telegram')) {
    promises.push(sendTelegram(title, message, options));
  }

  if (channels.includes('discord')) {
    promises.push(sendDiscord(title, message, options));
  }

  if (channels.includes('ntfy')) {
    promises.push(sendNtfy(title, message, options));
  }

  const results = await Promise.allSettled(promises);
  
  results.forEach((res, i) => {
    if (res.status === 'rejected') {
      console.error(`❌ Error al enviar notificación en uno de los canales:`, res.reason.message || res.reason);
    }
  });
}

/**
 * Envía alerta por Telegram Bot
 */
async function sendTelegram(title, message, options) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error('Telegram no configurado. Faltan variables TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en .env');
  }

  const formattedText = `<b>🚨 ALERTA: ${escapeHtml(title)}</b>\n\n<code>${escapeHtml(message)}</code>\n\n📅 <i>${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}</i>`;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await axios.post(url, {
    chat_id: chatId,
    text: formattedText,
    parse_mode: 'HTML'
  });
}

/**
 * Envía alerta por Discord Webhook
 */
async function sendDiscord(title, message, options) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    throw new Error('Discord no configurado. Falta variable DISCORD_WEBHOOK_URL en .env');
  }

  await axios.post(url, {
    embeds: [
      {
        title: `🚨 ALERTA: ${title}`,
        description: `\`\`\`\n${message}\n\`\`\``,
        color: 15158332, // Rojo
        timestamp: new Date().toISOString()
      }
    ]
  });
}

/**
 * Envía alerta por ntfy.sh
 */
async function sendNtfy(title, message, options) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    throw new Error('ntfy.sh no configurado. Falta variable NTFY_TOPIC en .env');
  }

  await axios.post(`https://ntfy.sh/${topic}`, message, {
    headers: {
      'Title': title,
      'Tags': 'rotating_light,warning',
      'Priority': 'high'
    }
  });
}

// Función auxiliar para sanitizar strings para HTML de Telegram
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Permitir ejecución directa por consola (CLI)
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Uso: node notifier.js "Título de la Alerta" "Mensaje de la Alerta"');
    process.exit(0);
  }

  const title = args[0] || 'Alerta Manual';
  const message = args[1] || 'Sin mensaje especificado';

  sendAlert(title, message)
    .then(() => {
      console.log('✅ Notificación despachada.');
      process.exit(0);
    })
    .catch(err => {
      console.error('❌ Error de CLI:', err.message);
      process.exit(1);
    });
}

module.exports = { sendAlert };
