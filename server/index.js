const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const { z } = require("zod");

const app = express();
const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = "dev_secret_change_me";

app.use(cors());
app.use(express.json());

const db = new Database("./app.db");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  phone TEXT UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  avatar TEXT,
  balance REAL DEFAULT 0,
  frozen INTEGER DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS experts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  avatar TEXT,
  verified INTEGER DEFAULT 1,
  rank_score INTEGER DEFAULT 0,
  intro TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  tags TEXT,
  is_free INTEGER DEFAULT 0,
  price REAL DEFAULT 0,
  content_full TEXT,
  heat INTEGER DEFAULT 0,
  hit_status TEXT DEFAULT 'none',
  expert_id INTEGER,
  published_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  expert_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, expert_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  prediction_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  status TEXT DEFAULT 'pending',
  paid_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recharges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  channel TEXT DEFAULT 'manual',
  status TEXT DEFAULT 'success',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bot_unlocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  bot_key TEXT NOT NULL,
  issue TEXT NOT NULL,
  amount REAL DEFAULT 88,
  status TEXT DEFAULT 'success',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, bot_key, issue)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

function ensureColumn(table, column, sqlTypeAndDefault) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlTypeAndDefault}`);
  }
}
ensureColumn("users", "frozen", "INTEGER DEFAULT 0");
ensureColumn("users", "last_login_at", "TEXT");
ensureColumn("users", "role", "TEXT DEFAULT 'user'");
db.prepare("UPDATE users SET role='admin' WHERE username='admin'").run();
db.prepare("INSERT OR IGNORE INTO app_settings(key, value) VALUES('service_wechat','')").run();

const expertCount = db.prepare("SELECT COUNT(*) AS c FROM experts").get().c;
if (!expertCount) {
  const insertExpert = db.prepare("INSERT INTO experts(name, avatar, rank_score, intro) VALUES(?,?,?,?)");
  const insertPrediction = db.prepare(
    "INSERT INTO predictions(title, description, category, tags, is_free, price, content_full, heat, hit_status, expert_id, published_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
  );
  for (let i = 1; i <= 12; i += 1) {
    insertExpert.run(`专家${i}`, `https://i.pravatar.cc/80?img=${i + 10}`, 100 - i, `这是专家${i}的简介`);
  }
  const categories = ["精选特码🔥", "生肖特码🐴", "精选三中三💯"];
  for (let i = 1; i <= 45; i += 1) {
    const isFree = i % 3 === 0 ? 1 : 0;
    const price = isFree ? 0 : 88 + (i % 5) * 20;
    insertPrediction.run(
      `第26${100 + i}期 新澳预测${i}`,
      `这是第${i}条预测，含趋势分析与核心建议`,
      categories[i % categories.length],
      JSON.stringify(["一夜暴富", "全网最强2 4码"]),
      isFree,
      price,
      isFree ? "12, 18, 25, 31, 40" : "03, 08, 19, 27, 44",
      200 + i * 3,
      i % 2 === 0 ? "red" : "black",
      (i % 12) + 1,
      new Date(Date.now() - i * 3600 * 1000).toISOString()
    );
  }
}

const ensureAuth = (req, res, next) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ message: "未登录" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare("SELECT id, frozen FROM users WHERE id=?").get(payload.id);
    if (!user) return res.status(401).json({ message: "用户不存在" });
    if (Number(user.frozen) === 1) return res.status(403).json({ message: "账号已冻结" });
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ message: "登录已过期" });
  }
};

const ensureAdmin = (req, res, next) => {
  const me = db.prepare("SELECT id, role FROM users WHERE id=?").get(req.user?.id);
  const role = String(me?.role || "user");
  if (role !== "admin" && role !== "subadmin") {
    return res.status(403).json({ message: "仅后台账号可操作" });
  }
  req.userRole = role;
  next();
};

app.get("/api/auth/captcha", (_req, res) => {
  res.json({ captchaText: "1234", captchaSvg: "<svg>1234</svg>" });
});

/** 最新一期开奖（数组通常一条），见 https://macaumarksix.com/api/live2 */
const MACAU_JC_URL = "https://macaumarksix.com/api/live2";
const MACAU_HISTORY_URL = "https://history.macaumarksix.com/history/macaujc2/expect";

