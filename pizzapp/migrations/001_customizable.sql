-- Migration 001: produtos montaveis (ex: Monte seu macarrao)
-- Generico: qualquer produto pode ter grupos de opcoes com min/max + adicional de preco.

-- 1. Flag no produto
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_customizable TINYINT(1) NOT NULL DEFAULT 0;

-- 2. Grupos de opcoes (ex: Massa min1/max1, Molho min1/max1, Extras min0/max3)
CREATE TABLE IF NOT EXISTS option_groups (
  id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT(11) NOT NULL,
  product_id INT(11) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT NULL,
  min_required INT(11) NOT NULL DEFAULT 0,
  max_allowed INT(11) NOT NULL DEFAULT 1,
  sort_order INT(11) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  CONSTRAINT fk_option_groups_restaurant FOREIGN KEY (restaurant_id) REFERENCES restaurants (id) ON DELETE CASCADE,
  CONSTRAINT fk_option_groups_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  INDEX idx_option_groups_product (product_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Opcoes dentro de cada grupo (ex: Espaguete +0, Bacon +5)
CREATE TABLE IF NOT EXISTS group_options (
  id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_id INT(11) NOT NULL,
  name VARCHAR(100) NOT NULL,
  extra_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  is_available TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT(11) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  CONSTRAINT fk_group_options_group FOREIGN KEY (group_id) REFERENCES option_groups (id) ON DELETE CASCADE,
  INDEX idx_group_options_group (group_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. Snapshot das escolhas em cada item do pedido (historico p/ cozinha + total imutavel)
CREATE TABLE IF NOT EXISTS order_item_options (
  id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_item_id INT(11) NOT NULL,
  group_id INT(11) NOT NULL,
  group_name VARCHAR(100) NOT NULL,
  option_id INT(11) NOT NULL,
  option_name VARCHAR(100) NOT NULL,
  extra_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  CONSTRAINT fk_order_item_options_item FOREIGN KEY (order_item_id) REFERENCES order_items (id) ON DELETE CASCADE,
  INDEX idx_order_item_options_item (order_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
