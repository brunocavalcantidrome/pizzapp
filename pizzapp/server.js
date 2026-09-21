require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const {
  initWhatsApp,
  getStatus: getWhatsAppStatus,
  getLastQR,
  buildOrderMessage,
  sendOrderToRestaurant
} = require('./whatsapp');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const server = http.createServer(app);
const io = new Server(server);

// Cada painel de pedidos entra numa "sala" com o slug do estabelecimento,
// assim eventos de um restaurante nao vazam para o painel de outro.
io.on('connection', (socket) => {
  socket.on('join', (slug) => {
    if (typeof slug === 'string' && slug) {
      socket.join(slug);
    }
  });
});

// WhatsApp: conecta uma única conta e usa o número de cada loja como destino.
// Se falhar (ex: sem Chrome), o servidor segue funcionando sem notificação via WhatsApp.
initWhatsApp(io);

const PORT = process.env.PORT || 3000;

// Fábrica de middlewares de autenticação básica (um para o painel do lojista, outro para o admin do sistema)
function basicAuth(userEnvVar, passEnvVar, realm) {
  return function (req, res, next) {
    const user = process.env[userEnvVar];
    const pass = process.env[passEnvVar];

    const header = req.headers.authorization;
    if (header) {
      const [, encoded] = header.split(' ');
      const [reqUser, reqPass] = Buffer.from(encoded || '', 'base64').toString().split(':');
      if (reqUser === user && reqPass === pass) {
        return next();
      }
    }

    res.set('WWW-Authenticate', `Basic realm="${realm}"`);
    return res.status(401).send('Autenticação necessária.');
  };
}

// Autentica o lojista (painel por estabelecimento)
const adminAuth = basicAuth('ADMIN_USER', 'ADMIN_PASSWORD', 'Painel Administrativo');

// Autentica o admin do sistema (gerencia todos os estabelecimentos)
const sysAdminAuth = basicAuth('SYSADMIN_USER', 'SYSADMIN_PASSWORD', 'Administração do Sistema');

// Sons de notificação disponíveis para o painel de pedidos (gerados via Web Audio API no navegador)
const NOTIFICATION_SOUNDS = [
  'sino-duplo',
  'ding-dong',
  'sininho-loja',
  'alerta',
  'recepcao',
  'tijolao',
  'pizzatime'
];

// Configuração do Connection Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Middleware Multi-tenant: Identifica a loja pela URL (:slug)
async function tenantMiddleware(req, res, next) {
  const { slug } = req.params;

  try {
    const [rows] = await pool.query(
      'SELECT id, name, slug, whatsapp, is_active, notification_sound FROM restaurants WHERE slug = ?',
      [slug]
    );

    if (rows.length === 0 || !rows[0].is_active) {
      return res.status(404).json({ error: 'Estabelecimento não encontrado ou inativo.' });
    }

    // Injeta os dados da loja no objeto 'req' para as próximas funções
    req.restaurant = rows[0];
    next();
  } catch (err) {
    console.error('Erro no middleware tenant:', err);
    res.status(500).json({ error: 'Erro interno ao identificar estabelecimento.' });
  }
}

// Rota pública para buscar dados da loja e seu cardápio
// Inclui flag is_customizable + grupos/opções dos montáveis para o builder do cliente
async function loadBuilderMap(restaurantId, onlyAvailable = true) {
  const [groups] = await pool.query(
    'SELECT id, product_id, name, description, min_required, max_allowed, sort_order FROM option_groups WHERE restaurant_id = ? ORDER BY product_id, sort_order, id',
    [restaurantId]
  );
  if (groups.length === 0) return new Map();
  const groupIds = groups.map((g) => g.id);
  const availFilter = onlyAvailable ? 'AND is_available = TRUE' : '';
  const [options] = await pool.query(
    `SELECT id, group_id, name, extra_price, is_available, sort_order FROM group_options WHERE group_id IN (?) ${availFilter} ORDER BY sort_order, id`,
    [groupIds]
  );
  const optionsByGroup = new Map();
  for (const o of options) {
    if (!optionsByGroup.has(o.group_id)) optionsByGroup.set(o.group_id, []);
    optionsByGroup.get(o.group_id).push(o);
  }
  const map = new Map();
  for (const g of groups) {
    const opts = optionsByGroup.get(g.id) || [];
    if (onlyAvailable && opts.length === 0) continue;
    if (!map.has(g.product_id)) map.set(g.product_id, []);
    map.get(g.product_id).push({ ...g, options: opts });
  }
  return map;
}

