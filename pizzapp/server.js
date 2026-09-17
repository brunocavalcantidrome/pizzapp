require('dotenv').config();
const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const PORT = process.env.PORT || 3000;

// Middleware de autenticação básica para o painel do administrador
function adminAuth(req, res, next) {
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASSWORD;

  const header = req.headers.authorization;
  if (header) {
    const [, encoded] = header.split(' ');
    const [reqUser, reqPass] = Buffer.from(encoded || '', 'base64').toString().split(':');
    if (reqUser === user && reqPass === pass) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Painel Administrativo"');
  return res.status(401).send('Autenticação necessária.');
}

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
      'SELECT id, name, whatsapp, is_active FROM restaurants WHERE slug = ?', 
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

// Rota 1: Rota pública para buscar dados da loja e seu cardápio
app.get('/api/menu/:slug', tenantMiddleware, async (req, res) => {
  try {
    const restaurantId = req.restaurant.id;

    const [products] = await pool.query(
      'SELECT id, name, description, price FROM products WHERE restaurant_id = ? AND is_available = TRUE',
      [restaurantId]
    );

    res.json({
      restaurant: req.restaurant,
      products: products
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
      'SELECT id, name, description, price, is_available FROM products WHERE restaurant_id = ? ORDER BY name',
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
    const { name, description, price } = req.body;

    if (!name || price === undefined || price === null || isNaN(Number(price))) {
      return res.status(400).json({ error: 'Nome e preço válido são obrigatórios.' });
    }

    const [result] = await pool.query(
      'INSERT INTO products (restaurant_id, name, description, price, is_available) VALUES (?, ?, ?, ?, TRUE)',
      [req.restaurant.id, name, description || null, Number(price)]
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
    const { name, description, price, is_available } = req.body;

    const fields = [];
    const values = [];

    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description); }
    if (price !== undefined) { fields.push('price = ?'); values.push(Number(price)); }
    if (is_available !== undefined) { fields.push('is_available = ?'); values.push(Boolean(is_available)); }

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

// Rota pública: página do cardápio para o cliente fazer pedidos
app.get('/:slug', tenantMiddleware, async (req, res) => {
  try {
    const [products] = await pool.query(
      'SELECT id, name, description, price FROM products WHERE restaurant_id = ? AND is_available = TRUE',
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

// Teste de Saúde / Conexão
app.get('/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT NOW() AS data_atual');
    res.json({ status: 'OK', db_time: rows[0].data_atual });
  } catch (err) {
    res.status(500).json({ error: 'Erro no banco' });
  }
});

// Rota POST para receber o pedido do carrinho (Otimizada e Segura)
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
    const productIds = items.map(i => i.product_id);
    const [products] = await connection.query(
      'SELECT id, price, is_available FROM products WHERE id IN (?) AND restaurant_id = ?',
      [productIds, restaurantId]
    );

    // Mapeia os produtos para acesso O(1)
    const productMap = new Map(products.map(p => [p.id, p]));

    for (const item of items) {
      const product = productMap.get(item.product_id);

      if (!product || !product.is_available) {
        throw new Error(`Produto ID ${item.product_id} não está disponível neste estabelecimento.`);
      }

      const subtotal = Number(product.price) * Number(item.quantity);
      totalAmount += subtotal;

      validatedItems.push({
        product_id: product.id,
        quantity: item.quantity,
        unit_price: product.price,
        subtotal: subtotal
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

    await connection.query(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal) VALUES ?`,
      [orderItemsValues]
    );

    // 4. CONFIRMA A TRANSAÇÃO
    await connection.commit();

    res.status(201).json({
      message: 'Pedido realizado com sucesso!',
      order_id: orderId,
      restaurant: req.restaurant.name,
      total_amount: totalAmount
    });

  } catch (err) {
    // 5. EM CASO DE ERRO, DESFAZ A TRANSAÇÃO
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
          subtotal: row.subtotal
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando em http://0.0.0.0:${PORT}`);
});