/** 代理澳门开奖 JSON，避免浏览器直连跨域 */
app.get("/api/macau-jc", async (_req, res) => {
  try {
    const r = await fetch(MACAU_JC_URL, {
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "Mozilla/5.0 (compatible; FumaApp/1.0)"
      }
    });
    const raw = await r.text();
    if (!r.ok) return res.status(502).json({ message: "开奖接口返回错误" });
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(502).json({ message: "开奖数据解析失败" });
    }
    res.json(data);
  } catch {
    res.status(502).json({ message: "开奖数据获取失败" });
  }
});

/** 查询单一期号历史开奖，期号使用完整 expect 格式，如 2026110 */
app.get("/api/macau-history/:expect", async (req, res) => {
  const expect = String(req.params.expect || "").trim();
  if (!/^\d{6,}$/.test(expect)) {
    return res.status(400).json({ message: "期号格式错误" });
  }
  try {
    const r = await fetch(`${MACAU_HISTORY_URL}/${encodeURIComponent(expect)}`, {
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "Mozilla/5.0 (compatible; FumaApp/1.0)"
      }
    });
    const raw = await r.text();
    if (!r.ok) return res.status(502).json({ message: "历史开奖接口返回错误" });
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(502).json({ message: "历史开奖数据解析失败" });
    }
    res.json(data);
  } catch {
    res.status(502).json({ message: "历史开奖数据获取失败" });
  }
});

app.post("/api/auth/register", async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || body.account || "").trim();
  const password = String(body.password || "");
  if (!/^\d{6}$/.test(username)) return res.status(400).json({ message: "注册名必须是6位数字" });
  if (!/^(?=.*[a-z])(?=.*\d)[a-z\d]+$/.test(password)) {
    return res.status(400).json({ message: "密码需为小写英文+数字组合（不含大写）" });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    db.prepare("INSERT INTO users(username, password_hash, avatar, balance, role) VALUES(?,?,?,?,?)").run(
      username,
      passwordHash,
      "https://i.pravatar.cc/80",
      0,
      "user"
    );
    res.json({ message: "注册成功" });
  } catch (e) {
    res.status(400).json({ message: "用户名已存在" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const body = req.body || {};
  const account = String(body.account || "").trim();
  const password = String(body.password || "");
  if (!account) return res.status(400).json({ message: "请输入账号" });
  if (!password || password.length < 3) return res.status(400).json({ message: "密码至少3位" });
  const user = db
    .prepare("SELECT * FROM users WHERE username=? OR phone=? OR email=?")
    .get(account, account, account);
  if (!user) return res.status(400).json({ message: "用户不存在" });
  if (Number(user.frozen) === 1) return res.status(403).json({ message: "账号已冻结" });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(400).json({ message: "密码错误" });
  db.prepare("UPDATE users SET last_login_at=? WHERE id=?").run(new Date().toISOString(), user.id);
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "7d" });
  res.json({
    token,
    user: { id: user.id, username: user.username, avatar: user.avatar, balance: user.balance, role: user.role || "user" }
  });
});

app.get("/api/user/me", ensureAuth, (req, res) => {
  const user = db.prepare("SELECT id, username, avatar, balance FROM users WHERE id=?").get(req.user.id);
  res.json(user);
});

app.get("/api/settings/service-wechat", (_req, res) => {
  const row = db.prepare("SELECT value FROM app_settings WHERE key='service_wechat'").get();
  res.json({ wechat: String(row?.value || "") });
});

app.get("/api/user/orders", ensureAuth, (req, res) => {
  const orders = db
    .prepare(
      "SELECT o.*, p.title FROM orders o LEFT JOIN predictions p ON p.id=o.prediction_id WHERE o.user_id=? ORDER BY o.id DESC"
    )
    .all(req.user.id);
  res.json(orders);
});

app.get("/api/user/follows", ensureAuth, (req, res) => {
  const rows = db
    .prepare(
      "SELECT e.* FROM follows f LEFT JOIN experts e ON e.id=f.expert_id WHERE f.user_id=? ORDER BY f.id DESC"
    )
    .all(req.user.id);
  res.json(rows);
});

app.get("/api/experts", ensureAuth, (req, res) => {
  const experts = db.prepare("SELECT * FROM experts ORDER BY rank_score DESC").all();
  const followed = db.prepare("SELECT expert_id FROM follows WHERE user_id=?").all(req.user.id).map((x) => x.expert_id);
  res.json(experts.map((e, idx) => ({ ...e, rank: idx + 1, followed: followed.includes(e.id) })));
});