app.get('/api/menu/:slug', tenantMiddleware, async (req, res) => {
  try {
    const restaurantId = req.restaurant.id;

    const [products] = await pool.query(
      'SELECT id, name, description, price, is_customizable FROM products WHERE restaurant_id = ? AND is_available = TRUE',
      [restaurantId]
    );

    const builderMap = await loadBuilderMap(restaurantId, true);
    const productsWithBuilder = products.map((p) => ({
      ...p,
      groups: p.is_customizable ? (builderMap.get(p.id) || []) : []
    }));

    res.json({
      restaurant: req.restaurant,
      products: productsWithBuilder
    });
  } catch (err) {
    console.error('Erro ao buscar produtos:', err);
    res.status(500).json({ error: 'Erro ao carregar cardápio.' });
  }
});

// Rota (admin) para listar todos os produtos, incluindo indisponíveis
app.get('/api/products/:slug', adminAuth, tenantMiddleware, async (req, res) => {
  try {
    const [products] = await pool.query(
      'SELECT id, name, description, price, is_available, is_customizable FROM products WHERE restaurant_id = ? ORDER BY name',
      [req.restaurant.id]
    );
    res.json({ restaurant: req.restaurant.name, products });
  } catch (err) {
    console.error('Erro ao listar produtos:', err);
    res.status(500).json({ error: 'Erro ao carregar produtos.' });
  }
});

// Rota (admin) para criar um novo produto
app.post('/api/products/:slug', adminAuth, tenantMiddleware, async (req, res) => {
  try {
    const { name, description, price, is_customizable } = req.body;

    if (!name || price === undefined || price === null || isNaN(Number(price))) {
      return res.status(400).json({ error: 'Nome e preço válido são obrigatórios.' });
    }

    const [result] = await pool.query(
      'INSERT INTO products (restaurant_id, name, description, price, is_available, is_customizable) VALUES (?, ?, ?, ?, TRUE, ?)',
      [req.restaurant.id, name, description || null, Number(price), is_customizable ? 1 : 0]
    );

    res.status(201).json({ message: 'Produto criado com sucesso!', product_id: result.insertId });
  } catch (err) {
    console.error('Erro ao criar produto:', err);
    res.status(500).json({ error: 'Erro ao criar produto.' });
  }
});

