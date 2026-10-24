const path = require('path');
const fs = require('fs');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser } = require('@whiskeysockets/baileys');

let sock = null;
let isReady = false;
let lastQR = null;
let lastQRAt = null;
let connectedNumber = null;
let chatPool = null;
let reconnecting = false;
let qrTimer = null;

// "Ring token" PERMANENTE: o cliente pertence à loja do último pedido, sem expiração.
// Os 120 min valem só para o auto-reply (reapresentação), não para o pertencimento.
const AUTO_REPLY_COOLDOWN_MINUTES = 120;
// Tempo de vida da mensagem no banco (limpeza periódica no server.js).
const CHAT_TTL_DAYS = 90;

const AUTH_PATH = path.join(__dirname, '.baileys_auth');

function initWhatsApp(io) {
  if (sock) return sock;
  startSock(io);
  return sock;
}

async function startSock(io) {
  try {
    if (!fs.existsSync(AUTH_PATH)) {
      fs.mkdirSync(AUTH_PATH, { recursive: true });
    }
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Pizzapp', 'Chrome', '10.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        lastQR = qr;
        lastQRAt = new Date();
        isReady = false;
        console.log('📱 WhatsApp: escaneie o QR Code abaixo para conectar:');
        qrcodeTerminal.generate(qr, { small: true });
        if (io) io.emit('whatsapp-qr', { qr, at: lastQRAt });
      }

      if (connection === 'close') {
        isReady = false;
        connectedNumber = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.warn('⚠️ WhatsApp desconectado:', statusCode, shouldReconnect ? '(tentando reconectar)' : '(deslogado)');
        if (io) io.emit('whatsapp-disconnected', { reason: statusCode });
        sock = null;
        if (shouldReconnect && !reconnecting) {
          reconnecting = true;
          setTimeout(() => {
            reconnecting = false;
            startSock(io);
          }, 3000);
        }
      } else if (connection === 'open') {
        isReady = true;
        lastQR = null;
        const me = sock.user;
        connectedNumber = me ? me.id.split(':')[0].split('@')[0] : null;
        console.log(`✅ WhatsApp conectado${connectedNumber ? `: +${connectedNumber}` : ''}`);
        if (io) io.emit('whatsapp-ready', { number: connectedNumber });
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          await handleIncomingMessage(msg, io);
        } catch (err) {
          console.error('Erro ao processar mensagem recebida:', err.message);
        }
      }
    });

    // Baileys doesn't have message_ack in same form, but we can try to handle receipts if needed
    // For now, ack tracking may be limited; core functionality preserved
  } catch (err) {
    console.error('❌ Erro ao inicializar WhatsApp (pedidos seguem funcionando sem ele):', err.message);
    setTimeout(() => startSock(io), 5000);
  }
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

// Pool do banco para o bate-papo (definido pelo server.js após criar o pool).
function setChatPool(pool) {
  chatPool = pool;
}

function getConnectedNumber() {
  return connectedNumber;
}

// "Ring token": loja do pedido mais recente do telefone (sem expiração).
// Retorna { id, slug, name } ou null (nunca pediu -> só o sistema vê).
async function getTokenRestaurant(pool, digits) {
  if (!pool || !digits) return null;
  const [rows] = await pool.query(
    `SELECT c.restaurant_id AS id, r.slug, r.name
     FROM customers c JOIN restaurants r ON r.id = c.restaurant_id
     WHERE c.phone = ?
     ORDER BY c.last_order_at DESC LIMIT 1`,
    [digits]
  );
  return rows[0] || null;
}

function mediaLabel(type) {
  const map = {
    image: 'foto', video: 'vídeo', audio: 'áudio', ptt: 'áudio',
    document: 'arquivo', sticker: 'figurinha', location: 'localização',
    vcard: 'contato', call_log: 'chamada'
  };
  return map[type] || 'mídia';
}