app.post("/api/experts/:id/follow", ensureAuth, (req, res) => {
  try {
    db.prepare("INSERT INTO follows(user_id, expert_id) VALUES(?,?)").run(req.user.id, Number(req.params.id));
    res.json({ message: "关注成功" });
  } catch {
    res.json({ message: "已关注" });
  }
});

app.delete("/api/experts/:id/follow", ensureAuth, (req, res) => {
  db.prepare("DELETE FROM follows WHERE user_id=? AND expert_id=?").run(req.user.id, Number(req.params.id));
  res.json({ message: "已取消关注" });
});

app.get("/api/predictions", ensureAuth, (req, res) => {
  const category = req.query.category;
  const rows = category
    ? db
        .prepare(
          "SELECT p.*, e.name AS expert_name, e.avatar AS expert_avatar FROM predictions p LEFT JOIN experts e ON e.id=p.expert_id WHERE p.category=? ORDER BY p.id DESC"
        )
        .all(category)
    : db
        .prepare(
          "SELECT p.*, e.name AS expert_name, e.avatar AS expert_avatar FROM predictions p LEFT JOIN experts e ON e.id=p.expert_id ORDER BY p.id DESC"
        )
        .all();
  res.json(
    rows.map((r) => ({
      ...r,
      tags: JSON.parse(r.tags || "[]")
    }))
  );
});

app.get("/api/predictions/:id", ensureAuth, (req, res) => {
  const row = db
    .prepare(
      "SELECT p.*, e.name AS expert_name, e.avatar AS expert_avatar FROM predictions p LEFT JOIN experts e ON e.id=p.expert_id WHERE p.id=?"
    )
    .get(Number(req.params.id));
  if (!row) return res.status(404).json({ message: "内容不存在" });
  const paid = db
    .prepare("SELECT id FROM orders WHERE user_id=? AND prediction_id=? AND status='success'")
    .get(req.user.id, row.id);
  const canRead = row.is_free === 1 || !!paid;
  res.json({
    ...row,
    tags: JSON.parse(row.tags || "[]"),
    canRead,
    content: canRead ? row.content_full : null
  });
});

app.post("/api/orders/create", ensureAuth, (req, res) => {
  const schema = z.object({ predictionId: z.number() });
  const result = schema.safeParse(req.body);
  if (!result.success) return res.status(400).json({ message: "参数错误" });
  const prediction = db.prepare("SELECT * FROM predictions WHERE id=?").get(result.data.predictionId);
  if (!prediction) return res.status(404).json({ message: "内容不存在" });
  if (prediction.is_free === 1) return res.status(400).json({ message: "免费内容无需购买" });
  const r = db
    .prepare("INSERT INTO orders(user_id, prediction_id, amount, status) VALUES(?,?,?, 'pending')")
    .run(req.user.id, prediction.id, prediction.price);
  res.json({ orderId: r.lastInsertRowid, amount: prediction.price });
});

app.post("/api/orders/:id/pay", ensureAuth, (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id=? AND user_id=?").get(Number(req.params.id), req.user.id);
  if (!order) return res.status(404).json({ message: "订单不存在" });
  if (order.status === "success") return res.json({ message: "已支付" });
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if (user.balance < order.amount) return res.status(400).json({ message: "余额不足" });
  db.prepare("UPDATE users SET balance=balance-? WHERE id=?").run(order.amount, req.user.id);
  db.prepare("UPDATE orders SET status='success', paid_at=? WHERE id=?").run(new Date().toISOString(), order.id);
  res.json({ message: "支付成功" });
});

app.post("/api/recharge", ensureAuth, (req, res) => {
  const amount = Number(req.body?.amount);
  const channel = String(req.body?.channel || "manual").trim().toLowerCase();
  if (!Number.isFinite(amount) || amount < 100) return res.status(400).json({ message: "最低充值100" });
  const ch = ["wechat", "alipay", "manual"].includes(channel) ? channel : "manual";
  db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(amount, req.user.id);
  db.prepare("INSERT INTO recharges(user_id, amount, channel, status) VALUES(?,?,?,?)").run(req.user.id, amount, ch, "success");
  const user = db.prepare("SELECT id, username, avatar, balance FROM users WHERE id=?").get(req.user.id);
  res.json({ message: "充值成功", user });
});