// Rota (admin) para atualizar um produto (nome, descrição, preço, disponibilidade)
app.put('/api/products/:slug/:productId', adminAuth, tenantMiddleware, async (req, res) => {
  try {
    const { productId } = req.params;
    const { name, description, price, is_available, is_customizable } = req.body;

    const fields = [];
    const values = [];

    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description); }
    if (price !== undefined) { fields.push('price = ?'); values.push(Number(price)); }
    if (is_available !== undefined) { fields.push('is_available = ?'); values.push(Boolean(is_available)); }
    if (is_customizable !== undefined) { fields.push('is_customizable = ?'); values.push(is_customizable ? 1 : 0); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar foi informado.' });
    }

    values.push(productId, req.restaurant.id);

    const [result] = await pool.query(
      `UPDATE products SET ${fields.join(', ')} WHERE id = ? AND restaurant_id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Produto não encontrado neste estabelecimento.' });
    }

    res.json({ message: 'Produto atualizado com sucesso!' });
  } catch (err) {
    console.error('Erro ao atualizar produto:', err);
    res.status(500).json({ error: 'Erro ao atualizar produto.' });
  }
});

// Rota (admin) para excluir um produto
app.delete('/api/products/:slug/:productId', adminAuth, tenantMiddleware, async (req, res) => {
  try {
    const { productId } = req.params;

    const [result] = await pool.query(
      'DELETE FROM products WHERE id = ? AND restaurant_id = ?',
      [productId, req.restaurant.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Produto não encontrado neste estabelecimento.' });
    }

    res.json({ message: 'Produto excluído com sucesso!' });
  } catch (err) {
    console.error('Erro ao excluir produto:', err);
    res.status(500).json({ error: 'Erro ao excluir produto. Verifique se ele não está associado a pedidos existentes.' });
  }
});

// Rota (admin) para excluir um produto
app.delete('/api/products/:slug/:productId', adminAuth, tenantMiddleware, async (req, res) => {
  try {
    const { productId } = req.params;

    const [result] = await pool.query(
      'DELETE FROM products WHERE id = ? AND restaurant_id = ?',
      [productId, req.restaurant.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Produto não encontrado neste estabelecimento.' });
    }

    res.json({ message: 'Produto excluído com sucesso!' });
  } catch (err) {
    console.error('Erro ao excluir produto:', err);
    res.status(500).json({ error: 'Erro ao excluir produto. Verifique se ele não está associado a pedidos existentes.' });
  }
});

// ===== Produtos montáveis: grupos e opções (genérico p/ macarrão, pizza, açaí, etc) =====

// Pública: busca grupos + opções disponíveis de um produto montável (para o modal "Montar")
app.get('/api/builder/:slug/:productId', tenantMiddleware, async (req, res) => {
  try {
    const [prodRows] = await pool.query(
      'SELECT id, name, description, price, is_customizable FROM products WHERE id = ? AND restaurant_id = ? AND is_available = TRUE',
      [req.params.productId, req.restaurant.id]
    );
    if (prodRows.length === 0) {
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }
    const product = prodRows[0];
    if (!product.is_customizable) {
      return res.json({ product, groups: [] });
    }
    const builderMap = await loadBuilderMap(req.restaurant.id, true);
    res.json({ product, groups: builderMap.get(product.id) || [] });
  } catch (err) {
    console.error('Erro ao carregar montador:', err);
    res.status(500).json({ error: 'Erro ao carregar opções do produto.' });
  }
});

// Admin: listar grupos + opções (inclui indisponíveis) de um produto
app.get('/api/builder/:slug/:productId/admin', adminAuth, tenantMiddleware, async (req, res) => {
  try {
    const builderMap = await loadBuilderMap(req.restaurant.id, false);
    res.json({ groups: builderMap.get(Number(req.params.productId)) || [] });
  } catch (err) {
    console.error('Erro ao listar grupos:', err);
    res.status(500).json({ error: 'Erro ao listar grupos.' });
  }
});

// Admin: criar grupo (ex: Massa min1/max1, Extras min0/max3)
app.post('/api/builder/:slug/groups', adminAuth, tenantMiddleware, async (req, res) => {
  try {
    const { product_id, name, description, min_required, max_allowed, sort_order } = req.body;
    if (!product_id || !name || max_allowed === undefined) {
      return res.status(400).json({ error: 'product_id, name e max_allowed são obrigatórios.' });
    }
    const min = Number(min_required || 0);
    const max = Number(max_allowed);
    if (isNaN(min) || isNaN(max) || min < 0 || max < 1 || min > max) {
      return res.status(400).json({ error: 'Limites inválidos: use 0 <= min <= max, max >= 1.' });
    }
    const [prodRows] = await pool.query(
      'SELECT id FROM products WHERE id = ? AND restaurant_id = ?',
      [product_id, req.restaurant.id]
    );
    if (prodRows.length === 0) {
      return res.status(404).json({ error: 'Produto não encontrado neste estabelecimento.' });
    }
    const [result] = await pool.query(
      'INSERT INTO option_groups (restaurant_id, product_id, name, description, min_required, max_allowed, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.restaurant.id, product_id, name, description || null, min, max, Number(sort_order || 0)]
    );
    await pool.query('UPDATE products SET is_customizable = TRUE WHERE id = ?', [product_id]);
    res.status(201).json({ message: 'Grupo criado!', group_id: result.insertId });
  } catch (err) {
    console.error('Erro ao criar grupo:', err);
    res.status(500).json({ error: 'Erro ao criar grupo.' });
  }
});

// Admin: atualizar grupo
app.put('/api/builder/:slug/groups/:groupId', adminAuth, tenantMiddleware, async (req, res) => {
  try {
    const { name, description, min_required, max_allowed, sort_order } = req.body;
    const [gRows] = await pool.query(
      'SELECT id, min_required, max_allowed FROM option_groups WHERE id = ? AND restaurant_id = ?',
      [req.params.groupId, req.restaurant.id]
    );
    if (gRows.length === 0) return res.status(404).json({ error: 'Grupo não encontrado.' });
    const min = min_required !== undefined ? Number(min_required) : gRows[0].min_required;
    const max = max_allowed !== undefined ? Number(max_allowed) : gRows[0].max_allowed;
    if (isNaN(min) || isNaN(max) || min < 0 || max < 1 || min > max) {
      return res.status(400).json({ error: 'Limites inválidos: use 0 <= min <= max, max >= 1.' });
    }
    const fields = [];
    const values = [];
    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description); }
    if (min_required !== undefined) { fields.push('min_required = ?'); values.push(min); }
    if (max_allowed !== undefined) { fields.push('max_allowed = ?'); values.push(max); }
    if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(Number(sort_order)); }
    if (fields.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar.' });
    values.push(req.params.groupId, req.restaurant.id);
    await pool.query(`UPDATE option_groups SET ${fields.join(', ')} WHERE id = ? AND restaurant_id = ?`, values);
    res.json({ message: 'Grupo atualizado!' });
  } catch (err) {
    console.error('Erro ao atualizar grupo:', err);
    res.status(500).json({ error: 'Erro ao atualizar grupo.' });
  }
});

// Admin: excluir grupo
app.delete('/api/builder/:slug/groups/:groupId', adminAuth, tenantMiddleware, async (req, res) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM option_groups WHERE id = ? AND restaurant_id = ?',
      [req.params.groupId, req.restaurant.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Grupo não encontrado.' });
    res.json({ message: 'Grupo excluído!' });
  } catch (err) {
    console.error('Erro ao excluir grupo:', err);
    res.status(500).json({ error: 'Erro ao excluir grupo.' });
  }
});

// Admin: criar opção (ex: Fetuccine +0, Bacon +5)
app.post('/api/builder/:slug/groups/:groupId/options', adminAuth, tenantMiddleware, async (req, res) => {
  try {
    const { name, extra_price, sort_order } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome da opção é obrigatório.' });
    const price = Number(extra_price || 0);
    if (isNaN(price) || price < 0) return res.status(400).json({ error: 'extra_price inválido.' });
    const [gRows] = await pool.query(
      'SELECT id FROM option_groups WHERE id = ? AND restaurant_id = ?',
      [req.params.groupId, req.restaurant.id]
    );
    if (gRows.length === 0) return res.status(404).json({ error: 'Grupo não encontrado.' });
    const [result] = await pool.query(
      'INSERT INTO group_options (group_id, name, extra_price, is_available, sort_order) VALUES (?, ?, ?, TRUE, ?)',
      [req.params.groupId, name, price, Number(sort_order || 0)]
    );
    res.status(201).json({ message: 'Opção criada!', option_id: result.insertId });
  } catch (err) {
    console.error('Erro ao criar opção:', err);
    res.status(500).json({ error: 'Erro ao criar opção.' });
  }
});

// Admin: atualizar opção
app.put('/api/builder/:slug/options/:optionId', adminAuth, tenantMiddleware, async (req, res) => {
  try {
    const { name, extra_price, is_available, sort_order } = req.body;
    const [oRows] = await pool.query(
      `SELECT go.id FROM group_options go JOIN option_groups g ON g.id = go.group_id
       WHERE go.id = ? AND g.restaurant_id = ?`,
      [req.params.optionId, req.restaurant.id]
    );
    if (oRows.length === 0) return res.status(404).json({ error: 'Opção não encontrada.' });
    const fields = [];
    const values = [];
    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (extra_price !== undefined) {
      const p = Number(extra_price);
      if (isNaN(p) || p < 0) return res.status(400).json({ error: 'extra_price inválido.' });
      fields.push('extra_price = ?'); values.push(p);
    }
    if (is_available !== undefined) { fields.push('is_available = ?'); values.push(Boolean(is_available)); }
    if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(Number(sort_order)); }
    if (fields.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar.' });
    values.push(req.params.optionId);
    await pool.query(`UPDATE group_options SET ${fields.join(', ')} WHERE id = ?`, values);
    res.json({ message: 'Opção atualizada!' });
  } catch (err) {
    console.error('Erro ao atualizar opção:', err);
    res.status(500).json({ error: 'Erro ao atualizar opção.' });
  }
});

// Admin: excluir opção
app.delete('/api/builder/:slug/options/:optionId', adminAuth, tenantMiddleware, async (req, res) => {
  try {
    const [result] = await pool.query(
      `DELETE go FROM group_options go JOIN option_groups g ON g.id = go.group_id
       WHERE go.id = ? AND g.restaurant_id = ?`,
      [req.params.optionId, req.restaurant.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Opção não encontrada.' });
    res.json({ message: 'Opção excluída!' });
  } catch (err) {
    console.error('Erro ao excluir opção:', err);
    res.status(500).json({ error: 'Erro ao excluir opção.' });
  }
});

// ===== Admin do Sistema: gerencia todos os estabelecimentos (multi-tenant) =====

// Rota (sistema) para listar todos os estabelecimentos
app.get('/api/sistema/restaurants', sysAdminAuth, async (req, res) => {
  try {
    const [restaurants] = await pool.query(
      'SELECT id, name, slug, whatsapp, is_active FROM restaurants ORDER BY name'
    );
    res.json({ restaurants });
  } catch (err) {
    console.error('Erro ao listar estabelecimentos:', err);
    res.status(500).json({ error: 'Erro ao carregar estabelecimentos.' });
  }
});

// Rota (sistema) para criar um novo estabelecimento
app.post('/api/sistema/restaurants', sysAdminAuth, async (req, res) => {
  try {
    const { name, slug, whatsapp } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ error: 'Nome e slug são obrigatórios.' });
    }

    const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    if (!slugPattern.test(slug)) {
      return res.status(400).json({ error: 'Slug inválido. Use apenas letras minúsculas, números e hífens (ex: pizzaria-do-bruno).' });
    }

    const [result] = await pool.query(
      'INSERT INTO restaurants (name, slug, whatsapp, is_active) VALUES (?, ?, ?, TRUE)',
      [name, slug, whatsapp || null]
    );

    res.status(201).json({ message: 'Estabelecimento criado com sucesso!', restaurant_id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Já existe um estabelecimento com esse slug.' });
    }
    console.error('Erro ao criar estabelecimento:', err);
    res.status(500).json({ error: 'Erro ao criar estabelecimento.' });
  }
});

// Rota (sistema) para editar um estabelecimento (nome, slug, whatsapp, status de funcionamento)
app.put('/api/sistema/restaurants/:id', sysAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, whatsapp, is_active } = req.body;

    if (slug !== undefined) {
      const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
      if (!slugPattern.test(slug)) {
        return res.status(400).json({ error: 'Slug inválido. Use apenas letras minúsculas, números e hífens (ex: pizzaria-do-bruno).' });
      }
    }

    const fields = [];
    const values = [];

    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (slug !== undefined) { fields.push('slug = ?'); values.push(slug); }
    if (whatsapp !== undefined) { fields.push('whatsapp = ?'); values.push(whatsapp); }
    if (is_active !== undefined) { fields.push('is_active = ?'); values.push(Boolean(is_active)); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar foi informado.' });
    }

    values.push(id);

    const [result] = await pool.query(
      `UPDATE restaurants SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Estabelecimento não encontrado.' });
    }

    res.json({ message: 'Estabelecimento atualizado com sucesso!' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Já existe um estabelecimento com esse slug.' });
    }
    console.error('Erro ao atualizar estabelecimento:', err);
    res.status(500).json({ error: 'Erro ao atualizar estabelecimento.' });
  }
});

