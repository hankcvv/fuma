const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { tx, one, execOn, oneOn, queryOn } = require("./db");

const BOT_PUBLIC_ROOT = path.join(__dirname, "..", "web", "public", "bots");

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

async function upsertBotWithRecords(conn, spec) {
  const avatarBase = `/bots/${spec.base}`;
  await execOn(
    conn,
    `INSERT INTO bots(base, file, bot_name, robot_id, issue, title, prediction, avatar_base)
     VALUES(?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE bot_name=VALUES(bot_name), robot_id=VALUES(robot_id), issue=VALUES(issue),
       title=VALUES(title), prediction=VALUES(prediction), avatar_base=VALUES(avatar_base)`,
    [spec.base, spec.file, spec.bot_name || "", spec.robotId || "", spec.issue || "", spec.title || "", spec.prediction || "", avatarBase]
  );
  const bot = await oneOn(conn, `SELECT id FROM bots WHERE base=? AND file=?`, [spec.base, spec.file]);
  if (!bot) throw new Error(`写入机器人失败: ${spec.base}/${spec.file}`);
  if (Array.isArray(spec.recent10)) {
    for (const r of spec.recent10) {
      await execOn(
        conn,
        `INSERT INTO bot_past_records(bot_id, issue, body)
         VALUES(?,?,?)
         ON DUPLICATE KEY UPDATE body=VALUES(body)`,
        [bot.id, String(r.issue || "").trim(), String(r.body || "").trim()]
      );
    }
  }
}

async function importBotsFromTxt(force = false) {
  const roots = ["1avatar", "2avatar", "3avatar"];
  await tx(async (conn) => {
    for (const base of roots) {
      const dir = path.join(BOT_PUBLIC_ROOT, base);
      const listPath = path.join(dir, "list.json");
      if (!fs.existsSync(listPath)) continue;
      const list = JSON.parse(fs.readFileSync(listPath, "utf-8"));
      const files = Array.isArray(list?.files) ? list.files : [];
      for (const file of files) {
        const full = path.join(dir, file);
        if (!fs.existsSync(full)) continue;
        const parsed = parseBotTxtServer(fs.readFileSync(full, "utf-8"));
        const existing = await oneOn(conn, `SELECT id FROM bots WHERE base=? AND file=?`, [base, file]);
        if (existing && !force) continue;
        await upsertBotWithRecords(conn, { ...parsed, base, file });
      }
    }
  });
}

