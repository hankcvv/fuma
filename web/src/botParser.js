/**
 * 解析 bots/1avatar/*.txt（与 ing/1avatar 同款格式）的机器人专家配置
 */
export function parseBotTxt(raw) {
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
  let i = 0;
  while (i < headLines.length) {
    const line = headLines[i];
    const m = line.match(/^([a-zA-Z_]+)\s*[:：]\s*(.*)$/);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1].toLowerCase();
    const val = m[2] ?? "";

    if (key === "prediction") {
      const parts = [val];
      i += 1;
      while (i < headLines.length) {
        const L = headLines[i];
        const nextKey = L.match(/^([a-zA-Z_]+)\s*[:：]/);
        if (nextKey && ["bot_name", "robotid", "issue", "title", "prediction"].includes(nextKey[1].toLowerCase())) {
          break;
        }
        parts.push(L);
        i += 1;
      }
      bot.prediction = parts.join("\n").trim();
      continue;
    }

    if (key === "bot_name") bot.bot_name = val.trim();
    else if (key === "robotid") bot.robotId = val.trim();
    else if (key === "issue") bot.issue = val.trim();
    else if (key === "title") bot.title = val.trim();

    i += 1;
  }

  const tailLines = tail.split(/\r?\n/);
  let j = 0;
  while (j < tailLines.length) {
    const t = tailLines[j].trim();
    if (!t) {
      j += 1;
      continue;
    }
    const im = t.match(/^issue\s*[:：]\s*(\d+)/i);
    if (!im) {
      j += 1;
      continue;
    }
    const issueNum = im[1];
    j += 1;
    const parts = [];
    while (j < tailLines.length) {
      const L = tailLines[j];
      const tt = L.trim();
      if (/^issue\s*[:：]\s*\d+/i.test(tt)) break;
      if (tt) parts.push(L.trimEnd());
      j += 1;
    }
    bot.recent10.push({ issue: issueNum, body: parts.join("\n").trim() });
  }

  return bot;
}

/** 将 title 模板里的 * 替换为期数 issue */
export function resolveBotTitle(titleTpl, issue) {
  const n = String(issue ?? "").trim();
  let s = titleTpl || "";
  s = s.replace(/\*+/, n);
  s = s.replace(/第\*+期/g, `第${n}期`);
  return s;
}

export function botAvatarUrl(robotId, basePath = "/bots/1avatar") {
  const file = (robotId || "1.jpg").trim();
  return `${basePath.replace(/\/$/, "")}/${file}`;
}

/** 往期最早一期（含），再早的期数不再展示；使用 API expect 完整格式 */
export const BOT_PAST_ISSUE_FLOOR = 2026102;

/** 全局发榜锚点：该本地 17:30 时刻起为「第 ANCHOR_ISSUE 期」 */
const ANCHOR_PUBLISH_LOCAL = new Date(2026, 3, 20, 17, 30, 0, 0);
const ANCHOR_ISSUE = 2026110;

/** 当前本地时间之前（含）最近的一个 17:30 发榜时刻 */
export function lastPublishSlotLocal(now = new Date()) {
  const d = new Date(now);
  const y = d.getFullYear();
  const mo = d.getMonth();
  const da = d.getDate();
  const h = d.getHours();
  const mi = d.getMinutes();
  const passed1730 = h > 17 || (h === 17 && mi >= 30);
  if (passed1730) return new Date(y, mo, da, 17, 30, 0, 0);
  return new Date(y, mo, da - 1, 17, 30, 0, 0);
}

function publishSlotsBetween(anchor, slot) {
  const msDay = 86400000;
  return Math.max(0, Math.round((slot.getTime() - anchor.getTime()) / msDay));
}

/** 当前全局期数（所有机器人同一期） */
export function getCurrentBotIssue(now = new Date()) {
  const slot = lastPublishSlotLocal(now);
  return ANCHOR_ISSUE + publishSlotsBetween(ANCHOR_PUBLISH_LOCAL, slot);
}

function hashSeed(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickDistinctNums(rng, count, max = 49) {
  const set = new Set();
  while (set.size < count) {
    set.add(1 + Math.floor(rng() * max));
  }
  return [...set]
    .sort((x, y) => x - y)
    .map((n) => String(n).padStart(2, "0"));
}

/** 从标题提取 N码🀄特，限定 1-24；提取失败时默认 1 */
export function pickCodeCountFromTitle(title) {
  const m = String(title || "").match(/(\d+)\s*码/u);
  if (!m) return 1;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(24, Math.floor(n)));
}

/** 按 N码生成一期内容（与机器人、期数绑定，同一天内不变） */
export function syntheticPredictionBody(botKey, issueNum, codeCount = 1) {
  const rng = mulberry32(hashSeed(`${botKey}|pred|${issueNum}`));
  return pickDistinctNums(rng, Math.max(1, Math.min(24, codeCount))).join(" ");
}

/**
 * 卡片/详情用：统计区间、每机器人不同；期数按每日 17:30 递增；往期使用 API expect 完整格式。
 */
export function getBotRuntime(spec, now = new Date()) {
  const botKey = `${spec.bot_name || ""}|${spec.robotId || ""}`;
  const slot = lastPublishSlotLocal(now);
  const displayIssue = getCurrentBotIssue(now);
  const codeCount = pickCodeCountFromTitle(spec.title);
  const seed = hashSeed(`${botKey}|stats|${slot.getTime()}`);
  const rng = mulberry32(seed);
  // 统一在 100-600：爱心 > 眼睛 > 购物车，且差距明显。
  const likes = 430 + Math.floor(rng() * 171); // 430-600
  const views = 230 + Math.floor(rng() * 171); // 230-400
  const buys = 100 + Math.floor(rng() * 131); // 100-230
  const generatedPrediction = syntheticPredictionBody(botKey, displayIssue, codeCount);

  const pastRows = [];
  for (let iss = displayIssue - 1; iss >= BOT_PAST_ISSUE_FLOOR && pastRows.length < 5; iss -= 1) {
    pastRows.push({
      issue: String(iss),
      body: syntheticPredictionBody(botKey, iss, codeCount)
    });
  }

  const publishRand = mulberry32(hashSeed(`${botKey}|publish|${displayIssue}`));
  const startSec = 17 * 3600 + 20 * 60;
  const endSec = 18 * 3600;
  const picked = startSec + Math.floor(publishRand() * (endSec - startSec + 1));
  const h = Math.floor(picked / 3600);
  const m = Math.floor((picked % 3600) / 60);
  const s = picked % 60;
  const publishAt = new Date(slot);
  publishAt.setHours(h, m, s, 0);

  return {
    displayIssue: String(displayIssue),
    likes,
    views,
    buys,
    generatedPrediction,
    pastRows,
    publishAt
  };
}