// Rota (sistema) para excluir um estabelecimento
app.delete('/api/sistema/restaurants/:id', sysAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.query('DELETE FROM restaurants WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Estabelecimento não encontrado.' });
    }

    res.json({ message: 'Estabelecimento excluído com sucesso!' });
  } catch (err) {
    console.error('Erro ao excluir estabelecimento:', err);
    res.status(500).json({ error: 'Erro ao excluir estabelecimento. Verifique se ele não possui produtos ou pedidos associados.' });
  }
});

// Página do painel de administração do sistema
app.get('/sistema/admin', sysAdminAuth, (req, res) => {
  res.render('system/restaurants');
});

// Teste de Saúde / Conexão
// Precisa vir antes de '/:slug': como esse padrão casa qualquer segmento
// unico da URL, se ficasse depois o Express tentaria tratar "health"
// como um slug de estabelecimento.
app.get('/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT NOW() AS data_atual');
    res.json({ status: 'OK', db_time: rows[0].data_atual });
  } catch (err) {
    res.status(500).json({ error: 'Erro no banco' });
  }
});

// Rota pública: página do cardápio para o cliente fazer pedidos
app.get('/:slug', tenantMiddleware, async (req, res) => {
  try {
    const [products] = await pool.query(
      'SELECT id, name, description, price, is_customizable FROM products WHERE restaurant_id = ? AND is_available = TRUE',
      [req.restaurant.id]
    );

    res.render('client/menu', { restaurant: req.restaurant, products });
  } catch (err) {
    console.error('Erro ao renderizar cardápio:', err);
    res.status(500).send('Erro ao carregar cardápio.');
  }
});