app.get("/api/bot-unlocks", ensureAuth, (req, res) => {
  const rows = db
    .prepare("SELECT bot_key, issue, status FROM bot_unlocks WHERE user_id=? AND status='success'")
    .all(req.user.id);
  res.json(rows);
});

app.post("/api/bot-unlocks/purchase", ensureAuth, (req, res) => {
  const botKey = String(req.body?.botKey || "").trim();
  const issue = String(req.body?.issue || "").trim();
  const amount = Number(req.body?.amount ?? 88);
  if (!botKey || !issue) return res.status(400).json({ message: "参数错误" });
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ message: "金额错误" });

  const existed = db
    .prepare("SELECT id FROM bot_unlocks WHERE user_id=? AND bot_key=? AND issue=? AND status='success'")
    .get(req.user.id, botKey, issue);
  if (existed) return res.json({ message: "已解锁", unlocked: true });

  const user = db.prepare("SELECT id, balance FROM users WHERE id=?").get(req.user.id);
  if (!user) return res.status(404).json({ message: "用户不存在" });
  if (Number(user.balance || 0) < amount) return res.status(400).json({ message: "余额不足" });

  db.prepare("UPDATE users SET balance=balance-? WHERE id=?").run(amount, req.user.id);
  db.prepare("INSERT INTO bot_unlocks(user_id, bot_key, issue, amount, status) VALUES(?,?,?,?, 'success')").run(
    req.user.id,
    botKey,
    issue,
    amount
  );
  const latest = db.prepare("SELECT id, username, avatar, balance FROM users WHERE id=?").get(req.user.id);
  res.json({ message: "解锁成功", unlocked: true, user: latest });
});

/** -----------------------------
 * 简易后台管理接口（CRUD）
 * 说明：为演示后台使用，复用登录鉴权，不区分角色。
 * ----------------------------- */
app.get("/api/admin/overview", ensureAuth, (_req, res) => {
  const users = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  const experts = db.prepare("SELECT COUNT(*) AS c FROM experts").get().c;
  const orders = db.prepare("SELECT COUNT(*) AS c FROM orders").get().c;
  const paidAmount = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE status='success'").get().total;
  res.json({ users, experts, orders, paidAmount });
});

app.get("/api/admin/settings", ensureAuth, ensureAdmin, (_req, res) => {
  const row = db.prepare("SELECT value FROM app_settings WHERE key='service_wechat'").get();
  res.json({ serviceWechat: String(row?.value || "") });
});

app.put("/api/admin/settings", ensureAuth, ensureAdmin, (req, res) => {
  const serviceWechat = String(req.body?.serviceWechat || "").trim();
  db.prepare("INSERT INTO app_settings(key, value) VALUES('service_wechat', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(serviceWechat);
  res.json({ message: "设置已保存", serviceWechat });
});

app.post("/api/admin/change-password", ensureAuth, ensureAdmin, async (req, res) => {
  const oldPassword = String(req.body?.oldPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  if (!newPassword || newPassword.length < 3) return res.status(400).json({ message: "新密码至少3位" });
  const me = db.prepare("SELECT id, password_hash FROM users WHERE id=?").get(req.user.id);
  if (!me) return res.status(404).json({ message: "用户不存在" });
  const ok = await bcrypt.compare(oldPassword, me.password_hash);
  if (!ok) return res.status(400).json({ message: "旧密码错误" });
  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash, req.user.id);
  res.json({ message: "密码修改成功" });
});

app.get("/api/admin/subadmins", ensureAuth, ensureAdmin, (_req, res) => {
  const rows = db
    .prepare("SELECT id, username, role, frozen, created_at, last_login_at FROM users WHERE role IN ('admin','subadmin') ORDER BY id DESC")
    .all();
  res.json(rows);
});

app.post("/api/admin/subadmins", ensureAuth, ensureAdmin, async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const role = String(req.body?.role || "subadmin") === "admin" ? "admin" : "subadmin";
  if (!username) return res.status(400).json({ message: "请输入账号" });
  if (!password || password.length < 3) return res.status(400).json({ message: "密码至少3位" });
  const exists = db.prepare("SELECT id FROM users WHERE username=?").get(username);
  if (exists) return res.status(400).json({ message: "账号已存在" });
  const hash = await bcrypt.hash(password, 10);
  db.prepare("INSERT INTO users(username, password_hash, avatar, balance, role, frozen) VALUES(?,?,?,?,?,0)").run(
    username,
    hash,
    `https://i.pravatar.cc/100?u=${encodeURIComponent(username)}`,
    0,
    role
  );
  res.json({ message: "子账号已创建" });
});

