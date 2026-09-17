require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

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
    // req.restaurant veio do middleware
    const restaurantId = req.restaurant.id;

    // Busca apenas os produtos PERTENCENTES a este restaurant_id
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

// Teste de Saúde / Conexão
app.get('/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT NOW() AS data_atual');
    res.json({ status: 'OK', db_time: rows[0].data_atual });
  } catch (err) {
    res.status(500).json({ error: 'Erro no banco' });
  }
});

// Rota POST para receber o pedido do carrinho
app.post('/api/orders/:slug', tenantMiddleware, async (req, res) => {
  // Pega uma conexão individual do Pool para executar a transação
  const connection = await pool.getConnection();

  try {
    const restaurantId = req.restaurant.id;
    const { customer_name, customer_phone, delivery_address, payment_method, items } = req.body;

    // Validação simples
    if (!items || !Array.isArray(items) || items.length === 0) {
      connection.release();
      return res.status(400).json({ error: 'O carrinho não pode estar vazio.' });
    }

    // 1. INICIA A TRANSAÇÃO
    await connection.beginTransaction();

    // Calcula o valor total do pedido no backend para evitar fraudes do frontend
    let totalAmount = 0;
    const validatedItems = [];

    for (const item of items) {
      // Busca o produto e garante que ele PERTENCE ao estabelecimento correto
      const [products] = await connection.query(
        'SELECT id, price, is_available FROM products WHERE id = ? AND restaurant_id = ?',
        [item.product_id, restaurantId]
      );

      if (products.length === 0 || !products[0].is_available) {
        throw new Error(`Produto ID ${item.product_id} não está disponível neste estabelecimento.`);
      }

      const product = products[0];
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

    // 3. INSERE OS ITENS DO PEDIDO (order_items)
    for (const item of validatedItems) {
      await connection.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal) 
         VALUES (?, ?, ?, ?, ?)`,
        [orderId, item.product_id, item.quantity, item.unit_price, item.subtotal]
      );
    }

    // 4. CONFIRMA A TRANSAÇÃO (salva tudo definitivamente)
    await connection.commit();

    // Devolve a conexão ao pool
    connection.release();

    res.status(201).json({
      message: 'Pedido realizado com sucesso!',
      order_id: orderId,
      restaurant: req.restaurant.name,
      total_amount: totalAmount
    });

  } catch (err) {
    // 5. EM CASO DE ERRO, DESFAZ QUALQUER ALTERAÇÃO NO BANCO
    await connection.rollback();
    
    // Sempre libere a conexão de volta ao Pool!
    connection.release();

    console.error('Erro na transação de pedido:', err.message);
    res.status(500).json({ error: 'Erro ao processar o pedido: ' + err.message });
  }
});

// Rota para o painel do restaurante ver todos os pedidos
app.get('/api/orders/:slug', tenantMiddleware, async (req, res) => {
  try {
    const restaurantId = req.restaurant.id;
    const { status } = req.query; // Permite filtrar por query param ex: ?status=pending

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

    // Se o painel passar um filtro de status
    if (status) {
      query += ` AND o.status = ?`;
      queryParams.push(status);
    }

    query += ` ORDER BY o.created_at DESC, o.id DESC`;

    const [rows] = await pool.query(query, queryParams);

    // Agrupa as linhas do banco (flat rows) em objetos de Pedidos com array de itens
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

      // Se existir item vinculado, adiciona no array items do pedido
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
app.put('/api/orders/:slug/:orderId/status', tenantMiddleware, async (req, res) => {
  try {
    const restaurantId = req.restaurant.id;
    const { orderId } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'preparing', 'shipped', 'delivered', 'cancelled'];

    // Validar se o status enviado é válido
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: `Status inválido. Use um dos seguintes: ${validStatuses.join(', ')}` 
      });
    }

    // Executa a atualização garantindo que o pedido pertence ao restaurant_id correto (Isolamento Multi-tenant)
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