// Rota do painel administrativo: pedidos
app.get('/:slug/admin', adminAuth, tenantMiddleware, (req, res) => {
  res.render('admin/orders', { restaurant: req.restaurant });
});

// Rota do painel administrativo: produtos
app.get('/:slug/admin/produtos', adminAuth, tenantMiddleware, (req, res) => {
  res.render('admin/products', { restaurant: req.restaurant });
});

// Rota POST para receber o pedido do carrinho (Otimizada e Segura)
// Suporta produtos montáveis: items[].option_ids (array de group_options.id)
// Preço sempre recalculado no servidor: base + SUM(extra_price). Min/max validados.
app.post('/api/orders/:slug', tenantMiddleware, async (req, res) => {
  const { customer_name, customer_phone, delivery_address, payment_method, items } = req.body;

  // Validação inicial antes de solicitar conexão ao pool
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'O carrinho não pode estar vazio.' });
  }

  const connection = await pool.getConnection();

  try {
    const restaurantId = req.restaurant.id;

    // 1. INICIA A TRANSAÇÃO
    await connection.beginTransaction();

    let totalAmount = 0;
    const validatedItems = [];

    // Busca todos os produtos do carrinho em uma única consulta (Evita consulta N+1)
    const productIds = [...new Set(items.map(i => Number(i.product_id)).filter(Boolean))];
    if (productIds.length === 0) throw new Error('Carrinho inválido.');
    const [products] = await connection.query(
      'SELECT id, name, price, is_available, is_customizable FROM products WHERE id IN (?) AND restaurant_id = ?',
      [productIds, restaurantId]
    );

    // Mapeia os produtos para acesso O(1)
    const productMap = new Map(products.map(p => [p.id, p]));

    // Pré-carrega grupos + opções de todos os montáveis do carrinho
    const customizableIds = products.filter(p => p.is_customizable).map(p => p.id);
    let groupsByProduct = new Map();
    let optionsById = new Map();
    if (customizableIds.length > 0) {
      const [groups] = await connection.query(
        'SELECT id, product_id, name, min_required, max_allowed FROM option_groups WHERE restaurant_id = ? AND product_id IN (?)',
        [restaurantId, customizableIds]
      );
      for (const g of groups) {
        if (!groupsByProduct.has(g.product_id)) groupsByProduct.set(g.product_id, []);
        groupsByProduct.get(g.product_id).push(g);
      }
      if (groups.length > 0) {
        const [opts] = await connection.query(
          `SELECT go.id, go.group_id, go.name AS option_name, go.extra_price, go.is_available,
                  g.product_id, g.name AS group_name
           FROM group_options go JOIN option_groups g ON g.id = go.group_id
           WHERE g.restaurant_id = ? AND g.product_id IN (?)`,
          [restaurantId, customizableIds]
        );
        for (const o of opts) optionsById.set(o.id, o);
      }
    }

    for (const item of items) {
      const pid = Number(item.product_id);
      const qty = Number(item.quantity);
      const product = productMap.get(pid);

      if (!product || !product.is_available) {
        throw new Error(`Produto ID ${item.product_id} não está disponível neste estabelecimento.`);
      }
      if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
        throw new Error(`Quantidade inválida para o produto ID ${pid}.`);
      }

      const rawOptionIds = item.option_ids || item.options || [];
      const optionIds = Array.isArray(rawOptionIds) ? rawOptionIds.map(Number).filter(Boolean) : [];
      let unitPrice = Number(product.price);
      let selectedSnapshots = [];

      if (product.is_customizable) {
        const groups = groupsByProduct.get(pid) || [];
        if (groups.length === 0) {
          throw new Error(`Produto ID ${pid} está marcado como montável mas não tem grupos cadastrados.`);
        }
        if (new Set(optionIds).size !== optionIds.length) {
          throw new Error(`Opções duplicadas no produto ID ${pid}.`);
        }
        const byGroup = new Map();
        for (const oid of optionIds) {
          const opt = optionsById.get(oid);
          if (!opt || !opt.is_available) {
            throw new Error(`Opção ID ${oid} indisponível para o produto ID ${pid}.`);
          }
          if (Number(opt.product_id) !== pid) {
            throw new Error(`Opção ID ${oid} não pertence ao produto ID ${pid}.`);
          }
          if (!byGroup.has(opt.group_id)) byGroup.set(opt.group_id, []);
          byGroup.get(opt.group_id).push(opt);
        }
        let optionsTotal = 0;
        for (const g of groups) {
          const count = (byGroup.get(g.id) || []).length;
          if (count < g.min_required || count > g.max_allowed) {
            throw new Error(`"${g.name}": escolha entre ${g.min_required} e ${g.max_allowed} (você escolheu ${count}).`);
          }
        }
        for (const oid of optionIds) {
          const opt = optionsById.get(oid);
          optionsTotal += Number(opt.extra_price);
          selectedSnapshots.push({
            group_id: opt.group_id,
            group_name: opt.group_name,
            option_id: opt.id,
            option_name: opt.option_name,
            extra_price: Number(opt.extra_price)
          });
        }
        unitPrice += optionsTotal;
      } else if (optionIds.length > 0) {
        throw new Error(`Produto ID ${pid} não é montável e não aceita opções.`);
      }

      const subtotal = unitPrice * qty;
      totalAmount += subtotal;

      validatedItems.push({
        product_id: product.id,
        product_name: product.name,
        quantity: qty,
        unit_price: unitPrice,
        subtotal: subtotal,
        selected_options: selectedSnapshots
      });
    }

    // 2. INSERE O PEDIDO PRINCIPAL (orders)
    const [orderResult] = await connection.query(
      `INSERT INTO orders
       (restaurant_id, customer_name, customer_phone, delivery_address, payment_method, total_amount, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [restaurantId, customer_name, customer_phone, delivery_address, payment_method, totalAmount]
    );

    const orderId = orderResult.insertId;

    // 3. INSERE OS ITENS DO PEDIDO EM LOTE (Batch Insert)
    const orderItemsValues = validatedItems.map(item => [
      orderId,
      item.product_id,
      item.quantity,
      item.unit_price,
      item.subtotal
    ]);

    const [itemsResult] = await connection.query(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal) VALUES ?`,
      [orderItemsValues]
    );

    // 4. INSERE AS OPÇÕES ESCOLHIDAS (snapshot p/ cozinha)
    const firstItemId = itemsResult.insertId;
    const optionRows = [];
    validatedItems.forEach((item, idx) => {
      const orderItemId = firstItemId + idx;
      for (const s of item.selected_options) {
        optionRows.push([orderItemId, s.group_id, s.group_name, s.option_id, s.option_name, s.extra_price]);
      }
    });
    if (optionRows.length > 0) {
      await connection.query(
        `INSERT INTO order_item_options (order_item_id, group_id, group_name, option_id, option_name, extra_price) VALUES ?`,
        [optionRows]
      );
    }

    // 5. CONFIRMA A TRANSAÇÃO
    await connection.commit();

    // Avisa o painel de pedidos (se estiver aberto) que chegou pedido novo
    io.to(req.params.slug).emit('new-order', {
      order_id: orderId,
      customer_name,
      total_amount: totalAmount
    });

    // 6. NOTIFICA A LOJA NO WHATSAPP (não bloqueia a resposta se falhar)
    let whatsappSent = false;
    let whatsappError = null;
    try {
      if (req.restaurant.whatsapp) {
        const message = buildOrderMessage({
          orderId,
          restaurantName: req.restaurant.name,
          customer: {
            name: customer_name,
            phone: customer_phone,
            address: delivery_address,
            payment: payment_method
          },
          items: validatedItems.map((v) => ({
            name: v.product_name,
            quantity: v.quantity,
            unit_price: v.unit_price,
            subtotal: v.subtotal,
            selected_options: v.selected_options
          })),
          total: totalAmount
        });
        await sendOrderToRestaurant({ to: req.restaurant.whatsapp, message });
        whatsappSent = true;
      } else {
        whatsappError = 'Loja sem WhatsApp cadastrado.';
      }
    } catch (wErr) {
      whatsappError = wErr.message;
      console.error('Erro ao enviar pedido via WhatsApp:', wErr.message);
    }

    res.status(201).json({
      message: 'Pedido realizado com sucesso!',
      order_id: orderId,
      restaurant: req.restaurant.name,
      total_amount: totalAmount,
      whatsapp_sent: whatsappSent,
      ...(whatsappError ? { whatsapp_error: whatsappError } : {})
    });

  } catch (err) {
    // 7. EM CASO DE ERRO, DESFAZ A TRANSAÇÃO
    await connection.rollback();
    console.error('Erro na transação de pedido:', err.message);
    res.status(500).json({ error: 'Erro ao processar o pedido: ' + err.message });
  } finally {
    // GARANTE QUE A CONEXÃO É DEVOLVIDA AO POOL (Evita vazamento de conexões)
    connection.release();
  }
});