app.put("/api/admin/subadmins/:id/password", ensureAuth, ensureAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const newPassword = String(req.body?.newPassword || "");
  if (!Number.isFinite(id)) return res.status(400).json({ message: "参数错误" });
  if (!newPassword || newPassword.length < 3) return res.status(400).json({ message: "新密码至少3位" });
  const target = db.prepare("SELECT id, role FROM users WHERE id=?").get(id);
  if (!target || !["admin", "subadmin"].includes(String(target.role || ""))) {
    return res.status(404).json({ message: "子账号不存在" });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash, id);
  res.json({ message: "子账号密码已更新" });
});

app.get("/api/admin/users", ensureAuth, (_req, res) => {
  const rows = db
    .prepare("SELECT id, username, phone, email, avatar, balance, frozen, created_at, last_login_at FROM users ORDER BY id DESC LIMIT 200")
    .all();
  res.json(rows);
});

app.put("/api/admin/users/:id/balance", ensureAuth, (req, res) => {
  const id = Number(req.params.id);
  const balance = Number(req.body?.balance);
  if (!Number.isFinite(id) || !Number.isFinite(balance) || balance < 0) {
    return res.status(400).json({ message: "参数错误" });
  }
  db.prepare("UPDATE users SET balance=? WHERE id=?").run(balance, id);
  res.json({ message: "余额已更新" });
});

app.put("/api/admin/users/:id/freeze", ensureAuth, (req, res) => {
  const id = Number(req.params.id);
  const frozen = Number(req.body?.frozen) ? 1 : 0;
  if (!Number.isFinite(id)) return res.status(400).json({ message: "参数错误" });
  db.prepare("UPDATE users SET frozen=? WHERE id=?").run(frozen, id);
  res.json({ message: frozen ? "已冻结" : "已解冻" });
});

app.delete("/api/admin/users/:id", ensureAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "参数错误" });
  if (id === Number(req.user?.id)) return res.status(400).json({ message: "不能删除当前登录账号" });
  const user = db.prepare("SELECT id FROM users WHERE id=?").get(id);
  if (!user) return res.status(404).json({ message: "用户不存在" });
  db.prepare("DELETE FROM follows WHERE user_id=?").run(id);
  db.prepare("DELETE FROM orders WHERE user_id=?").run(id);
  db.prepare("DELETE FROM recharges WHERE user_id=?").run(id);
  db.prepare("DELETE FROM users WHERE id=?").run(id);
  res.json({ message: "用户已删除" });
});

app.get("/api/admin/experts", ensureAuth, (_req, res) => {
  const rows = db.prepare("SELECT * FROM experts ORDER BY id DESC LIMIT 500").all();
  res.json(rows);
});

app.post("/api/admin/experts", ensureAuth, (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ message: "name 不能为空" });
  const avatar = String(req.body?.avatar || "").trim() || "https://i.pravatar.cc/80";
  const intro = String(req.body?.intro || "").trim();
  const rankScore = Number(req.body?.rank_score ?? 0);
  const r = db
    .prepare("INSERT INTO experts(name, avatar, verified, rank_score, intro) VALUES(?,?,?,?,?)")
    .run(name, avatar, 1, Number.isFinite(rankScore) ? rankScore : 0, intro);
  res.json({ id: r.lastInsertRowid, message: "创建成功" });
});

app.put("/api/admin/experts/:id", ensureAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "参数错误" });
  const old = db.prepare("SELECT * FROM experts WHERE id=?").get(id);
  if (!old) return res.status(404).json({ message: "专家不存在" });
  const name = String(req.body?.name ?? old.name).trim();
  const avatar = String(req.body?.avatar ?? old.avatar).trim();
  const intro = String(req.body?.intro ?? old.intro).trim();
  const rankScore = Number(req.body?.rank_score ?? old.rank_score);
  db.prepare("UPDATE experts SET name=?, avatar=?, intro=?, rank_score=? WHERE id=?").run(
    name || old.name,
    avatar || old.avatar,
    intro,
    Number.isFinite(rankScore) ? rankScore : old.rank_score,
    id
  );
  res.json({ message: "更新成功" });
});

