const mysql = require("mysql2/promise");

const DB_CONFIG = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "fudao",
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_LIMIT || 10),
  queueLimit: 0,
  charset: "utf8mb4"
};

let pool;

function getPool() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

async function query(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function execute(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return result;
}

async function tx(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function execOn(conn, sql, params = []) {
  const [result] = await conn.execute(sql, params);
  return result;
}

async function queryOn(conn, sql, params = []) {
  const [rows] = await conn.query(sql, params);
  return rows;
}

async function oneOn(conn, sql, params = []) {
  const rows = await queryOn(conn, sql, params);
  return rows[0] || null;
}

async function initSchema() {
  await query(`CREATE TABLE IF NOT EXISTS users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(191) NOT NULL UNIQUE,
    phone VARCHAR(191) NULL UNIQUE,
    email VARCHAR(191) NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    avatar TEXT NULL,
    balance DECIMAL(12,2) NOT NULL DEFAULT 0,
    frozen TINYINT(1) NOT NULL DEFAULT 0,
    role VARCHAR(32) NOT NULL DEFAULT 'user',
    last_login_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await query(`CREATE TABLE IF NOT EXISTS experts (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(191) NOT NULL,
    avatar TEXT NULL,
    verified TINYINT(1) NOT NULL DEFAULT 1,
    rank_score INT NOT NULL DEFAULT 0,
    intro TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await query(`CREATE TABLE IF NOT EXISTS predictions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    category VARCHAR(64) NULL,
    tags LONGTEXT NULL,
    is_free TINYINT(1) NOT NULL DEFAULT 0,
    price DECIMAL(12,2) NOT NULL DEFAULT 0,
    content_full LONGTEXT NULL,
    heat INT NOT NULL DEFAULT 0,
    hit_status VARCHAR(32) NOT NULL DEFAULT 'none',
    expert_id INT NULL,
    published_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_predictions_expert_id (expert_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await query(`CREATE TABLE IF NOT EXISTS follows (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    expert_id INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_user_expert (user_id, expert_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await query(`CREATE TABLE IF NOT EXISTS orders (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    prediction_id INT NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    paid_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_orders_user_id (user_id),
    INDEX idx_orders_prediction_id (prediction_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await query(`CREATE TABLE IF NOT EXISTS recharges (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    channel VARCHAR(32) NOT NULL DEFAULT 'manual',
    status VARCHAR(32) NOT NULL DEFAULT 'success',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_recharges_user_id (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await query(`CREATE TABLE IF NOT EXISTS bot_unlocks (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    bot_key VARCHAR(255) NOT NULL,
    issue VARCHAR(32) NOT NULL,
    amount DECIMAL(12,2) NOT NULL DEFAULT 88,
    status VARCHAR(32) NOT NULL DEFAULT 'success',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_bot_unlock (user_id, bot_key, issue)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await query(`CREATE TABLE IF NOT EXISTS app_settings (
    \`key\` VARCHAR(191) PRIMARY KEY,
    \`value\` LONGTEXT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await query(`CREATE TABLE IF NOT EXISTS bot_categories (
    id INT PRIMARY KEY AUTO_INCREMENT,
    code VARCHAR(32) NOT NULL UNIQUE,
    label VARCHAR(64) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await query(`CREATE TABLE IF NOT EXISTS bots (
    id INT PRIMARY KEY AUTO_INCREMENT,
    base VARCHAR(32) NOT NULL,
    file VARCHAR(64) NOT NULL,
    bot_name VARCHAR(191) NOT NULL,
    robot_id VARCHAR(191) NOT NULL,
    issue VARCHAR(32) NOT NULL DEFAULT '',
    title TEXT NULL,
    prediction LONGTEXT NULL,
    avatar_base VARCHAR(64) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_bot_base_file (base, file),
    UNIQUE KEY uniq_bot_base_robot (base, robot_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await query(`CREATE TABLE IF NOT EXISTS bot_past_records (
    id INT PRIMARY KEY AUTO_INCREMENT,
    bot_id INT NOT NULL,
    issue VARCHAR(32) NOT NULL,
    body LONGTEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_bot_issue (bot_id, issue),
    INDEX idx_bot_records_bot_id (bot_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await query(
    `INSERT IGNORE INTO bot_categories(code, label) VALUES ('1avatar','精选特码🔥'), ('2avatar','生肖特码🐴'), ('3avatar','精选三中三💯')`
  );
  await query(
    `INSERT IGNORE INTO app_settings(\`key\`, \`value\`) VALUES ('service_wechat', ''), ('reward_min', '1880'), ('reward_max', '2580')`
  );
}

module.exports = {
  DB_CONFIG,
  getPool,
  query,
  one,
  execute,
  tx,
  execOn,
  queryOn,
  oneOn,
  initSchema
};
