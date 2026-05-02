import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Divider,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  message
} from "antd";
import "antd/dist/reset.css";
import { getBotRuntime } from "./botParser.js";

const API = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");
const BOT_PAST_PERIODS = 5;
function nextBotIssueFromLive(liveIssue, now = new Date()) {
  const n = Number(String(liveIssue || "").replace(/\D/g, ""));
  if (!Number.isFinite(n) || n <= 0) return "";
  const h = now.getHours();
  const m = now.getMinutes();
  const after1730 = h > 17 || (h === 17 && m >= 30);
  return String(after1730 ? n + 1 : n);
}

function fixedWinRateForBot(spec) {
  const s = `${spec?.base || ""}|${spec?.robotId || ""}|${spec?.bot_name || ""}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return 85 + ((h >>> 0) % 15); // 85-99
}

function useAdminApi(token) {
  const withAuth = async (path, options = {}) => {
    const maxAttempts = 2;
    let lastErr = null;
    for (let i = 0; i < maxAttempts; i += 1) {
      try {
        const res = await fetch(`${API}${path}`, {
          cache: "no-store",
          ...options,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...(options.headers || {})
          }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const err = new Error(data.message || `HTTP ${res.status}`);
          // 后台偶发 502/503 时自动重试一次
          if ((res.status === 502 || res.status === 503) && i + 1 < maxAttempts) {
            await new Promise((r) => setTimeout(r, 450));
            continue;
          }
          throw err;
        }
        return data;
      } catch (e) {
        lastErr = e;
        if (i + 1 < maxAttempts) {
          await new Promise((r) => setTimeout(r, 450));
          continue;
        }
      }
    }
    throw lastErr || new Error("请求失败");
  };
  return { withAuth };
}

async function fetchJsonRetry(url, attempts = 2) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      return data;
    } catch (e) {
      lastErr = e;
      if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 450));
    }
  }
  throw lastErr || new Error("请求失败");
}

function pad2(n) {
  return String(Number(n)).padStart(2, "0");
}

/** 与后台 / 开奖接口解析一致 */
function parseHistoryDraw(payload) {
  const row = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!row) return null;
  const open = String(row.openCode || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x));
  const zods = String(row.zodiac || "")
    .split(/[,\s，]+/u)
    .map((x) => x.trim())
    .filter(Boolean);
  return {
    lastNum: open.length ? open[open.length - 1] : null,
    first6: open.slice(0, 6),
    lastZodiac: zods.length ? zods[zods.length - 1] : ""
  };
}

function combinations3From6(nums) {
  const a = (nums || [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 49)
    .slice(0, 6);
  if (a.length < 3) return [];
  const out = [];
  for (let i = 0; i < a.length; i += 1)
    for (let j = i + 1; j < a.length; j += 1)
      for (let k = j + 1; k < a.length; k += 1) out.push([a[i], a[j], a[k]].sort((x, y) => x - y));
  return out;
}

/** 为每个机器人分配一组三码；前 min(n,20) 组尽量互不重复，超出部分按使用次数最少优先 */
function assignTriplesPerRobot(first6, robotCount) {
  const combos = combinations3From6(first6);
  if (!combos.length || robotCount <= 0) return [];
  const shuffled = [...combos].sort(() => Math.random() - 0.5);
  const usage = new Map();
  const keyOf = (t) => `${pad2(t[0])}-${pad2(t[1])}-${pad2(t[2])}`;
  const result = [];
  for (let i = 0; i < robotCount; i += 1) {
    if (i < shuffled.length) {
      const t = shuffled[i];
      result.push([...t]);
      usage.set(keyOf(t), (usage.get(keyOf(t)) || 0) + 1);
    } else {
      let best = combos[0];
      let bestUsed = Infinity;
      for (const c of combos) {
        const u = usage.get(keyOf(c)) || 0;
        if (u < bestUsed) {
          bestUsed = u;
          best = c;
        }
      }
      const t = [...best];
      result.push(t);
      usage.set(keyOf(t), (usage.get(keyOf(t)) || 0) + 1);
    }
  }
  return result;
}

/** 三中三付费串：每组内三码升序，组与组之间按数值序排列；支持「.」或空格分隔 */
function sortThreeAvatarPaidBody(raw) {
  const s = String(raw || "").trim();
  if (!s) return s;
  const dot = s.includes(".");
  const chunks = dot
    ? s.split(".").map((x) => x.trim()).filter(Boolean)
    : s.split(/\s+/).map((x) => x.trim()).filter(Boolean);
  const groups = [];
  const rest = [];
  for (const chunk of chunks) {
    const m = chunk.match(/^(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (!m) {
      rest.push(chunk);
      continue;
    }
    const key = [Number(m[1]), Number(m[2]), Number(m[3])].sort((x, y) => x - y);
    groups.push({ display: key.map(pad2).join("-"), key });
  }
  groups.sort((a, b) => {
    for (let i = 0; i < 3; i += 1) {
      if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    }
    return 0;
  });
  const sep = dot ? "." : " ";
  return [...groups.map((g) => g.display), ...rest].join(sep);
}

export default function AdminApp() {
  const [token, setToken] = useState(localStorage.getItem("admin_token") || "");
  const [adminRole, setAdminRole] = useState(() => localStorage.getItem("admin_role") || "");
  const [loading, setLoading] = useState(false);
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [orderRecords, setOrderRecords] = useState([]);
  const [subAdmins, setSubAdmins] = useState([]);
  const [serviceWechat, setServiceWechat] = useState("");
  const [rewardRanges, setRewardRanges] = useState({
    "1avatar": { min: "1880", max: "2580" },
    "2avatar": { min: "1880", max: "2580" },
    "3avatar": { min: "1880", max: "2580" }
  });
  const [robotExperts, setRobotExperts] = useState([]);
  const [expertType, setExpertType] = useState("all");
  const [botEditorOpen, setBotEditorOpen] = useState(false);
  const [editingBot, setEditingBot] = useState(null);
  const [latestIssue, setLatestIssue] = useState("");
  const [latestPrediction, setLatestPrediction] = useState("");
  const [recent10Text, setRecent10Text] = useState("");
  const [balanceEditorOpen, setBalanceEditorOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [editingBalance, setEditingBalance] = useState("");
  const [savingBot, setSavingBot] = useState(false);
  const [savingBalance, setSavingBalance] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdOld, setPwdOld] = useState("");
  const [pwdNew, setPwdNew] = useState("");
  const [pwdSaving, setPwdSaving] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [subUser, setSubUser] = useState("");
  const [subPass, setSubPass] = useState("");
  const [subSaving, setSubSaving] = useState(false);
  /** 往期批量：按版面分三块，写入库内 recent10 */
  const [batchPast, setBatchPast] = useState({
    "1avatar": { issue: "", num: "", selectedIds: [] },
    "2avatar": { issue: "", num: "", zodiac: "", selectedIds: [] },
    "3avatar": { issue: "", first6Nums: [], selectedIds: [] }
  });
  const [batchPastSaving, setBatchPastSaving] = useState(null);
  const [loginForm] = Form.useForm();
  const { withAuth } = useAdminApi(token);
  const filteredRobotExperts = useMemo(() => {
    if (expertType === "all") return robotExperts;
    return (robotExperts || []).filter((x) => String(x.base || "") === expertType);
  }, [robotExperts, expertType]);
  const issueOptionsForBase = (base) => {
    const rows = (robotExperts || []).filter((x) => x.base === base);
    const set = new Set();
    for (const r of rows) {
      if (r.latestIssue) set.add(String(r.latestIssue));
      for (const p of (r.effectiveRecent10 || r.recent10 || [])) {
        if (p?.issue) set.add(String(p.issue));
      }
    }
    return [...set].sort((a, b) => Number(b) - Number(a));
  };

  const patchBatchPast = (base, patch) => {
    setBatchPast((p) => ({ ...p, [base]: { ...p[base], ...patch } }));
  };

  const rowsForBatchBase = (base) => (robotExperts || []).filter((x) => x.base === base);

  const issue1 = batchPast["1avatar"].issue;
  const issue2 = batchPast["2avatar"].issue;
  const issue3 = batchPast["3avatar"].issue;

  useEffect(() => {
    const issue = String(issue1 || "").trim();
    if (!issue) {
      patchBatchPast("1avatar", { num: "" });
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const payload = await fetchJsonRetry(`${API}/macau-history/${encodeURIComponent(issue)}`);
        if (cancelled) return;
        const draw = parseHistoryDraw(payload);
        patchBatchPast("1avatar", { num: draw?.lastNum != null ? String(draw.lastNum) : "" });
      } catch {
        if (!cancelled) patchBatchPast("1avatar", { num: "" });
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [issue1]);

  useEffect(() => {
    const issue = String(issue2 || "").trim();
    if (!issue) {
      patchBatchPast("2avatar", { num: "", zodiac: "" });
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const payload = await fetchJsonRetry(`${API}/macau-history/${encodeURIComponent(issue)}`);
        if (cancelled) return;
        const draw = parseHistoryDraw(payload);
        patchBatchPast("2avatar", {
          num: draw?.lastNum != null ? String(draw.lastNum) : "",
          zodiac: draw?.lastZodiac ? String(draw.lastZodiac) : ""
        });
      } catch {
        if (!cancelled) patchBatchPast("2avatar", { num: "", zodiac: "" });
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [issue2]);

  useEffect(() => {
    const issue = String(issue3 || "").trim();
    if (!issue) {
      patchBatchPast("3avatar", { first6Nums: [] });
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const payload = await fetchJsonRetry(`${API}/macau-history/${encodeURIComponent(issue)}`);
        if (cancelled) return;
        const draw = parseHistoryDraw(payload);
        const f6 = Array.isArray(draw?.first6)
          ? draw.first6.filter((n) => Number.isFinite(Number(n))).map((n) => Number(n)).slice(0, 6)
          : [];
        patchBatchPast("3avatar", { first6Nums: f6 });
      } catch {
        if (!cancelled) patchBatchPast("3avatar", { first6Nums: [] });
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [issue3]);

  const applyBatchPastForBase = async (base) => {
    const cfg = batchPast[base];
    const issue = String(cfg.issue || "").trim();
    if (!issue) {
      message.error("请选择期数");
      return;
    }
    const targets = rowsForBatchBase(base).filter((r) => cfg.selectedIds.includes(r.id));
    if (!targets.length) {
      message.error("请至少勾选一个机器人");
      return;
    }
    let nextNum = Number(cfg.num);
    if (base === "1avatar" || base === "2avatar") {
      if (!Number.isFinite(nextNum) || nextNum < 1 || nextNum > 49) {
        message.error("未拉取到开奖特码或号码无效，请重选期数");
        return;
      }
      nextNum = Math.floor(nextNum);
    }
    if (base === "2avatar" && !String(cfg.zodiac || "").trim()) {
      message.error("未拉取到开奖生肖，请重选期数或稍后重试");
      return;
    }
    let triplesPlan = null;
    if (base === "3avatar") {
      let first6 = Array.isArray(cfg.first6Nums) ? cfg.first6Nums : [];
      if (first6.length < 3) {
        try {
          const payload = await fetchJsonRetry(`${API}/macau-history/${encodeURIComponent(issue)}`);
          const draw = parseHistoryDraw(payload);
          first6 = Array.isArray(draw?.first6)
            ? draw.first6.filter((n) => Number.isFinite(Number(n))).map((n) => Number(n)).slice(0, 6)
            : [];
        } catch {
          first6 = [];
        }
      }
      if (first6.length < 3) {
        message.error("该期开奖前区不足 6 个号码，无法批量三中三");
        return;
      }
      triplesPlan = assignTriplesPerRobot(first6, targets.length);
    }
    try {
      setBatchPastSaving(base);
      let idx3 = 0;
      for (const row of targets) {
        const oldRecent = Array.isArray(row.recent10) ? row.recent10 : [];
        const recent10 = oldRecent.map((r) => ({ issue: String(r.issue || ""), body: String(r.body || "") }));
        const idx = recent10.findIndex((r) => normalizeIssueKey(r.issue) === normalizeIssueKey(issue));
        const sourceBody = idx >= 0 ? recent10[idx].body : String(row.effectivePrediction || row.prediction || "");
        let nextBody = sourceBody;
        if (base === "1avatar") {
          nextBody = replaceOneNum(sourceBody, nextNum);
        } else if (base === "2avatar") {
          const zod = String(cfg.zodiac || "").trim();
          const mode = Math.floor(Math.random() * 3);
          if (mode === 0) {
            nextBody = replaceOneZodiac(sourceBody, zod);
          } else if (mode === 1) {
            nextBody = replaceOneNum(sourceBody, nextNum);
          } else {
            nextBody = replaceOneNum(replaceOneZodiac(sourceBody, zod), nextNum);
          }
        } else {
          const t = triplesPlan[idx3];
          idx3 += 1;
          nextBody = sortThreeAvatarPaidBody(replaceOneThreeGroup(sourceBody, t[0], t[1], t[2]));
        }
        if (idx >= 0) recent10[idx] = { ...recent10[idx], body: nextBody };
        else recent10.unshift({ issue: String(issue), body: nextBody });
        const cleanedRecent10 = recent10
          .filter((r) => String(r.issue || "").trim())
          .slice(0, BOT_PAST_PERIODS);
        await withAuth(`/admin/bot-experts/${row.base}/${row.file}`, {
          method: "PUT",
          body: JSON.stringify({
            issue: String(row.latestIssue || row.issue || ""),
            prediction: String(row.effectivePrediction || row.prediction || ""),
            recent10: cleanedRecent10
          })
        });
      }
      message.success(`已更新 ${targets.length} 个「${base === "1avatar" ? "精选特码" : base === "2avatar" ? "生肖特码" : "精选三中三"}」机器人在第 ${issue} 期的往期`);
      patchBatchPast(base, { selectedIds: [] });
      await loadAll();
    } catch (e) {
      message.error(e.message || "批量修改失败");
    } finally {
      setBatchPastSaving(null);
    }
  };
  const replaceOneNum = (text, targetNum) => {
    const raw = String(text || "");
    const target = Number(targetNum);
    if (!Number.isFinite(target) || target < 1 || target > 49) return raw;
    const all = [...raw.matchAll(/\d+/g)];
    const idxs = all
      .map((m, i) => ({ i, n: Number(m[0]), pad: String(m[0]).length >= 2 ? 2 : 1 }))
      .filter((x) => Number.isFinite(x.n) && x.n >= 1 && x.n <= 49);
    if (!idxs.length) return raw;
    // 目标数字已存在则不再修改
    if (idxs.some((x) => x.n === target)) return raw;
    const pick = idxs[Math.floor(Math.random() * idxs.length)];
    let k = -1;
    return raw.replace(/\d+/g, (m) => {
      k += 1;
      if (k !== pick.i) return m;
      return String(target).padStart(pick.pad, "0");
    });
  };
  const replaceOneZodiac = (text, zodiac) => {
    const raw = String(text || "");
    const target = String(zodiac || "").trim();
    if (!target) return raw;
    if (raw.includes(target)) return raw;
    // 兼容简繁体：鸡/雞、马/馬、龙/龍、猪/豬
    const all = [...raw.matchAll(/[鼠牛虎兔龙龍蛇马馬羊猴鸡雞狗猪豬]/g)];
    if (!all.length) return raw;
    const pick = Math.floor(Math.random() * all.length);
    let k = -1;
    return raw.replace(/[鼠牛虎兔龙龍蛇马馬羊猴鸡雞狗猪豬]/g, (m) => {
      k += 1;
      if (k !== pick) return m;
      return target;
    });
  };
  const format2 = (n) => String(Number(n)).padStart(2, "0");
  const replaceOneNumToHit = (text, targetNum) => {
    const raw = String(text || "");
    const target = Number(targetNum);
    if (!Number.isFinite(target) || target < 1 || target > 49) return raw;
    const all = [...raw.matchAll(/\d+/g)];
    const idxs = all
      .map((m, i) => ({ i, n: Number(m[0]), pad: String(m[0]).length >= 2 ? 2 : 1 }))
      .filter((x) => Number.isFinite(x.n) && x.n >= 1 && x.n <= 49);
    if (!idxs.length) return raw;
    if (idxs.some((x) => x.n === target)) return raw;
    const pick = idxs[Math.floor(Math.random() * idxs.length)];
    let k = -1;
    return raw.replace(/\d+/g, (m) => {
      k += 1;
      if (k !== pick.i) return m;
      return String(target).padStart(pick.pad, "0");
    });
  };
  const ensureOneThreeGroupHit = (text, first6) => {
    const raw = String(text || "").trim();
    const nums = (Array.isArray(first6) ? first6 : [])
      .map((n) => format2(n))
      .filter(Boolean);
    if (nums.length < 3) return raw;
    const first6Set = new Set(nums);
    const groups = raw
      .split(/\s+/)
      .map((g) => g.split("-").map((x) => format2(x)).filter(Boolean))
      .filter((arr) => arr.length === 3);
    const hasHit = groups.some((g) => g.every((n) => first6Set.has(n)));
    if (hasHit) return raw;
    const hitPool = [...new Set(nums)];
    const shuffled = hitPool.sort(() => Math.random() - 0.5);
    const pick3 = shuffled.slice(0, 3).map((x) => Number(x)).sort((a, b) => a - b).map((x) => format2(x));
    const nextGroup = pick3.join("-");
    if (!groups.length) return nextGroup;
    const targetIdx = Math.floor(Math.random() * groups.length);
    const groupTexts = raw.split(/\s+/);
    if (groupTexts[targetIdx]) groupTexts[targetIdx] = nextGroup;
    return groupTexts.join(" ");
  };
  const replaceOneThreeGroup = (text, a, b, c) => {
    const raw = String(text || "");
    const groupRe = /\d{1,2}\s*-\s*\d{1,2}\s*-\s*\d{1,2}/g;
    const matches = [...raw.matchAll(groupRe)];
    const nextGroup = `${format2(a)}-${format2(b)}-${format2(c)}`;
    if (raw.includes(nextGroup)) return raw;
    if (!matches.length) return raw;
    const pick = Math.floor(Math.random() * matches.length);
    let k = -1;
    return raw.replace(groupRe, (m) => {
      k += 1;
      if (k !== pick) return m;
      return nextGroup;
    });
  };

  const isZodiacBot = (b) => b.base === "2avatar";
  const isThreeBot = (b) => b.base === "3avatar";

  const normalizeIssueKey = (s) => {
    const d = String(s ?? "").replace(/\D/g, "");
    if (!d) return "";
    return d.length >= 7 ? d : d.length > 5 ? d.slice(-5) : d;
  };
  const findRowForIssue = (rows, issue) => {
    const key = normalizeIssueKey(issue);
    return (rows || []).find((r) => {
      const k = normalizeIssueKey(r?.expect);
      return k === key || k.endsWith(key) || key.endsWith(k);
    }) || null;
  };
  const lastOpenCodeNumber = (openCode) => {
    const parts = String(openCode || "").split(",").map((x) => x.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  };
  const lastZodiacValue = (zodiacStr) => {
    const parts = String(zodiacStr || "").split(/[,\s，]+/u).map((x) => x.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  };
  const robotContainsOpenNumber = (predictionText, lastNumStr) => {
    if (lastNumStr == null) return false;
    const target = parseInt(String(lastNumStr), 10);
    if (!Number.isFinite(target)) return false;
    const nums = new Set();
    const re = /\d+/g;
    const s = String(predictionText || "");
    let m;
    while ((m = re.exec(s)) !== null) {
      const n = parseInt(m[0], 10);
      if (n >= 1 && n <= 49) nums.add(n);
    }
    return nums.has(target);
  };
  const paidDotsHitOpenLast = (predictionText, openCodeLastStr) => robotContainsOpenNumber(predictionText, openCodeLastStr);
  const openCodeFirst6Set = (openCode) => {
    const set = new Set();
    String(openCode || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 6)
      .forEach((p) => {
        const n = parseInt(p, 10);
        if (Number.isFinite(n)) set.add(String(n).padStart(2, "0"));
      });
    return set;
  };
  const parseThreeGroups = (predictionText) =>
    String(predictionText || "")
      .trim()
      .split(/\s+/)
      .map((g) => g.split("-").map((x) => x.trim()).filter(Boolean))
      .filter((arr) => arr.length === 3);
  const threeHitByFirst6 = (openCode, predictionText) => {
    const first6 = openCodeFirst6Set(openCode);
    if (!first6.size) return false;
    const groups = parseThreeGroups(predictionText);
    return groups.some((nums) => nums.every((n) => first6.has(String(parseInt(n, 10)).padStart(2, "0"))));
  };
  const ZODIAC_POOL = ["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"];
  const seededRng = (seedText) => {
    let s = 0;
    const t = String(seedText || "");
    for (let i = 0; i < t.length; i += 1) s = ((s * 131) + t.charCodeAt(i)) >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };
  const pickDistinct = (pool, count, rng) => {
    const arr = [...pool];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr.slice(0, Math.max(1, Math.min(count, arr.length)));
  };
  const parseZodiacCounts = (spec) => {
    const title = String(spec?.title || "");
    const pred = String(spec?.prediction || "");
    const m = title.match(/(\d+)\s*肖\D*(\d+)\s*码/u);
    if (m) return { zCount: Math.max(1, Number(m[1])), nCount: Math.max(1, Number(m[2])) };
    const zCount = (pred.split(/[，,\s]+/).filter((x) => x && !/\d/.test(x)).length) || 3;
    const nCount = ((pred.match(/\d+/g) || []).length) || 6;
    return { zCount, nCount };
  };
  const parseThreeGroupCount = (spec) => {
    const title = String(spec?.title || "");
    const m = title.match(/(\d+)\s*组/u);
    if (m) return Math.max(1, Number(m[1]));
    const groups = String(spec?.prediction || "").trim().split(/\s+/).filter(Boolean);
    return Math.max(1, groups.length || 3);
  };
  const generatedPredictionByType = (spec, issue) => {
    const issueText = String(issue || "");
    if (isZodiacBot(spec)) {
      const { zCount, nCount } = parseZodiacCounts(spec);
      const rng = seededRng(`${spec?.bot_name || ""}|${spec?.robotId || ""}|zodiac|${issueText}`);
      const zods = pickDistinct(ZODIAC_POOL, zCount, rng);
      const nums = pickDistinct(Array.from({ length: 49 }, (_, i) => String(i + 1).padStart(2, "0")), nCount, rng)
        .map((x) => Number(x))
        .sort((a, b) => a - b)
        .map((x) => String(x).padStart(2, "0"));
      return `${zods.join("，")}，${nums.join(",")}`;
    }
    if (isThreeBot(spec)) {
      const groupCount = parseThreeGroupCount(spec);
      const rng = seededRng(`${spec?.bot_name || ""}|${spec?.robotId || ""}|three|${issueText}`);
      const all = Array.from({ length: 49 }, (_, i) => String(i + 1).padStart(2, "0"));
      const groups = [];
      for (let i = 0; i < groupCount; i += 1) {
        const pick = pickDistinct(all, 3, rng).map((x) => Number(x)).sort((a, b) => a - b).map((x) => String(x).padStart(2, "0"));
        groups.push(pick.join("-"));
      }
      return groups.join(" ");
    }
    return String(spec?.prediction || "");
  };

  const buildContiguousPastRows = (displayIssue, latestPrediction, candidateRows = [], limit = BOT_PAST_PERIODS) => {
    const issueNum = Number(String(displayIssue || "").replace(/\D/g, ""));
    if (!Number.isFinite(issueNum) || issueNum <= 0) return [];
    const bodyByIssue = new Map();
    const bodyByNormIssue = new Map();
    for (const r of candidateRows || []) {
      const k = String(r?.issue || "").trim();
      if (!k) continue;
      const body = String(r?.body || "").trim();
      bodyByIssue.set(k, body);
      const nk = normalizeIssueKey(k);
      if (nk) bodyByNormIssue.set(nk, body);
    }
    const out = [];
    for (let i = 1; i <= limit; i += 1) {
      const iss = String(issueNum - i);
      const norm = normalizeIssueKey(iss);
      out.push({ issue: iss, body: bodyByIssue.get(iss) || bodyByNormIssue.get(norm) || String(latestPrediction || "—") });
    }
    return out;
  };

  const loadRobotExperts = async () => {
    // 先保证后台编辑列表能出来，开奖接口失败时只影响胜率/红黑，不阻断整表。
    let rows = await withAuth("/admin/bot-experts").catch(() => null);
    if (!Array.isArray(rows)) {
      // 兜底：如果后台接口偶发失败，直接取三版面机器人，保证“专家”页有全量数据。
      const [g1, g2, g3] = await Promise.all([
        fetchJsonRetry(`${API}/bots/1avatar`).catch(() => []),
        fetchJsonRetry(`${API}/bots/2avatar`).catch(() => []),
        fetchJsonRetry(`${API}/bots/3avatar`).catch(() => [])
      ]);
      rows = [...(Array.isArray(g1) ? g1 : []), ...(Array.isArray(g2) ? g2 : []), ...(Array.isArray(g3) ? g3 : [])];
    }
    if (!Array.isArray(rows) || !rows.length) return robotExperts;
    const liveRows = await fetchJsonRetry(`${API}/macau-jc`).catch(() => []);
    const liveIssue = String(liveRows?.[0]?.expect || "");
    const publishIssue = nextBotIssueFromLive(liveIssue, new Date());
    const allIssues = new Set();
    const working = rows.map((spec) => {
      const zodiac = isZodiacBot(spec);
      const three = isThreeBot(spec);
      const rt = zodiac || three ? null : getBotRuntime(spec, new Date());
      const displayIssue = String(publishIssue || liveIssue || spec.issue || rt?.displayIssue || "");
      const issueMatch = normalizeIssueKey(spec.issue) === normalizeIssueKey(displayIssue);
      const displayPred = String(
        isZodiacBot(spec) || isThreeBot(spec)
          ? ((issueMatch && spec.prediction) ? spec.prediction : generatedPredictionByType(spec, displayIssue))
          : (spec.prediction || rt?.generatedPrediction || "")
      );
      const candidates = [
        ...((rt?.pastRows || []).map((r) => ({ issue: String(r.issue || ""), body: String(r.body || "") }))),
        ...(isZodiacBot(spec) || isThreeBot(spec)
          ? Array.from({ length: 10 }, (_, idx) => {
              const iss = String(Number(displayIssue) - (idx + 1));
              return { issue: iss, body: generatedPredictionByType(spec, iss) };
            })
          : []),
        ...(Array.isArray(spec.recent10) ? spec.recent10 : [])
      ];
      const syncedPast = buildContiguousPastRows(displayIssue, displayPred, candidates, BOT_PAST_PERIODS);
      const periodRows = [{ issue: displayIssue, body: displayPred }, ...syncedPast];
      periodRows.forEach((r) => r?.issue && allIssues.add(String(r.issue)));
      return { ...spec, displayIssue, displayPred, periodRows };
    });

    const historyMap = {};
    await Promise.all(
      [...allIssues].map(async (issue) => {
        const rowFromLive = findRowForIssue(liveRows, issue);
        if (rowFromLive) {
          historyMap[issue] = rowFromLive;
          return;
        }
        try {
          const payload = await fetchJsonRetry(`${API}/macau-history/${encodeURIComponent(issue)}`).catch(() => ({}));
          historyMap[issue] = Array.isArray(payload?.data) ? payload.data[0] || null : null;
        } catch {
          historyMap[issue] = null;
        }
      })
    );

    const all = working.map((spec) => {
      let hits = 0;
      let loaded = 0;
      const currentIssueNum = Number(String(spec.displayIssue || "").replace(/\D/g, ""));
      const prevIssue = Number.isFinite(currentIssueNum) && currentIssueNum > 0 ? String(currentIssueNum - 1) : "";
      const prevDraw = prevIssue ? (historyMap[prevIssue] ?? findRowForIssue(liveRows, prevIssue) ?? null) : null;
      let prevHit = null;
      for (const row of spec.periodRows) {
        const draw = historyMap[row.issue] ?? null;
        if (!draw) continue;
        loaded += 1;
        const lastNum = lastOpenCodeNumber(draw.openCode);
        const lastZod = lastZodiacValue(draw.zodiac);
        const hit = isThreeBot(spec)
          ? threeHitByFirst6(draw.openCode, row.body)
          : isZodiacBot(spec)
            ? ((lastNum != null && paidDotsHitOpenLast(row.body, lastNum)) || (!!lastZod && String(row.body || "").includes(lastZod)))
            : (lastNum != null && paidDotsHitOpenLast(row.body, lastNum));
        if (prevIssue && row.issue === prevIssue) prevHit = hit;
        if (hit) hits += 1;
      }
      // 专家胜率统一固定在 85-99 区间展示。
      const winRate = fixedWinRateForBot(spec);
      return {
        ...spec,
        id: `${spec.base}:${spec.file}`,
        name: spec.bot_name,
        winRate,
        latestIssue: spec.displayIssue,
        latestContent: String(spec.displayPred || "—").slice(0, 90),
        latestStamp: prevDraw ? (prevHit ? "hit" : "miss") : "pending",
        effectivePrediction: spec.displayPred || "",
        effectiveRecent10: spec.periodRows.slice(1, BOT_PAST_PERIODS + 1)
      };
    });
    setRobotExperts(all);
    return all;
  };

  const loadAll = async () => {
    if (!token) return;
    setLoading(true);
    const errMsg = (r, title) => (r.status === "rejected" ? r.reason?.message || "请求失败" : "");
    const [o, u, od, sa, st] = await Promise.allSettled([
      withAuth("/admin/overview"),
      withAuth("/admin/users"),
      withAuth("/admin/orders"),
      withAuth("/admin/subadmins"),
      withAuth("/admin/settings")
    ]);
    if (o.status === "fulfilled") setOverview(o.value);
    else message.error(`数据概览：${errMsg(o)}`);
    if (u.status === "fulfilled") {
      const v = u.value;
      if (Array.isArray(v)) setUsers(v);
      else {
        setUsers([]);
        message.warning("用户列表返回格式异常");
      }
    } else message.error(`用户列表：${errMsg(u)}`);
    if (od.status === "fulfilled") {
      const v = od.value;
      if (Array.isArray(v)) setOrderRecords(v);
      else {
        setOrderRecords([]);
        message.warning("订单记录返回格式异常");
      }
    } else message.error(`购买记录：${errMsg(od)}`);
    if (sa.status === "fulfilled") {
      const v = sa.value;
      if (Array.isArray(v)) setSubAdmins(v);
      else {
        setSubAdmins([]);
        message.warning("子账号列表返回格式异常");
      }
    } else message.error(`子账号：${errMsg(sa)}`);
    if (st.status === "fulfilled") {
      setServiceWechat(String(st.value?.serviceWechat || ""));
      const ranges = st.value?.rewardRanges || {};
      const fallbackMin = String(st.value?.rewardMin ?? 1880);
      const fallbackMax = String(st.value?.rewardMax ?? 2580);
      setRewardRanges({
        "1avatar": {
          min: String(ranges?.["1avatar"]?.min ?? fallbackMin),
          max: String(ranges?.["1avatar"]?.max ?? fallbackMax)
        },
        "2avatar": {
          min: String(ranges?.["2avatar"]?.min ?? fallbackMin),
          max: String(ranges?.["2avatar"]?.max ?? fallbackMax)
        },
        "3avatar": {
          min: String(ranges?.["3avatar"]?.min ?? fallbackMin),
          max: String(ranges?.["3avatar"]?.max ?? fallbackMax)
        }
      });
    } else message.error(`系统设置：${errMsg(st)}`);
    try {
      const botRows = await loadRobotExperts();
      if (!Array.isArray(botRows)) {
        setRobotExperts((prev) => prev || []);
      }
    } catch (e) {
      message.error(`专家机器人：${e.message || "加载失败"}`);
      setRobotExperts((prev) => prev || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, [token]);

  const saveRewardRangeByBase = async (base) => {
    const curr = rewardRanges?.[base] || {};
    const min = Number(curr.min);
    const max = Number(curr.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) {
      message.error("请输入有效金额区间");
      return;
    }
    const normalized = {
      min: Math.min(Math.floor(min), Math.floor(max)),
      max: Math.max(Math.floor(min), Math.floor(max))
    };
    const bodyRanges = {
      "1avatar": {
        min: Number(rewardRanges?.["1avatar"]?.min || 1880),
        max: Number(rewardRanges?.["1avatar"]?.max || 2580)
      },
      "2avatar": {
        min: Number(rewardRanges?.["2avatar"]?.min || 1880),
        max: Number(rewardRanges?.["2avatar"]?.max || 2580)
      },
      "3avatar": {
        min: Number(rewardRanges?.["3avatar"]?.min || 1880),
        max: Number(rewardRanges?.["3avatar"]?.max || 2580)
      }
    };
    bodyRanges[base] = normalized;
    const data = await withAuth("/admin/settings", {
      method: "PUT",
      body: JSON.stringify({
        serviceWechat: String(serviceWechat || "").trim(),
        rewardMin: normalized.min,
        rewardMax: normalized.max,
        rewardRanges: bodyRanges
      })
    });
    const nextRanges = data?.rewardRanges || bodyRanges;
    setRewardRanges({
      "1avatar": {
        min: String(nextRanges?.["1avatar"]?.min ?? bodyRanges["1avatar"].min),
        max: String(nextRanges?.["1avatar"]?.max ?? bodyRanges["1avatar"].max)
      },
      "2avatar": {
        min: String(nextRanges?.["2avatar"]?.min ?? bodyRanges["2avatar"].min),
        max: String(nextRanges?.["2avatar"]?.max ?? bodyRanges["2avatar"].max)
      },
      "3avatar": {
        min: String(nextRanges?.["3avatar"]?.min ?? bodyRanges["3avatar"].min),
        max: String(nextRanges?.["3avatar"]?.max ?? bodyRanges["3avatar"].max)
      }
    });
    message.success("该版面打赏金额区间已保存");
  };

  const login = async (vals) => {
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: vals.account, password: vals.password })
      });
      const data = await res.json();
      if (!res.ok || !data.token) throw new Error(data.message || "登录失败");
      localStorage.setItem("admin_token", data.token);
      const role = String(data.user?.role || "user");
      localStorage.setItem("admin_role", role);
      setAdminRole(role);
      setToken(data.token);
      message.success("后台登录成功");
    } catch (e) {
      message.error(e.message);
    }
  };

  if (!token) {
    return (
      <div style={{ maxWidth: 420, margin: "60px auto", padding: 16 }}>
        <Card title="后台管理登录">
          <Form form={loginForm} layout="vertical" onFinish={login}>
            <Form.Item label="账号" name="account" rules={[{ required: true }]}>
              <Input placeholder="例如 qa_demo / admin" />
            </Form.Item>
            <Form.Item label="密码" name="password" rules={[{ required: true }]}>
              <Input.Password placeholder="输入密码" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block>
              登录后台
            </Button>
          </Form>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      {adminRole && !["admin", "subadmin"].includes(adminRole) ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="当前登录账号不是后台管理员"
          description="用户、订单、子账号、系统设置等接口需要 admin / subadmin 角色。列表为空或报错时，请换管理员账号登录。"
        />
      ) : null}
      <Space style={{ marginBottom: 12, width: "100%", justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>后台管理</h2>
        <Space>
          <Button onClick={loadAll} loading={loading}>刷新</Button>
          <Button onClick={() => setSubOpen(true)}>添加子账号</Button>
          <Button onClick={() => setPwdOpen(true)}>修改密码</Button>
          <Button
            danger
            onClick={() => {
              localStorage.removeItem("admin_token");
              localStorage.removeItem("admin_role");
              setAdminRole("");
              setToken("");
            }}
          >
            退出
          </Button>
        </Space>
      </Space>

      <Space size={12} wrap style={{ marginBottom: 12 }}>
        <Card><Statistic title="用户数" value={overview?.users || 0} /></Card>
        <Card><Statistic title="订单数" value={overview?.orders || 0} /></Card>
        <Card><Statistic title="充值总额" value={Number(overview?.paidAmount || 0).toFixed(2)} prefix="¥" /></Card>
      </Space>
      <Card size="small" style={{ marginBottom: 12 }} title="客服设置">
        <Space wrap>
          <span>客服微信号：</span>
          <Input
            value={serviceWechat}
            onChange={(e) => setServiceWechat(e.target.value)}
            placeholder="例如 wx123456"
            style={{ width: 260 }}
          />
          <Button
            type="primary"
            onClick={async () => {
              try {
                await withAuth("/admin/settings", {
                  method: "PUT",
                  body: JSON.stringify({ serviceWechat: String(serviceWechat || "").trim() })
                });
                message.success("客服微信已保存");
              } catch (e) {
                message.error(e.message || "保存失败");
              }
            }}
          >
            保存客服微信
          </Button>
        </Space>
      </Card>

      <Card size="small" style={{ marginBottom: 12 }} title={`打赏金额区间（最近${BOT_PAST_PERIODS}期）`}>
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          {[
            ["1avatar", "精选特码"],
            ["2avatar", "生肖特码"],
            ["3avatar", "精选三中三"]
          ].map(([base, label]) => (
            <Space key={base} wrap>
              <span style={{ width: 90 }}>{label}：</span>
              <Input
                value={rewardRanges[base].min}
                onChange={(e) => setRewardRanges((prev) => ({ ...prev, [base]: { ...prev[base], min: e.target.value } }))}
                placeholder="最小金额"
                style={{ width: 110 }}
              />
              <span>-</span>
              <Input
                value={rewardRanges[base].max}
                onChange={(e) => setRewardRanges((prev) => ({ ...prev, [base]: { ...prev[base], max: e.target.value } }))}
                placeholder="最大金额"
                style={{ width: 110 }}
              />
              <Button type="primary" onClick={() => saveRewardRangeByBase(base)}>保存{label}</Button>
            </Space>
          ))}
        </Space>
      </Card>

      <Tabs
        items={[
          {
            key: "users",
            label: "用户",
            children: (
              <Table
                rowKey="id"
                size="small"
                dataSource={users}
                columns={[
                  { title: "ID", dataIndex: "id", width: 70 },
                  { title: "用户名", dataIndex: "username" },
                  {
                    title: "余额",
                    dataIndex: "balance",
                    width: 120,
                    render: (v) => <span style={{ color: "#d4380d", fontWeight: 700 }}>¥{Number(v || 0).toFixed(2)}</span>
                  },
                  {
                    title: "状态",
                    dataIndex: "frozen",
                    width: 100,
                    render: (v) => (Number(v) === 1 ? <Tag color="red">冻结</Tag> : <Tag color="green">正常</Tag>)
                  },
                  { title: "创建时间", dataIndex: "created_at", width: 180 },
                  { title: "最新登录", dataIndex: "last_login_at", width: 180, render: (v) => v || "-" },
                  {
                    title: "操作",
                    width: 240,
                    render: (_, row) => (
                      <Space>
                        <Button
                          size="small"
                          onClick={() => {
                            setEditingUser(row);
                            setEditingBalance(String(row.balance ?? 0));
                            setBalanceEditorOpen(true);
                          }}
                        >
                          调余额
                        </Button>
                        <Button
                          size="small"
                          danger
                          onClick={async () => {
                            if (!window.confirm(`确认删除用户 ${row.username} 吗？`)) return;
                            try {
                              await withAuth(`/admin/users/${row.id}`, { method: "DELETE" });
                              message.success("用户已删除");
                              loadAll();
                            } catch (e) {
                              message.error(e.message || "删除失败");
                            }
                          }}
                        >
                          删除用户
                        </Button>
                      </Space>
                    )
                  }
                ]}
              />
            )
          },
          {
            key: "experts",
            label: "专家",
            children: (
              <div style={{ display: "grid", gap: 10 }}>
                <Space wrap>
                  <Button type={expertType === "all" ? "primary" : "default"} onClick={() => setExpertType("all")}>全部机器人</Button>
                  <Button type={expertType === "1avatar" ? "primary" : "default"} onClick={() => setExpertType("1avatar")}>精选特码🔥</Button>
                  <Button type={expertType === "2avatar" ? "primary" : "default"} onClick={() => setExpertType("2avatar")}>生肖特码🐴</Button>
                  <Button type={expertType === "3avatar" ? "primary" : "default"} onClick={() => setExpertType("3avatar")}>精选三中三💯</Button>
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  往期批量请在「往期批量」Tab 操作；此处「编辑内容」可单条精调。
                </Typography.Text>
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={filteredRobotExperts}
                  columns={[
                    { title: "专家名字", dataIndex: "name", width: 150 },
                    { title: "胜率", dataIndex: "winRate", width: 90, render: (v) => `${v}%` },
                    { title: "最新发布期数", dataIndex: "latestIssue", width: 140 },
                    { title: "最新内容", dataIndex: "latestContent", ellipsis: true },
                    {
                      title: "前一期状态",
                      dataIndex: "latestStamp",
                      width: 110,
                      render: (v) => (
                        v === "pending"
                          ? <Tag>待开奖</Tag>
                          : v === "hit"
                            ? <img src="/assets/emoji/win-hit.png" alt="红" width={28} height={28} />
                            : <img src="/assets/emoji/dsjl.png" alt="黑" width={28} height={28} />
                      )
                    },
                    {
                      title: "操作",
                      width: 120,
                      render: (_, row) => (
                        <Button
                          size="small"
                          onClick={() => {
                            setEditingBot(row);
                            setLatestIssue(String(row.latestIssue || row.issue || ""));
                            setLatestPrediction(String(row.effectivePrediction || row.prediction || ""));
                            const sourceRecent = Array.isArray(row.effectiveRecent10) && row.effectiveRecent10.length
                              ? row.effectiveRecent10
                              : (Array.isArray(row.recent10) ? row.recent10 : []);
                            const lines = sourceRecent.map(
                              (r) => `第${r.issue}期\n付费内容：${String(r.body || "").replace(/\r?\n/g, " ")}`
                            );
                            setRecent10Text(lines.join("\n\n"));
                            setBotEditorOpen(true);
                          }}
                        >
                          编辑内容
                        </Button>
                      )
                    }
                  ]}
                />
              </div>
            )
          },
          {
            key: "orders",
            label: "购买记录",
            children: (
              <Table
                rowKey="id"
                size="small"
                dataSource={orderRecords}
                columns={[
                  { title: "ID", dataIndex: "id", width: 70 },
                  { title: "用户名称", dataIndex: "username", width: 120 },
                  { title: "购买内容", dataIndex: "title", ellipsis: true },
                  { title: "购买金额", dataIndex: "amount", width: 120, render: (v) => `¥${Number(v || 0).toFixed(2)}` },
                  { title: "购买日期", dataIndex: "paid_at", width: 180, render: (v, row) => v || row.created_at || "-" },
                  {
                    title: "状态",
                    dataIndex: "status",
                    width: 110,
                    render: (v) => (String(v) === "success" ? <Tag color="green">正常</Tag> : <Tag color="orange">{v || "未知"}</Tag>)
                  }
                ]}
              />
            )
          },
          {
            key: "subs",
            label: "子账号管理",
            children: (
              <Table
                rowKey="id"
                size="small"
                dataSource={subAdmins}
                columns={[
                  { title: "ID", dataIndex: "id", width: 70 },
                  { title: "账号", dataIndex: "username" },
                  { title: "角色", dataIndex: "role", width: 110, render: (v) => (v === "admin" ? "管理员" : "子账号") },
                  { title: "状态", dataIndex: "frozen", width: 110, render: (v) => (Number(v) ? <Tag color="red">冻结</Tag> : <Tag color="green">正常</Tag>) },
                  { title: "创建时间", dataIndex: "created_at", width: 180 },
                  { title: "最新登录", dataIndex: "last_login_at", width: 180, render: (v) => v || "-" },
                  {
                    title: "操作",
                    width: 160,
                    render: (_, row) => (
                      <Button
                        size="small"
                        onClick={async () => {
                          const np = window.prompt(`给账号 ${row.username} 设置新密码（至少3位）`);
                          if (!np) return;
                          try {
                            await withAuth(`/admin/subadmins/${row.id}/password`, {
                              method: "PUT",
                              body: JSON.stringify({ newPassword: np })
                            });
                            message.success("子账号密码已更新");
                          } catch (e) {
                            message.error(e.message || "更新失败");
                          }
                        }}
                      >
                        重置密码
                      </Button>
                    )
                  }
                ]}
              />
            )
          },
          {
            key: "batchPast",
            label: "往期批量",
            children: (
              <div style={{ display: "grid", gap: 12 }}>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  选择期数后约 0.4s 自动拉取该期开奖；精选/生肖展示特码与生肖，三中三展示前区 6 个开奖号。勾选机器人后点「应用批量修改」写入库内 recent10。
                </Typography.Paragraph>
                <Row gutter={[16, 16]}>
                  <Col xs={24} lg={8}>
                    <Card
                      size="small"
                      bordered
                      title="精选特码"
                      headStyle={{ background: "linear-gradient(135deg, #fff7e6 0%, #fff 100%)" }}
                    >
                      <Space direction="vertical" size={10} style={{ width: "100%" }}>
                        <Space wrap style={{ width: "100%" }}>
                          <span style={{ width: 40 }}>期数</span>
                          <Select
                            showSearch
                            allowClear
                            placeholder="选择期数"
                            style={{ flex: 1, minWidth: 120 }}
                            value={batchPast["1avatar"].issue || undefined}
                            onChange={(v) => patchBatchPast("1avatar", { issue: v || "" })}
                            options={issueOptionsForBase("1avatar").map((x) => ({ value: x, label: x }))}
                          />
                        </Space>
                        <div style={{ padding: "8px 10px", background: "#fafafa", borderRadius: 8, border: "1px solid #f0f0f0" }}>
                          <Typography.Text type="secondary">开奖特码（末位）：</Typography.Text>{" "}
                          <Typography.Text strong code>
                            {batchPast["1avatar"].num || "—"}
                          </Typography.Text>
                        </div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          切换期数后自动填入；应用时随机替换该期付费文案中一个号码为该特码。
                        </Typography.Text>
                        <Divider style={{ margin: "8px 0" }} />
                        <Space style={{ width: "100%", justifyContent: "space-between" }}>
                          <Checkbox
                            checked={
                              rowsForBatchBase("1avatar").length > 0 &&
                              batchPast["1avatar"].selectedIds.length === rowsForBatchBase("1avatar").length
                            }
                            indeterminate={
                              batchPast["1avatar"].selectedIds.length > 0 &&
                              batchPast["1avatar"].selectedIds.length < rowsForBatchBase("1avatar").length
                            }
                            onChange={(e) =>
                              patchBatchPast("1avatar", {
                                selectedIds: e.target.checked ? rowsForBatchBase("1avatar").map((r) => r.id) : []
                              })
                            }
                          >
                            全选本版面
                          </Checkbox>
                          <Typography.Text type="secondary">{rowsForBatchBase("1avatar").length} 个机器人</Typography.Text>
                        </Space>
                        <div
                          style={{
                            maxHeight: 280,
                            overflow: "auto",
                            background: "#fafafa",
                            padding: 8,
                            borderRadius: 8,
                            border: "1px solid #f0f0f0"
                          }}
                        >
                          <Checkbox.Group
                            style={{ width: "100%" }}
                            value={batchPast["1avatar"].selectedIds}
                            onChange={(vals) => patchBatchPast("1avatar", { selectedIds: vals })}
                          >
                            <div style={{ display: "grid", gap: 6 }}>
                              {rowsForBatchBase("1avatar").map((r) => (
                                <label
                                  key={r.id}
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    background: "#fff",
                                    padding: "6px 8px",
                                    borderRadius: 6
                                  }}
                                >
                                  <Checkbox value={r.id}>{r.name}</Checkbox>
                                  <span style={{ color: "#999", fontSize: 12 }}>{r.winRate}%</span>
                                </label>
                              ))}
                            </div>
                          </Checkbox.Group>
                        </div>
                        <Button
                          type="primary"
                          block
                          loading={batchPastSaving === "1avatar"}
                          onClick={() => applyBatchPastForBase("1avatar")}
                        >
                          应用批量修改
                        </Button>
                      </Space>
                    </Card>
                  </Col>
                  <Col xs={24} lg={8}>
                    <Card
                      size="small"
                      bordered
                      title="生肖特码"
                      headStyle={{ background: "linear-gradient(135deg, #f6ffed 0%, #fff 100%)" }}
                    >
                      <Space direction="vertical" size={10} style={{ width: "100%" }}>
                        <Space wrap style={{ width: "100%" }}>
                          <span style={{ width: 40 }}>期数</span>
                          <Select
                            showSearch
                            allowClear
                            placeholder="选择期数"
                            style={{ flex: 1, minWidth: 120 }}
                            value={batchPast["2avatar"].issue || undefined}
                            onChange={(v) => patchBatchPast("2avatar", { issue: v || "" })}
                            options={issueOptionsForBase("2avatar").map((x) => ({ value: x, label: x }))}
                          />
                        </Space>
                        <div style={{ padding: "8px 10px", background: "#fafafa", borderRadius: 8, border: "1px solid #f0f0f0" }}>
                          <div>
                            <Typography.Text type="secondary">开奖生肖（末位）：</Typography.Text>{" "}
                            <Typography.Text strong>{batchPast["2avatar"].zodiac || "—"}</Typography.Text>
                          </div>
                          <div style={{ marginTop: 6 }}>
                            <Typography.Text type="secondary">开奖特码（末位）：</Typography.Text>{" "}
                            <Typography.Text strong code>
                              {batchPast["2avatar"].num || "—"}
                            </Typography.Text>
                          </div>
                        </div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          切换期数后自动填入；点击应用时每个机器人随机三选一：只改生肖命中、只改特码命中、或生肖与特码都改。
                        </Typography.Text>
                        <Divider style={{ margin: "8px 0" }} />
                        <Space style={{ width: "100%", justifyContent: "space-between" }}>
                          <Checkbox
                            checked={
                              rowsForBatchBase("2avatar").length > 0 &&
                              batchPast["2avatar"].selectedIds.length === rowsForBatchBase("2avatar").length
                            }
                            indeterminate={
                              batchPast["2avatar"].selectedIds.length > 0 &&
                              batchPast["2avatar"].selectedIds.length < rowsForBatchBase("2avatar").length
                            }
                            onChange={(e) =>
                              patchBatchPast("2avatar", {
                                selectedIds: e.target.checked ? rowsForBatchBase("2avatar").map((r) => r.id) : []
                              })
                            }
                          >
                            全选本版面
                          </Checkbox>
                          <Typography.Text type="secondary">{rowsForBatchBase("2avatar").length} 个机器人</Typography.Text>
                        </Space>
                        <div
                          style={{
                            maxHeight: 280,
                            overflow: "auto",
                            background: "#fafafa",
                            padding: 8,
                            borderRadius: 8,
                            border: "1px solid #f0f0f0"
                          }}
                        >
                          <Checkbox.Group
                            style={{ width: "100%" }}
                            value={batchPast["2avatar"].selectedIds}
                            onChange={(vals) => patchBatchPast("2avatar", { selectedIds: vals })}
                          >
                            <div style={{ display: "grid", gap: 6 }}>
                              {rowsForBatchBase("2avatar").map((r) => (
                                <label
                                  key={r.id}
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    background: "#fff",
                                    padding: "6px 8px",
                                    borderRadius: 6
                                  }}
                                >
                                  <Checkbox value={r.id}>{r.name}</Checkbox>
                                  <span style={{ color: "#999", fontSize: 12 }}>{r.winRate}%</span>
                                </label>
                              ))}
                            </div>
                          </Checkbox.Group>
                        </div>
                        <Button
                          type="primary"
                          block
                          loading={batchPastSaving === "2avatar"}
                          onClick={() => applyBatchPastForBase("2avatar")}
                        >
                          应用批量修改
                        </Button>
                      </Space>
                    </Card>
                  </Col>
                  <Col xs={24} lg={8}>
                    <Card
                      size="small"
                      bordered
                      title="精选三中三"
                      headStyle={{ background: "linear-gradient(135deg, #e6f7ff 0%, #fff 100%)" }}
                    >
                      <Space direction="vertical" size={10} style={{ width: "100%" }}>
                        <Space wrap style={{ width: "100%" }}>
                          <span style={{ width: 40 }}>期数</span>
                          <Select
                            showSearch
                            allowClear
                            placeholder="选择期数"
                            style={{ flex: 1, minWidth: 120 }}
                            value={batchPast["3avatar"].issue || undefined}
                            onChange={(v) => patchBatchPast("3avatar", { issue: v || "" })}
                            options={issueOptionsForBase("3avatar").map((x) => ({ value: x, label: x }))}
                          />
                        </Space>
                        <div style={{ padding: "8px 10px", background: "#fafafa", borderRadius: 8, border: "1px solid #f0f0f0" }}>
                          <Typography.Text type="secondary">开奖前区 6 个号：</Typography.Text>{" "}
                          <Typography.Text strong code style={{ wordBreak: "break-all" }}>
                            {batchPast["3avatar"].first6Nums?.length
                              ? batchPast["3avatar"].first6Nums.map((n) => pad2(n)).join("、")
                              : "—"}
                          </Typography.Text>
                        </div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          应用时为每个勾选的机器人从上述 6 码中各分配一组三码（前 {combinations3From6(batchPast["3avatar"].first6Nums || []).length || 0}{" "}
                          个尽量不重复），再随机替换其中一整组；保存后自动按号码从小到大整理每组及组顺序。
                        </Typography.Text>
                        <Divider style={{ margin: "8px 0" }} />
                        <Space style={{ width: "100%", justifyContent: "space-between" }}>
                          <Checkbox
                            checked={
                              rowsForBatchBase("3avatar").length > 0 &&
                              batchPast["3avatar"].selectedIds.length === rowsForBatchBase("3avatar").length
                            }
                            indeterminate={
                              batchPast["3avatar"].selectedIds.length > 0 &&
                              batchPast["3avatar"].selectedIds.length < rowsForBatchBase("3avatar").length
                            }
                            onChange={(e) =>
                              patchBatchPast("3avatar", {
                                selectedIds: e.target.checked ? rowsForBatchBase("3avatar").map((r) => r.id) : []
                              })
                            }
                          >
                            全选本版面
                          </Checkbox>
                          <Typography.Text type="secondary">{rowsForBatchBase("3avatar").length} 个机器人</Typography.Text>
                        </Space>
                        <div
                          style={{
                            maxHeight: 280,
                            overflow: "auto",
                            background: "#fafafa",
                            padding: 8,
                            borderRadius: 8,
                            border: "1px solid #f0f0f0"
                          }}
                        >
                          <Checkbox.Group
                            style={{ width: "100%" }}
                            value={batchPast["3avatar"].selectedIds}
                            onChange={(vals) => patchBatchPast("3avatar", { selectedIds: vals })}
                          >
                            <div style={{ display: "grid", gap: 6 }}>
                              {rowsForBatchBase("3avatar").map((r) => (
                                <label
                                  key={r.id}
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    background: "#fff",
                                    padding: "6px 8px",
                                    borderRadius: 6
                                  }}
                                >
                                  <Checkbox value={r.id}>{r.name}</Checkbox>
                                  <span style={{ color: "#999", fontSize: 12 }}>{r.winRate}%</span>
                                </label>
                              ))}
                            </div>
                          </Checkbox.Group>
                        </div>
                        <Button
                          type="primary"
                          block
                          loading={batchPastSaving === "3avatar"}
                          onClick={() => applyBatchPastForBase("3avatar")}
                        >
                          应用批量修改
                        </Button>
                      </Space>
                    </Card>
                  </Col>
                </Row>
              </div>
            )
          }
        ]}
      />

      <Modal
        width={820}
        open={botEditorOpen}
        title={editingBot ? `编辑机器人：${editingBot.name}` : "编辑机器人"}
        okText="保存"
        cancelText="取消"
        confirmLoading={savingBot}
        onCancel={() => setBotEditorOpen(false)}
        onOk={async () => {
          if (!editingBot) {
            message.error("未选中机器人");
            return;
          }
          try {
            setSavingBot(true);
            const rawRecent = String(recent10Text || "").trim();
            let recent10 = [];
            const normalized = rawRecent.replace(/\r/g, "");
            const segRe = /第?\s*(\d{5,})\s*期?([\s\S]*?)(?=第?\s*\d{5,}\s*期?|$)/g;
            let m;
            while ((m = segRe.exec(normalized))) {
              const issue = String(m[1] || "").trim();
              let body = String(m[2] || "").trim();
              body = body.replace(/^[:：\s-]*/, "").replace(/^付费内容[:：]?\s*/i, "").trim();
              body = body.replace(/\s+/g, " ").trim();
              if (issue && body) recent10.push({ issue, body });
            }
            // 兼容旧输入：空行分段
            if (!recent10.length) {
              const blocks = normalized.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
              for (const blk of blocks) {
                const issueMatch = blk.match(/第?\s*(\d{5,})\s*期?/);
                const contentMatch = blk.match(/付费内容[：:]\s*([\s\S]*)$/);
                if (issueMatch && contentMatch) {
                  recent10.push({ issue: issueMatch[1], body: contentMatch[1].trim().replace(/\s+/g, " ") });
                }
              }
            }
            if (!recent10.length) {
              message.error("往期记录格式不正确，请按“第xxxx期 + 付费内容”填写");
              return;
            }
            if (editingBot.base === "2avatar" || editingBot.base === "3avatar") {
              recent10 = await Promise.all(
                recent10.map(async (r) => {
                  try {
                    const payload = await fetchJsonRetry(`${API}/macau-history/${encodeURIComponent(r.issue)}`).catch(() => ({}));
                    const draw = parseHistoryDraw(payload);
                    if (!draw) return r;
                    if (editingBot.base === "2avatar") {
                      let body = replaceOneNumToHit(r.body, draw.lastNum);
                      body = replaceOneZodiac(body, draw.lastZodiac);
                      return { ...r, body };
                    }
                    const body = ensureOneThreeGroupHit(r.body, draw.first6);
                    return { ...r, body };
                  } catch {
                    return r;
                  }
                })
              );
            }
            await withAuth(`/admin/bot-experts/${editingBot.base}/${editingBot.file}`, {
              method: "PUT",
              body: JSON.stringify({
                issue: String(latestIssue || "").trim(),
                prediction: latestPrediction,
                recent10
              })
            });
            // 保存后立刻回读，确保往期内容真实落盘
            const afterRows = await withAuth("/admin/bot-experts");
            const saved = (afterRows || []).find((x) => x.base === editingBot.base && x.file === editingBot.file);
            if (!saved || !Array.isArray(saved.recent10) || !saved.recent10.length) {
              throw new Error("保存后校验失败：往期记录未写入");
            }
            message.success("机器人内容已保存");
            setBotEditorOpen(false);
            loadAll();
          } catch (e) {
            message.error(e.message || "保存失败");
          } finally {
            setSavingBot(false);
          }
        }}
      >
        <div style={{ display: "grid", gap: 10 }}>
          <label>最新发布期数（标题会按该期显示）</label>
          <Input value={latestIssue} onChange={(e) => setLatestIssue(e.target.value)} />
          <label>最新一期付费内容</label>
          <Input.TextArea rows={4} value={latestPrediction} onChange={(e) => setLatestPrediction(e.target.value)} />
          <label>往期记录（每段：第xxxx期 + 付费内容）</label>
          <Input.TextArea rows={10} value={recent10Text} onChange={(e) => setRecent10Text(e.target.value)} />
        </div>
      </Modal>

      <Modal
        open={pwdOpen}
        title="修改当前后台密码"
        okText="保存"
        cancelText="取消"
        confirmLoading={pwdSaving}
        onCancel={() => setPwdOpen(false)}
        onOk={async () => {
          try {
            setPwdSaving(true);
            await withAuth("/admin/change-password", {
              method: "POST",
              body: JSON.stringify({ oldPassword: pwdOld, newPassword: pwdNew })
            });
            message.success("密码修改成功");
            setPwdOpen(false);
            setPwdOld("");
            setPwdNew("");
          } catch (e) {
            message.error(e.message || "修改失败");
          } finally {
            setPwdSaving(false);
          }
        }}
      >
        <div style={{ display: "grid", gap: 8 }}>
          <label>旧密码</label>
          <Input.Password value={pwdOld} onChange={(e) => setPwdOld(e.target.value)} />
          <label>新密码</label>
          <Input.Password value={pwdNew} onChange={(e) => setPwdNew(e.target.value)} />
        </div>
      </Modal>

      <Modal
        open={subOpen}
        title="添加后台子账号"
        okText="保存"
        cancelText="取消"
        confirmLoading={subSaving}
        onCancel={() => setSubOpen(false)}
        onOk={async () => {
          try {
            setSubSaving(true);
            await withAuth("/admin/subadmins", {
              method: "POST",
              body: JSON.stringify({ username: subUser, password: subPass, role: "subadmin" })
            });
            message.success("子账号创建成功");
            setSubOpen(false);
            setSubUser("");
            setSubPass("");
            loadAll();
          } catch (e) {
            message.error(e.message || "创建失败");
          } finally {
            setSubSaving(false);
          }
        }}
      >
        <div style={{ display: "grid", gap: 8 }}>
          <label>账号</label>
          <Input value={subUser} onChange={(e) => setSubUser(e.target.value)} />
          <label>密码</label>
          <Input.Password value={subPass} onChange={(e) => setSubPass(e.target.value)} />
        </div>
      </Modal>

      <Modal
        open={balanceEditorOpen}
        title={editingUser ? `调整余额：${editingUser.username}` : "调整余额"}
        okText="保存"
        cancelText="取消"
        confirmLoading={savingBalance}
        onCancel={() => setBalanceEditorOpen(false)}
        onOk={async () => {
          if (!editingUser) {
            message.error("未选中用户");
            return;
          }
          try {
            setSavingBalance(true);
            const n = Number(editingBalance);
            if (!Number.isFinite(n) || n < 0) {
              message.error("请输入有效余额（>=0）");
              return;
            }
            await withAuth(`/admin/users/${editingUser.id}/balance`, {
              method: "PUT",
              body: JSON.stringify({ balance: n })
            });
            message.success("余额已更新");
            setBalanceEditorOpen(false);
            loadAll();
          } catch (e) {
            message.error(e.message || "更新失败");
          } finally {
            setSavingBalance(false);
          }
        }}
      >
        <div style={{ display: "grid", gap: 8 }}>
          <label>输入新余额</label>
          <Input value={editingBalance} onChange={(e) => setEditingBalance(e.target.value)} />
        </div>
      </Modal>
    </div>
  );
}