app.delete("/api/admin/experts/:id", ensureAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "参数错误" });
  db.prepare("DELETE FROM experts WHERE id=?").run(id);
  db.prepare("DELETE FROM follows WHERE expert_id=?").run(id);
  res.json({ message: "删除成功" });
});

app.get("/api/admin/predictions", ensureAuth, (_req, res) => {
  const rows = db
    .prepare(
      "SELECT p.*, e.name AS expert_name FROM predictions p LEFT JOIN experts e ON e.id=p.expert_id ORDER BY p.id DESC LIMIT 1000"
    )
    .all();
  res.json(rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || "[]") })));
});

app.post("/api/admin/predictions", ensureAuth, (req, res) => {
  const title = String(req.body?.title || "").trim();
  if (!title) return res.status(400).json({ message: "title 不能为空" });
  const description = String(req.body?.description || "").trim();
  const category = String(req.body?.category || "精选特码🔥").trim();
  const tagsRaw = req.body?.tags;
  const tags = Array.isArray(tagsRaw) ? tagsRaw : String(tagsRaw || "").split(/[,\s，]+/).filter(Boolean);
  const isFree = Number(req.body?.is_free) ? 1 : 0;
  const price = Number(req.body?.price || 0);
  const contentFull = String(req.body?.content_full || "").trim();
  const heat = Number(req.body?.heat || 0);
  const hitStatus = String(req.body?.hit_status || "none");
  const expertId = Number(req.body?.expert_id || 1);
  const publishedAt = new Date().toISOString();
  const r = db
    .prepare(
      "INSERT INTO predictions(title, description, category, tags, is_free, price, content_full, heat, hit_status, expert_id, published_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    )
    .run(
      title,
      description,
      category,
      JSON.stringify(tags),
      isFree,
      Number.isFinite(price) ? price : 0,
      contentFull,
      Number.isFinite(heat) ? heat : 0,
      hitStatus,
      Number.isFinite(expertId) ? expertId : 1,
      publishedAt
    );
  res.json({ id: r.lastInsertRowid, message: "创建成功" });
});

app.put("/api/admin/predictions/:id", ensureAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "参数错误" });
  const old = db.prepare("SELECT * FROM predictions WHERE id=?").get(id);
  if (!old) return res.status(404).json({ message: "预测不存在" });
  const next = {
    title: String(req.body?.title ?? old.title).trim() || old.title,
    description: String(req.body?.description ?? old.description).trim(),
    category: String(req.body?.category ?? old.category).trim(),
    tags: JSON.stringify(Array.isArray(req.body?.tags) ? req.body.tags : JSON.parse(old.tags || "[]")),
    is_free: Number(req.body?.is_free ?? old.is_free) ? 1 : 0,
    price: Number(req.body?.price ?? old.price),
    content_full: String(req.body?.content_full ?? old.content_full),
    heat: Number(req.body?.heat ?? old.heat),
    hit_status: String(req.body?.hit_status ?? old.hit_status),
    expert_id: Number(req.body?.expert_id ?? old.expert_id)
  };
  db.prepare(
    "UPDATE predictions SET title=?, description=?, category=?, tags=?, is_free=?, price=?, content_full=?, heat=?, hit_status=?, expert_id=? WHERE id=?"
  ).run(
    next.title,
    next.description,
    next.category,
    next.tags,
    next.is_free,
    Number.isFinite(next.price) ? next.price : old.price,
    next.content_full,
    Number.isFinite(next.heat) ? next.heat : old.heat,
    next.hit_status,
    Number.isFinite(next.expert_id) ? next.expert_id : old.expert_id,
    id
  );
  res.json({ message: "更新成功" });
});

app.delete("/api/admin/predictions/:id", ensureAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "参数错误" });
  db.prepare("DELETE FROM predictions WHERE id=?").run(id);
  db.prepare("DELETE FROM orders WHERE prediction_id=?").run(id);
  res.json({ message: "删除成功" });
});