// Rota para o painel do restaurante ver todos os pedidos
app.get('/api/orders/:slug', adminAuth, tenantMiddleware, async (req, res) => {
  try {
    const restaurantId = req.restaurant.id;
    const { status } = req.query;

    let query = `
      SELECT 
        o.id AS order_id,
        o.customer_name,
        o.customer_phone,
        o.delivery_address,
        o.payment_method,
        o.total_amount,
        o.status,
        o.created_at,
        oi.id AS item_id,
        oi.product_id,
        p.name AS product_name,
        oi.quantity,
        oi.unit_price,
        oi.subtotal
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE o.restaurant_id = ?
    `;

    const queryParams = [restaurantId];

    if (status) {
      query += ` AND o.status = ?`;
      queryParams.push(status);
    }

    query += ` ORDER BY o.created_at DESC, o.id DESC`;

    const [rows] = await pool.query(query, queryParams);

    // Busca snapshots das opções dos itens (para a cozinha ver o detalhe do montável)
    const itemIds = [...new Set(rows.filter((r) => r.item_id).map((r) => r.item_id))];
    let optionsByItem = new Map();
    if (itemIds.length > 0) {
      const [optRows] = await pool.query(
        'SELECT order_item_id, group_name, option_name, extra_price FROM order_item_options WHERE order_item_id IN (?) ORDER BY id',
        [itemIds]
      );
      for (const o of optRows) {
        if (!optionsByItem.has(o.order_item_id)) optionsByItem.set(o.order_item_id, []);
        optionsByItem.get(o.order_item_id).push(o);
      }
    }

    const ordersMap = new Map();

    for (const row of rows) {
      if (!ordersMap.has(row.order_id)) {
        ordersMap.set(row.order_id, {
          id: row.order_id,
          customer_name: row.customer_name,
          customer_phone: row.customer_phone,
          delivery_address: row.delivery_address,
          payment_method: row.payment_method,
          total_amount: row.total_amount,
          status: row.status,
          created_at: row.created_at,
          items: []
        });
      }

      if (row.item_id) {
        ordersMap.get(row.order_id).items.push({
          item_id: row.item_id,
          product_id: row.product_id,
          product_name: row.product_name,
          quantity: row.quantity,
          unit_price: row.unit_price,
          subtotal: row.subtotal,
          selected_options: optionsByItem.get(row.item_id) || []
        });
      }
    }

    const ordersList = Array.from(ordersMap.values());

    res.json({
      restaurant: req.restaurant.name,
      total_orders: ordersList.length,
      orders: ordersList
    });

  } catch (err) {
    console.error('Erro ao listar pedidos:', err);
    res.status(500).json({ error: 'Erro ao buscar pedidos do painel.' });
  }
});

