-- Migration 003: categorias de produtos + imagens (loja e produtos)

-- 1. Categorias por loja (ex: Pizzas, Calzones, Bebidas, Sobremesas)
CREATE TABLE IF NOT EXISTS categories (
  id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT(11) NOT NULL,
  name VARCHAR(100) NOT NULL,
  sort_order INT(11) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  CONSTRAINT fk_categories_restaurant FOREIGN KEY (restaurant_id) REFERENCES restaurants (id) ON DELETE CASCADE,
  UNIQUE KEY uq_categories_restaurant_name (restaurant_id, name),
  INDEX idx_categories_restaurant (restaurant_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Produto: categoria + foto
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS category_id INT(11) NULL,
  ADD COLUMN IF NOT EXISTS image_url VARCHAR(255) NULL;

-- 2b. FK categoria (MariaDB 10.5 não suporta IF NOT EXISTS aqui; migration roda uma vez)
ALTER TABLE products
  ADD CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE SET NULL;

-- 3. Loja: logo + capa
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS logo_url VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS cover_url VARCHAR(255) NULL;