app.get("/api/admin/orders", ensureAuth, (_req, res) => {
  const rows = db
    .prepare(
      "SELECT o.*, u.username, p.title FROM orders o LEFT JOIN users u ON u.id=o.user_id LEFT JOIN predictions p ON p.id=o.prediction_id ORDER BY o.id DESC LIMIT 1000"
    )
    .all();
  res.json(rows);
});

app.get("/api/admin/recharges", ensureAuth, (_req, res) => {
  const rows = db
    .prepare(
      "SELECT r.*, u.username FROM recharges r LEFT JOIN users u ON u.id=r.user_id ORDER BY r.id DESC LIMIT 1000"
    )
    .all();
  res.json(rows);
});

function parseBotTxtServer(raw) {
  const text = String(raw || "").replace(/^\uFEFF/, "");
  const recentSplit = text.split(/^recent10\s*[:：]?\s*$/im);
  const head = (recentSplit[0] || "").trimEnd();
  const tail = (recentSplit[1] || "").trim();
  const bot = {
    bot_name: "",
    robotId: "",
    issue: "",
    title: "",
    prediction: "",
    recent10: []
  };
  const headLines = head.split(/\r?\n/);
  for (let i = 0; i < headLines.length; i += 1) {
    const m = headLines[i].match(/^([a-zA-Z_]+)\s*[:：]\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "bot_name") bot.bot_name = (m[2] || "").trim();
    if (key === "robotid") bot.robotId = (m[2] || "").trim();
    if (key === "issue") bot.issue = (m[2] || "").trim();
    if (key === "title") bot.title = (m[2] || "").trim();
    if (key === "prediction") {
      const parts = [m[2] || ""];
      for (let j = i + 1; j < headLines.length; j += 1) {
        if (/^([a-zA-Z_]+)\s*[:：]/.test(headLines[j])) break;
        parts.push(headLines[j]);
        i = j;
      }
      bot.prediction = parts.join("\n").trim();
    }
  }
  const tailLines = tail.split(/\r?\n/);
  for (let i = 0; i < tailLines.length; i += 1) {
    const im = tailLines[i].trim().match(/^issue\s*[:：]\s*(\d+)/i);
    if (!im) continue;
    const issue = im[1];
    const body = [];
    let j = i + 1;
    while (j < tailLines.length && !/^issue\s*[:：]\s*\d+/i.test(tailLines[j].trim())) {
      if (tailLines[j].trim()) body.push(tailLines[j].trimEnd());
      j += 1;
    }
    bot.recent10.push({ issue, body: body.join("\n").trim() });
    i = j - 1;
  }
  return bot;
}

function toBotTxtServer(spec) {
  const lines = [
    `bot_name: ${spec.bot_name || ""}`,
    `robotId: ${spec.robotId || ""}`,
    `issue: ${spec.issue || ""}`,
    `title: ${spec.title || ""}`,
    `prediction: ${String(spec.prediction || "").trim()}`,
    "",
    "recent10:"
  ];
  const recent = Array.isArray(spec.recent10) ? spec.recent10.slice(0, 10) : [];
  for (const r of recent) {
    lines.push(`issue: ${String(r.issue || "").trim()}`);
    if (String(r.body || "").trim()) lines.push(String(r.body || "").trim());
  }
  return `${lines.join("\n").trim()}\n`;
}

function randomReplaceOnePredictionNumber(text) {
  const raw = String(text || "");
  const validIndexes = [];
  let allIdx = -1;
  raw.replace(/\d+/g, (m) => {
    allIdx += 1;
    const n = Number(m);
    if (Number.isFinite(n) && n >= 1 && n <= 49) validIndexes.push(allIdx);
    return m;
  });
  if (!validIndexes.length) return { changed: false, next: raw };
  const chosenGlobalIdx = validIndexes[Math.floor(Math.random() * validIndexes.length)];
  let currentGlobalIdx = -1;
  const oldNums = (raw.match(/\d+/g) || [])
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 49);
  const oldSet = new Set(oldNums);
  let replacement = Math.floor(Math.random() * 49) + 1;
  let guard = 0;
  while ((replacement === oldNums[0] || oldSet.has(replacement)) && guard < 120) {
    replacement = Math.floor(Math.random() * 49) + 1;
    guard += 1;
  }
  const next = raw.replace(/\d+/g, (m) => {
    currentGlobalIdx += 1;
    if (currentGlobalIdx !== chosenGlobalIdx) return m;
    const oldN = Number(m);
    const pad = m.length >= 2 ? 2 : 1;
    let r = replacement;
    if (!Number.isFinite(oldN) || oldN < 1 || oldN > 49) return m;
    if (r === oldN) r = oldN === 49 ? 48 : oldN + 1;
    return String(r).padStart(pad, "0");
  });
  return { changed: next !== raw, next };
}

