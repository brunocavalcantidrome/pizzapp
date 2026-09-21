const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');

let client = null;
let isReady = false;
let lastQR = null;
let lastQRAt = null;
let connectedNumber = null;

function initWhatsApp(io) {
  if (client) return client;

  client = new Client({
    // Caminho absoluto: com PM2 o cwd pode variar, relativo quebraria a sessão
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  });

  client.on('qr', (qr) => {
    lastQR = qr;
    lastQRAt = new Date();
    isReady = false;
    console.log('📱 WhatsApp: escaneie o QR Code abaixo para conectar:');
    qrcodeTerminal.generate(qr, { small: true });
    if (io) io.emit('whatsapp-qr', { qr, at: lastQRAt });
  });

  client.on('ready', () => {
    isReady = true;
    lastQR = null;
    connectedNumber = client.info ? `${client.info.wid.user}` : null;
    console.log(`✅ WhatsApp conectado${connectedNumber ? `: +${connectedNumber}` : ''}`);
    if (io) io.emit('whatsapp-ready', { number: connectedNumber });
  });

  client.on('authenticated', () => {
    console.log('🔐 WhatsApp autenticado.');
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ Falha de autenticação WhatsApp:', msg);
  });

  client.on('disconnected', (reason) => {
    isReady = false;
    connectedNumber = null;
    console.warn('⚠️ WhatsApp desconectado:', reason);
    if (io) io.emit('whatsapp-disconnected', { reason });
  });

  client.initialize().catch((err) => {
    console.error('❌ Erro ao inicializar WhatsApp (pedidos seguem funcionando sem ele):', err.message);
  });

  return client;
}

function getStatus() {
  return {
    connected: isReady,
    number: connectedNumber,
    hasQR: !!lastQR,
    qrAt: lastQRAt
  };
}

function getLastQR() {
  return lastQR;
}

// Normaliza "5571987301606", "(71) 98730-1606" etc -> "5571987301606"
function normalizeBRPhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  // Se veio sem DDI (10 ou 11 dígitos), assume Brasil
  if (digits.length <= 11) digits = '55' + digits;
  return digits;
}

function formatMoney(v) {
  return 'R$ ' + Number(v).toFixed(2);
}

function buildOrderMessage({ orderId, restaurantName, customer, items, total }) {
  const lines = [];
  lines.push(`🍕 *Novo pedido #${orderId} - ${restaurantName}*`);
  lines.push('');
  lines.push(`👤 *Cliente:* ${customer.name}`);
  lines.push(`📞 *Telefone:* ${customer.phone}`);
  lines.push(`📍 *Endereço:* ${customer.address}`);
  lines.push(`💳 *Pagamento:* ${customer.payment}`);
  lines.push('');
  lines.push(`🧾 *Itens:*`);
  for (const it of items) {
    lines.push(`• ${it.quantity}x ${it.name} — ${formatMoney(it.subtotal)} (${formatMoney(it.unit_price)} un.)`);
    for (const opt of it.selected_options || []) {
      const extra = Number(opt.extra_price) > 0 ? ` (+${formatMoney(opt.extra_price)})` : '';
      lines.push(`   └ ${opt.group_name}: ${opt.option_name}${extra}`);
    }
  }
  lines.push('');
  lines.push(`💰 *Total: ${formatMoney(total)}*`);
  return lines.join('\n');
}

async function sendOrderToRestaurant({ to, message }) {
  if (!client || !isReady) {
    throw new Error('WhatsApp não conectado. Conecte escaneando o QR em /:slug/admin/whatsapp.');
  }
  const digits = normalizeBRPhone(to);
  if (!digits) throw new Error(`WhatsApp da loja inválido: "${to}"`);
  const chatId = `${digits}@c.us`;
  return client.sendMessage(chatId, message);
}

module.exports = {
  initWhatsApp,
  getStatus,
  getLastQR,
  normalizeBRPhone,
  buildOrderMessage,
  sendOrderToRestaurant
};