// Rota para atualizar o status de um pedido
app.put('/api/orders/:slug/:orderId/status', adminAuth, tenantMiddleware, async (req, res) => {
  try {
    const restaurantId = req.restaurant.id;
    const { orderId } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'preparing', 'shipped', 'delivered', 'cancelled'];

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: `Status inválido. Use um dos seguintes: ${validStatuses.join(', ')}` 
      });
    }

    const [result] = await pool.query(
      `UPDATE orders 
       SET status = ? 
       WHERE id = ? AND restaurant_id = ?`,
      [status, orderId, restaurantId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: 'Pedido não encontrado ou não pertence a este estabelecimento.'
      });
    }

    io.to(req.params.slug).emit('order-updated', {
      order_id: Number(orderId),
      status
    });

    res.json({
      message: 'Status do pedido atualizado com sucesso!',
      order_id: Number(orderId),
      new_status: status
    });

  } catch (err) {
    console.error('Erro ao atualizar status do pedido:', err);
    res.status(500).json({ error: 'Erro interno ao alterar status.' });
  }
});

// Rota para o lojista escolher o som de notificação de pedido novo do seu painel
app.put('/api/settings/:slug/notification-sound', adminAuth, tenantMiddleware, async (req, res) => {
  try {
    const { notification_sound } = req.body;

    if (!NOTIFICATION_SOUNDS.includes(notification_sound)) {
      return res.status(400).json({
        error: `Som inválido. Use um dos seguintes: ${NOTIFICATION_SOUNDS.join(', ')}`
      });
    }

    await pool.query(
      'UPDATE restaurants SET notification_sound = ? WHERE id = ?',
      [notification_sound, req.restaurant.id]
    );

    res.json({ message: 'Som de notificação atualizado com sucesso!', notification_sound });
  } catch (err) {
    console.error('Erro ao atualizar som de notificação:', err);
    res.status(500).json({ error: 'Erro interno ao salvar preferência de som.' });
  }
});

// ===== WhatsApp: status + QR + página de conexão (lojista) =====

// Status da conexão (para o painel mostrar "conectado" ou "aguardando QR")
app.get('/api/whatsapp/:slug/status', adminAuth, tenantMiddleware, (req, res) => {
  res.json({
    restaurant: req.restaurant.name,
    send_to: req.restaurant.whatsapp || null,
    ...getWhatsAppStatus()
  });
});

// QR Code atual (string). O front renderiza com biblioteca QR via CDN.
app.get('/api/whatsapp/:slug/qr', adminAuth, tenantMiddleware, (req, res) => {
  const qr = getLastQR();
  if (!qr) {
    return res.status(404).json({ error: 'Nenhum QR disponível. Já conectado ou ainda inicializando.' });
  }
  res.json({ qr });
});

// Página do lojista para conectar o WhatsApp (escaneia o QR uma única vez)
app.get('/:slug/admin/whatsapp', adminAuth, tenantMiddleware, (req, res) => {
  res.render('admin/whatsapp', { restaurant: req.restaurant });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando em http://0.0.0.0:${PORT}`);
});