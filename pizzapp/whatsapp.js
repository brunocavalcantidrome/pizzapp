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
function phoneDigits(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length > 11 && digits.startsWith('55')) digits = digits.slice(2);
  return digits;
}

function isValidBRPhone(phone) {
  const d = phoneDigits(phone);
  return d.length === 10 || d.length === 11;
}

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

const CUSTOMER_STATUS_TEXT = {
  pending: 'Analisando pedido',
  preparing: 'Em preparo',
  shipped: 'Saiu para entrega',
  delivered: 'Entregue',
  cancelled: 'Cancelado'
};

const CUSTOMER_STATUS_EMOJI = {
  pending: '🔍',
  preparing: '👨‍🍳',
  shipped: '🛵',
  delivered: '✅',
  cancelled: '❌'
};

function buildCustomerOrderMessage({ orderId, restaurantName, customerName, items, total, payment }) {
  const firstName = String(customerName || '').split(' ')[0] || 'cliente';
  const lines = [];
  lines.push(`🍕 *${restaurantName}*`);
  lines.push(`Olá, ${firstName}! Seu pedido *#${orderId}* foi recebido.`);
  lines.push(`🔍 *Status: analisando pedido* — o restaurante já foi avisado.`);
  lines.push('');
  lines.push(`🧾 *Resumo:*`);
  for (const it of items) {
    lines.push(`• ${it.quantity}x ${it.name} — ${formatMoney(it.subtotal)}`);
    for (const opt of it.selected_options || []) {
      lines.push(`   └ ${opt.option_name}`);
    }
  }
  lines.push('');
  lines.push(`💰 *Total: ${formatMoney(total)}* (${payment})`);
  lines.push('');
  lines.push(`Avisaremos aqui a cada atualização. Obrigado! 🙏`);
  return lines.join('\n');
}

function buildCustomerStatusMessage({ orderId, restaurantName, status, total }) {
  const label = CUSTOMER_STATUS_TEXT[status] || status;
  const emoji = CUSTOMER_STATUS_EMOJI[status] || '📦';
  const lines = [];
  lines.push(`🍕 *${restaurantName} — pedido #${orderId}*`);
  lines.push(`${emoji} *Status atualizado: ${label}*`);
  if (status === 'pending') lines.push(`O restaurante está analisando seu pedido.`);
  if (status === 'preparing') lines.push(`O restaurante já está preparando seu pedido.`);
  if (status === 'shipped') lines.push(`Seu pedido saiu para entrega. Fique atento!`);
  if (status === 'delivered') lines.push(`Pedido entregue. Bom apetite! 😋`);
  if (status === 'cancelled') lines.push(`Seu pedido foi cancelado. Fale com o restaurante em caso de dúvida.`);
  if (total !== undefined) lines.push(`💰 Total: ${formatMoney(total)}`);
  return lines.join('\n');
}

function maskDigits(digits) {
  const d = String(digits || '');
  if (d.length <= 6) return '****';
  return d.slice(0, 4) + '****' + d.slice(-2);
}

async function resolveChatId(digits) {
  // Resolve o endereço real da conta dentro da página: o WhatsApp migrou parte
  // das contas para LID e o envio para @c.us falha com "No LID for user".
  // (Usa evaluate próprio porque o objeto Wid perde o _serialized ao cruzar
  // a ponte do puppeteer; aqui retornamos a string pronta.)
  const fallback = `${digits}@c.us`;
  try {
    const serialized = await client.pupPage.evaluate(async (number) => {
      const wid = window.require('WAWebWidFactory').createWid(number);
      const result = await window.require('WAWebQueryExistsJob').queryWidExists(wid);
      if (!result || !result.wid) return null;
      return result.wid.toString();
    }, fallback);
    if (serialized) {
      console.log(`WhatsApp: ${maskDigits(digits)} resolvido como ${serialized.split('@')[1] === 'lid' ? maskDigits(serialized) : serialized}`);
      return serialized;
    }
    console.warn(`WhatsApp: ${maskDigits(digits)} não registrado, usando @c.us`);
  } catch (e) {
    console.warn(`WhatsApp: falha ao resolver ${maskDigits(digits)}, usando @c.us:`, e.message);
  }
  return fallback;
}

async function sendWhatsApp(to, message) {
  if (!client || !isReady) {
    throw new Error('WhatsApp não conectado. Conecte em /sistema/admin/whatsapp.');
  }
  const digits = normalizeBRPhone(to);
  if (!digits) throw new Error(`Número de WhatsApp inválido: "${to}"`);
  const chatId = await resolveChatId(digits);
  const sent = await client.sendMessage(chatId, message);
  console.log(`WhatsApp: mensagem enviada para ${maskDigits(digits)} (pedido via chat ${chatId.includes('@lid') ? 'LID' : '@c.us'})`);
  return sent;
}

async function sendOrderToRestaurant({ to, message }) {
  return sendWhatsApp(to, message);
}

async function sendCustomerMessage({ to, message }) {
  return sendWhatsApp(to, message);
}

module.exports = {
  initWhatsApp,
  getStatus,
  getLastQR,
  normalizeBRPhone,
  isValidBRPhone,
  buildOrderMessage,
  sendOrderToRestaurant,
  CUSTOMER_STATUS_TEXT,
  buildCustomerOrderMessage,
  buildCustomerStatusMessage,
  sendCustomerMessage
};
