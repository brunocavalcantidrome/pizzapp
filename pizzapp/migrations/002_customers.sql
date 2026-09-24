-- Migration 002: clientes por restaurante (fidelização, identificado pelo telefone)
-- Escopo multi-tenant: o cliente pertence ao restaurante (restaurant_id).

CREATE TABLE IF NOT EXISTS customers (
  id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT(11) NOT NULL,
  name VARCHAR(150) NOT NULL,
  phone VARCHAR(20) NOT NULL COMMENT 'Somente dígitos, com DDI (ex: 5571987301606)',
  total_orders INT(11) NOT NULL DEFAULT 0,
  total_spent DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  first_order_at TIMESTAMP NULL,
  last_order_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  CONSTRAINT fk_customers_restaurant FOREIGN KEY (restaurant_id) REFERENCES restaurants (id) ON DELETE CASCADE,
  UNIQUE KEY uq_customers_restaurant_phone (restaurant_id, phone),
  INDEX idx_customers_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