function getMessageContent(msg) {
  const m = msg.message;
  if (!m) return null;
  if (m.conversation) return { type: 'chat', body: m.conversation };
  if (m.extendedTextMessage?.text) return { type: 'chat', body: m.extendedTextMessage.text };
  if (m.imageMessage) return { type: 'image' };
  if (m.videoMessage) return { type: 'video' };
  if (m.audioMessage) return { type: m.audioMessage.ptt ? 'ptt' : 'audio' };
  if (m.documentMessage) return { type: 'document' };
  if (m.stickerMessage) return { type: 'sticker' };
  if (m.locationMessage) return { type: 'location' };
  if (m.contactMessage || m.contactsArrayMessage) return { type: 'vcard' };
  return { type: 'unknown' };
}

async function handleIncomingMessage(msg, io) {
  if (!msg || msg.key?.fromMe) return;
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid) return;
  if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast')) return;

  const digits = await resolveSenderPhoneBaileys(msg);
  if (!digits) return;

  const content = getMessageContent(msg);
  const body = (content && content.type === 'chat' && content.body)
    ? String(content.body).slice(0, 4000)
    : `[${mediaLabel(content ? content.type : 'unknown')}]`;
  const waId = msg.key?.id || null;
  const ts = msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000);

  if (chatPool) {
    try {
      await chatPool.query(
        `INSERT IGNORE INTO whatsapp_messages
         (direction, from_phone, to_phone, body, wa_message_id, created_at, expires_at)
         VALUES ('in', ?, ?, ?, ?, FROM_UNIXTIME(?), DATE_ADD(FROM_UNIXTIME(?), INTERVAL ? DAY))`,
        [digits, connectedNumber, body, waId, ts, ts, CHAT_TTL_DAYS]
      );
    } catch (e) {
      console.error('Erro ao salvar mensagem recebida:', e.message);
    }
  }

  let token = null;
  try {
    token = await getTokenRestaurant(chatPool, digits);
  } catch (e) {
    console.error('Erro ao resolver loja da mensagem:', e.message);
  }

  const payload = {
    direction: 'in',
    phone: digits,
    body,
    created_at: new Date(ts * 1000),
    store: token ? { id: token.id, slug: token.slug, name: token.name } : null
  };
  if (io) {
    if (token) io.to(token.slug).emit('whatsapp-message', payload);
    io.emit('whatsapp-message-sys', payload);
  }

  if (token) {
    try {
      await maybeSendAutoReply({ digits, token, io });
    } catch (e) {
      console.error('Erro no auto-reply:', e.message);
    }
  }
}

async function maybeSendAutoReply({ digits, token, io }) {
  if (!sock || !isReady || !chatPool) return;
  const [rows] = await chatPool.query(
    'SELECT last_sent_at FROM wa_auto_replies WHERE phone = ? AND restaurant_id = ?',
    [digits, token.id]
  );
  const prev = rows[0] ? new Date(rows[0].last_sent_at) : null;
  if (prev && Date.now() - prev.getTime() < AUTO_REPLY_COOLDOWN_MINUTES * 60 * 1000) return;

  if (rows[0]) {
    await chatPool.query(
      'UPDATE wa_auto_replies SET last_sent_at = NOW() WHERE phone = ? AND restaurant_id = ?',
      [digits, token.id]
    );
  } else {
    await chatPool.query(
      'INSERT IGNORE INTO wa_auto_replies (phone, restaurant_id, last_sent_at) VALUES (?, ?, NOW())',
      [digits, token.id]
    );
  }

  const text = `O estabelecimento *${token.name}* recebeu sua mensagem e irá responder assim que possível.`;
  try {
    const jid = await resolveJid(digits);
    const sent = await sock.sendMessage(jid, { text });
    const waId = sent?.key?.id || null;
    await chatPool.query(
      `INSERT INTO whatsapp_messages
       (direction, restaurant_id, from_phone, to_phone, body, wa_message_id, created_at, expires_at)
       VALUES ('out', ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))`,
      [token.id, connectedNumber, digits, text, waId, CHAT_TTL_DAYS]
    );
  } catch (e) {
    try {
      if (prev) {
        await chatPool.query(
          'UPDATE wa_auto_replies SET last_sent_at = ? WHERE phone = ? AND restaurant_id = ?',
          [prev, digits, token.id]
        );
      } else {
        await chatPool.query(
          'DELETE FROM wa_auto_replies WHERE phone = ? AND restaurant_id = ?',
          [digits, token.id]
        );
      }
    } catch (rbErr) {
      console.error('Erro ao devolver carimbo do auto-reply:', rbErr.message);
    }
    throw e;
  }

  const payload = {
    direction: 'out',
    phone: digits,
    body: text,
    created_at: new Date(),
    store: { id: token.id, slug: token.slug, name: token.name }
  };
  if (io) {
    io.to(token.slug).emit('whatsapp-message', payload);
    io.emit('whatsapp-message-sys', payload);
  }
}

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