async function seedIfEmpty() {
  const userCount = await one(`SELECT COUNT(*) AS c FROM users`);
  if (!Number(userCount?.c || 0)) {
    const passwordHash = await bcrypt.hash("admin123", 10);
    await tx(async (conn) => {
      await execOn(
        conn,
        `INSERT INTO users(username, password_hash, avatar, balance, role)
         VALUES('admin', ?, 'https://i.pravatar.cc/80', 9487, 'admin')`,
        [passwordHash]
      );
      const insertExperts = [];
      for (let i = 1; i <= 12; i += 1) {
        insertExperts.push(execOn(conn, `INSERT INTO experts(name, avatar, rank_score, intro) VALUES(?,?,?,?)`, [
          `专家${i}`,
          `https://i.pravatar.cc/80?img=${i + 10}`,
          100 - i,
          `这是专家${i}的简介`
        ]));
      }
      await Promise.all(insertExperts);
      const categories = ["精选特码🔥", "生肖特码🐴", "精选三中三💯"];
      for (let i = 1; i <= 45; i += 1) {
        const isFree = i % 3 === 0 ? 1 : 0;
        const price = isFree ? 0 : 88 + (i % 5) * 20;
        await execOn(
          conn,
          `INSERT INTO predictions(title, description, category, tags, is_free, price, content_full, heat, hit_status, expert_id, published_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          [
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
            new Date(Date.now() - i * 3600 * 1000)
          ]
        );
      }
    });
  }

  const botCount = await one(`SELECT COUNT(*) AS c FROM bots`);
  if (!Number(botCount?.c || 0)) {
    await importBotsFromTxt(false);
  }
}

async function importFromLegacySqlite(sqlitePath) {
  if (!sqlitePath || !fs.existsSync(sqlitePath)) return;
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch {
    return;
  }
  const legacy = new Database(sqlitePath, { readonly: true });
  const hasUsers = Number((await one(`SELECT COUNT(*) AS c FROM users`))?.c || 0) > 0;
  const hasBots = Number((await one(`SELECT COUNT(*) AS c FROM bots`))?.c || 0) > 0;
  await tx(async (conn) => {
    if (!hasUsers) {
      const users = legacy.prepare("SELECT * FROM users").all();
      for (const u of users) {
        await execOn(
          conn,
          `INSERT INTO users(username, phone, email, password_hash, avatar, balance, frozen, role, last_login_at, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE phone=VALUES(phone), email=VALUES(email), avatar=VALUES(avatar), balance=VALUES(balance),
             frozen=VALUES(frozen), role=VALUES(role), last_login_at=VALUES(last_login_at)`,
          [
            u.username,
            u.phone || null,
            u.email || null,
            u.password_hash,
            u.avatar || null,
            Number(u.balance || 0),
            Number(u.frozen || 0),
            u.role || "user",
            u.last_login_at || null,
            u.created_at || new Date()
          ]
        );
      }
      const experts = legacy.prepare("SELECT * FROM experts").all();
      for (const e of experts) {
        await execOn(conn, `INSERT INTO experts(id, name, avatar, verified, rank_score, intro, created_at)
          VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name), avatar=VALUES(avatar), verified=VALUES(verified),
          rank_score=VALUES(rank_score), intro=VALUES(intro)`, [
          e.id, e.name, e.avatar || null, Number(e.verified || 0), Number(e.rank_score || 0), e.intro || null, e.created_at || new Date()
        ]);
      }
      const predictions = legacy.prepare("SELECT * FROM predictions").all();
      for (const p of predictions) {
        await execOn(conn, `INSERT INTO predictions(id, title, description, category, tags, is_free, price, content_full, heat, hit_status, expert_id, published_at, created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title), description=VALUES(description),
          category=VALUES(category), tags=VALUES(tags), is_free=VALUES(is_free), price=VALUES(price), content_full=VALUES(content_full),
          heat=VALUES(heat), hit_status=VALUES(hit_status), expert_id=VALUES(expert_id), published_at=VALUES(published_at)`, [
          p.id, p.title, p.description || null, p.category || null, p.tags || "[]", Number(p.is_free || 0), Number(p.price || 0),
          p.content_full || null, Number(p.heat || 0), p.hit_status || "none", p.expert_id || null, p.published_at || null, p.created_at || new Date()
        ]);
      }
      for (const row of legacy.prepare("SELECT * FROM follows").all()) {
        await execOn(conn, `INSERT IGNORE INTO follows(id, user_id, expert_id, created_at) VALUES(?,?,?,?)`, [
          row.id, row.user_id, row.expert_id, row.created_at || new Date()
        ]);
      }
      for (const row of legacy.prepare("SELECT * FROM orders").all()) {
        await execOn(conn, `INSERT INTO orders(id, user_id, prediction_id, amount, status, paid_at, created_at)
          VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE amount=VALUES(amount), status=VALUES(status), paid_at=VALUES(paid_at)`, [
          row.id, row.user_id, row.prediction_id, Number(row.amount || 0), row.status || "pending", row.paid_at || null, row.created_at || new Date()
        ]);
      }
      for (const row of legacy.prepare("SELECT * FROM recharges").all()) {
        await execOn(conn, `INSERT INTO recharges(id, user_id, amount, channel, status, created_at)
          VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE amount=VALUES(amount), channel=VALUES(channel), status=VALUES(status)`, [
          row.id, row.user_id, Number(row.amount || 0), row.channel || "manual", row.status || "success", row.created_at || new Date()
        ]);
      }
      for (const row of legacy.prepare("SELECT * FROM bot_unlocks").all()) {
        await execOn(conn, `INSERT IGNORE INTO bot_unlocks(id, user_id, bot_key, issue, amount, status, created_at)
          VALUES(?,?,?,?,?,?,?)`, [
          row.id, row.user_id, row.bot_key, row.issue, Number(row.amount || 0), row.status || "success", row.created_at || new Date()
        ]);
      }
      for (const row of legacy.prepare("SELECT * FROM app_settings").all()) {
        await execOn(conn, `INSERT INTO app_settings(\`key\`, \`value\`) VALUES(?,?) ON DUPLICATE KEY UPDATE \`value\`=VALUES(\`value\`)`, [
          row.key, row.value || ""
        ]);
      }
    }
    if (!hasBots) {
      await importBotsFromTxt(false);
    }
  });
  legacy.close();
}

module.exports = {
  parseBotTxtServer,
  importBotsFromTxt,
  importFromLegacySqlite,
  seedIfEmpty,
  upsertBotWithRecords
};
