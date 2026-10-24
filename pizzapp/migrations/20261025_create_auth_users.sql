-- Migration: create auth users, password reset tokens, and session store
CREATE TABLE IF NOT EXISTS auth_users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NULL,
  role ENUM('sysadmin','admin') NOT NULL DEFAULT 'admin',
  username VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NULL,
  whatsapp VARCHAR(20) NULL,
  name VARCHAR(150) NULL,
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_login_at DATETIME NULL,
  UNIQUE KEY uq_auth_users_username (username),
  UNIQUE KEY uq_auth_users_whatsapp_rest (restaurant_id, whatsapp),
  INDEX idx_auth_users_rest (restaurant_id),
  INDEX idx_auth_users_whatsapp (whatsapp),
  CONSTRAINT fk_auth_users_rest FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token VARCHAR(128) NOT NULL,
  whatsapp_to VARCHAR(20) NOT NULL,
  expires_at DATETIME NOT NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by INT NULL,
  INDEX idx_prt_token (token),
  INDEX idx_prt_user (user_id),
  INDEX idx_prt_exp (expires_at),
  CONSTRAINT fk_prt_user FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  expires INT UNSIGNED NOT NULL,
  data MEDIUMTEXT COLLATE utf8mb4_bin,
  INDEX sessions_expire_index (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