async function resolveJid(digits) {
  const num = normalizeBRPhone(digits);
  if (!num) throw new Error(`Número de WhatsApp inválido: "${digits}"`);
  try {
    if (sock?.onWhatsApp) {
      const [res] = await sock.onWhatsApp(num);
      if (res?.exists && res.jid) {
        // Aprender LID se vier como tal? Baileys pode retornar jid
        if (res.jid.endsWith('@lid') && chatPool) {
          saveLidMap(res.jid, num).catch(() => {});
        }
        return res.jid;
      }
    }
  } catch (e) {
    console.warn(`WhatsApp: falha ao resolver ${maskDigits(num)}, usando @s.whatsapp.net:`, e.message);
  }
  return num + '@s.whatsapp.net';
}

async function saveLidMap(lid, digits) {
  if (!chatPool || !lid || !digits) return;
  try {
    await chatPool.query(
      'INSERT INTO wa_lid_map (lid, phone) VALUES (?, ?) ON DUPLICATE KEY UPDATE phone = VALUES(phone)',
      [lid, digits]
    );
  } catch (e) {}
}

async function resolveSenderPhoneBaileys(msg) {
  const remoteJid = msg.key?.remoteJid || '';
  if (remoteJid.endsWith('@lid') && chatPool) {
    try {
      const [rows] = await chatPool.query('SELECT phone FROM wa_lid_map WHERE lid = ?', [remoteJid]);
      if (rows[0] && rows[0].phone) return normalizeBRPhone(rows[0].phone);
    } catch (e) {
      console.error('Erro ao consultar mapa LID:', e.message);
    }
  }
  if (remoteJid.endsWith('@s.whatsapp.net')) {
    const num = remoteJid.split('@')[0];
    return normalizeBRPhone(num);
  }
  // Fallback: tentar extrair número
  const num = remoteJid.split('@')[0];
  if (/^\d+$/.test(num)) return normalizeBRPhone(num);
  return null;
}

async function sendWhatsApp(to, message) {
  if (!sock || !isReady) {
    throw new Error('WhatsApp não conectado. Conecte em /sistema/admin/whatsapp.');
  }
  const digits = normalizeBRPhone(to);
  if (!digits) throw new Error(`Número de WhatsApp inválido: "${to}"`);
  const jid = await resolveJid(digits);
  const sent = await sock.sendMessage(jid, { text: message });
  console.log(`WhatsApp: mensagem enviada para ${maskDigits(digits)} (pedido via chat ${jid.includes('@lid') ? 'LID' : '@s.whatsapp.net'})`);
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
  sendCustomerMessage,
  setChatPool,
  getConnectedNumber,
  getTokenRestaurant,
  AUTO_REPLY_COOLDOWN_MINUTES,
  CHAT_TTL_DAYS
};