app.get("/api/admin/bot-experts", ensureAuth, (req, res) => {
  const bases = ["1avatar", "2avatar", "3avatar"];
  const root = path.join(__dirname, "..", "web", "public", "bots");
  const all = [];
  for (const base of bases) {
    const dir = path.join(root, base);
    const listPath = path.join(dir, "list.json");
    if (!fs.existsSync(listPath)) continue;
    let files = [];
    try {
      const list = JSON.parse(fs.readFileSync(listPath, "utf-8"));
      files = Array.isArray(list?.files) ? list.files : [];
    } catch {
      files = [];
    }
    for (const file of files) {
      const f = path.join(dir, file);
      if (!fs.existsSync(f)) continue;
      try {
        const spec = parseBotTxtServer(fs.readFileSync(f, "utf-8"));
        all.push({
          id: `${base}:${file}`,
          base,
          file,
          ...spec
        });
      } catch {
        // ignore broken file
      }
    }
  }
  res.json(all);
});

app.put("/api/admin/bot-experts/:base/:file", ensureAuth, (req, res) => {
  const base = String(req.params.base || "");
  const file = String(req.params.file || "");
  if (!["1avatar", "2avatar", "3avatar"].includes(base)) {
    return res.status(400).json({ message: "base 错误" });
  }
  if (!/^\d+\.txt$/i.test(file)) return res.status(400).json({ message: "file 错误" });
  const p = path.join(__dirname, "..", "web", "public", "bots", base, file);
  if (!fs.existsSync(p)) return res.status(404).json({ message: "机器人文件不存在" });
  const old = parseBotTxtServer(fs.readFileSync(p, "utf-8"));
  const next = {
    ...old,
    issue: String(req.body?.issue ?? old.issue ?? "").trim(),
    prediction: String(req.body?.prediction ?? old.prediction ?? "").trim(),
    recent10: Array.isArray(req.body?.recent10)
      ? req.body.recent10.map((r) => ({
          issue: String(r?.issue || "").trim(),
          body: String(r?.body || "").trim()
        })).filter((r) => r.issue)
      : old.recent10
  };
  fs.writeFileSync(p, toBotTxtServer(next), "utf-8");
  res.json({ message: "机器人内容已更新" });
});

app.post("/api/admin/bot-experts/1avatar/randomize-latest", ensureAuth, (_req, res) => {
  const base = "1avatar";
  const root = path.join(__dirname, "..", "web", "public", "bots", base);
  const listPath = path.join(root, "list.json");
  if (!fs.existsSync(listPath)) return res.status(404).json({ message: "list.json 不存在" });
  let files = [];
  try {
    const list = JSON.parse(fs.readFileSync(listPath, "utf-8"));
    files = Array.isArray(list?.files) ? list.files : [];
  } catch {
    files = [];
  }
  let changed = 0;
  for (const file of files) {
    if (!/^\d+\.txt$/i.test(String(file || ""))) continue;
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    try {
      const old = parseBotTxtServer(fs.readFileSync(p, "utf-8"));
      const result = randomReplaceOnePredictionNumber(old.prediction);
      if (!result.changed) continue;
      const next = { ...old, prediction: result.next };
      fs.writeFileSync(p, toBotTxtServer(next), "utf-8");
      changed += 1;
    } catch {
      // ignore broken file
    }
  }
  res.json({ message: `已更新 ${changed} 个精选特码机器人`, changed });
});

const distDir = path.join(__dirname, "..", "web", "dist");
const distIndex = path.join(distDir, "index.html");
const serveWeb =
  process.env.NODE_ENV === "production" && fs.existsSync(distIndex);
if (serveWeb) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      return res.status(404).json({ message: "接口不存在" });
    }
    if (req.method === "GET" || req.method === "HEAD") {
      return res.sendFile(distIndex);
    }
    return next();
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening: http://127.0.0.1:${PORT} (and http://localhost:${PORT})`);
  if (serveWeb) {
    console.log(`Serving web build from ${distDir}`);
  }
});
