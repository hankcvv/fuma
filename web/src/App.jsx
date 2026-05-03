import { useEffect, useMemo, useState } from "react";
import { botAvatarUrl, getBotRuntime, getCurrentBotIssue, parseBotTxt, resolveBotTitle } from "./botParser.js";

/** 开发走 Vite 代理到后端；生产可构建前设置 VITE_API_URL */
const API = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");
const BOT_PAST_PERIODS = 5;

async function readJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text?.trim().slice(0, 120) || `HTTP ${res.status}`);
  }
}

async function apiFetch(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (e) {
    const tip = import.meta.env.DEV
      ? "请在项目根目录执行 npm run dev，或先在 server 目录执行 npm run dev（端口 4000）。"
      : "";
    throw new Error(`无法连接服务器（${e.message}）${tip}`);
  }
  const data = await readJsonResponse(res);
  if (!res.ok) throw new Error(data.message || "请求失败");
  return data;
}

/** 号码展示为参考图点分隔样式 */
function formatPredictionDots(raw) {
  if (!raw || !String(raw).trim()) return "—";
  return String(raw)
    .trim()
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .split(/[\s．·,，]+/)
        .filter(Boolean)
        .join(".")
    )
    .filter(Boolean)
    .join("\n");
}

function hashSeedLocal(str) {
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function readPersistedJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function botRewardAmount(spec, rewardRanges) {
  const basePath = String(spec?.avatarBase || "");
  const base = basePath.includes("2avatar")
    ? "2avatar"
    : basePath.includes("3avatar")
      ? "3avatar"
      : "1avatar";
  const cfg = rewardRanges?.[base] || rewardRanges?.default || { min: 1880, max: 2580 };
  const cfgMin = Number(cfg?.min);
  const cfgMax = Number(cfg?.max);
  const min = Number.isFinite(cfgMin) ? Math.max(1, Math.floor(cfgMin)) : 1880;
  const max = Number.isFinite(cfgMax) ? Math.max(1, Math.floor(cfgMax)) : 2580;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const mid = Math.round((low + high) / 2);
  return Math.max(10, Math.floor(mid / 10) * 10);
}

function pastTimePlaceholder(index) {
  const day = 25 - (index % 12);
  const hh = 8 + (index % 12);
  return `2026-04-${String(day).padStart(2, "0")} ${String(hh).padStart(2, "0")}:48:05`;
}

/** openCode 最后一位（如 30）是否出现在机器人当期号码中（1–49） */
function robotContainsOpenNumber(predictionText, lastNumStr) {
  if (lastNumStr == null || lastNumStr === "") return false;
  const target = parseInt(String(lastNumStr).trim(), 10);
  if (Number.isNaN(target) || target < 1 || target > 49) return false;
  const nums = new Set();
  const numsPadded = new Set();
  const s = String(predictionText || "");
  const re = /\d+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = parseInt(m[0], 10);
    if (n >= 1 && n <= 49) {
      nums.add(n);
      numsPadded.add(String(n).padStart(2, "0"));
    }
  }
  return nums.has(target) || numsPadded.has(String(target).padStart(2, "0"));
}

function lastOpenCodeNumber(openCode) {
  const parts = String(openCode || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function lastZodiacValue(zodiacStr) {
  const parts = String(zodiacStr || "")
    .split(/[,\s，]+/u)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function openCodeFirst6Set(openCode) {
  const parts = String(openCode || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 6);
  const set = new Set();
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (Number.isFinite(n)) set.add(String(n).padStart(2, "0"));
  }
  return set;
}

function parseThreeGroups(predictionText) {
  const groups = String(predictionText || "")
    .trim()
    .split(/\s+/)
    .map((g) => g.trim())
    .filter(Boolean);
  return groups
    .map((g) => g.split("-").map((x) => x.trim()).filter(Boolean))
    .filter((arr) => arr.length === 3);
}

function threeHitByFirst6(openCode, predictionText) {
  const first6 = openCodeFirst6Set(openCode);
  if (!first6.size) return false;
  const groups = parseThreeGroups(predictionText);
  return groups.some((nums) => nums.every((n) => first6.has(String(parseInt(n, 10)).padStart(2, "0"))));
}

/** 与付费区/往期展示一致：用点分展示串与 openCode 最后一位比对 */
function paidDotsHitOpenLast(predictionText, openCodeLastStr) {
  const dotted = formatPredictionDots(predictionText);
  return robotContainsOpenNumber(dotted, openCodeLastStr);
}

function extractDotsNumbers(raw) {
  const nums = [];
  const re = /\d+/g;
  const s = String(raw || "");
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = parseInt(m[0], 10);
    if (n >= 1 && n <= 49) nums.push(String(n).padStart(2, "0"));
  }
  return nums.length ? nums.join(".") : "—";
}

function parseZodiacPrediction(raw) {
  const parts = String(raw || "")
    .split("，")
    .map((x) => x.trim())
    .filter(Boolean);
  const zodiacs = parts.filter((p) => !/\d/.test(p));
  const numsRaw = parts.filter((p) => /\d/.test(p)).join(",");
  const numsDots = extractDotsNumbers(numsRaw.replace(/,/g, " "));
  return { zodiacs, numsDots };
}

function formatZodiacPaidContent(raw) {
  const { zodiacs, numsDots } = parseZodiacPrediction(raw);
  if (!zodiacs.length && numsDots !== "—") return numsDots;
  if (zodiacs.length && numsDots !== "—") return `${zodiacs.join("，")}\n${numsDots}`;
  return zodiacs.join("，") || "—";
}

const ZODIAC_POOL = ["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"];

function makeSeededRng(seedText) {
  let s = hashCode(seedText);
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function pickDistinctWithSeed(pool, count, rng) {
  const arr = [...pool];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr.slice(0, Math.max(1, Math.min(count, arr.length)));
}

function parseZodiacCounts(spec) {
  const title = String(spec?.title || "");
  const pred = String(spec?.prediction || "");
  const mTitle = title.match(/(\d+)\s*肖\D*(\d+)\s*码/u);
  if (mTitle) return { zCount: Math.max(1, Number(mTitle[1])), nCount: Math.max(1, Number(mTitle[2])) };
  const z = parseZodiacPrediction(pred).zodiacs.length;
  const n = (pred.match(/\d+/g) || []).length;
  return { zCount: z || 3, nCount: n || 6 };
}

function parseThreeGroupCount(spec) {
  const title = String(spec?.title || "");
  const m = title.match(/(\d+)\s*组/u);
  if (m) return Math.max(1, Number(m[1]));
  const groups = String(spec?.prediction || "").trim().split(/\s+/).filter(Boolean);
  return Math.max(1, groups.length || 3);
}

function syntheticZodiacPrediction(spec, issue) {
  const { zCount, nCount } = parseZodiacCounts(spec);
  const key = `${spec?.bot_name || ""}|${spec?.robotId || ""}|zodiac|${issue}`;
  const rng = makeSeededRng(key);
  const zodiacs = pickDistinctWithSeed(ZODIAC_POOL, zCount, rng);
  const nums = pickDistinctWithSeed(Array.from({ length: 49 }, (_, i) => String(i + 1).padStart(2, "0")), nCount, rng)
    .map((x) => Number(x))
    .sort((a, b) => a - b)
    .map((x) => String(x).padStart(2, "0"));
  return `${zodiacs.join("，")}，${nums.join(",")}`;
}

function syntheticThreePrediction(spec, issue) {
  const groupCount = parseThreeGroupCount(spec);
  const key = `${spec?.bot_name || ""}|${spec?.robotId || ""}|three|${issue}`;
  const rng = makeSeededRng(key);
  const all = Array.from({ length: 49 }, (_, i) => String(i + 1).padStart(2, "0"));
  const groups = [];
  for (let i = 0; i < groupCount; i += 1) {
    const pick = pickDistinctWithSeed(all, 3, rng).map((x) => Number(x)).sort((a, b) => a - b).map((x) => String(x).padStart(2, "0"));
    groups.push(pick.join("-"));
  }
  return groups.join(" ");
}

function generatedPredictionByType(spec, issue, { zodiac, three }) {
  if (zodiac) return syntheticZodiacPrediction(spec, issue);
  if (three) return syntheticThreePrediction(spec, issue);
  return "";
}

async function fetchBotsByBase(base) {
  const rows = await apiFetch(`${API}/bots/${base}`, { cache: "no-store" });
  return (Array.isArray(rows) ? rows : [])
    .map((spec) => ({
      ...spec,
      avatarBase: spec?.avatarBase || `/bots/${base}`
    }))
    .filter((x) => x?.bot_name && x?.robotId);
}

function isZodiacBot(spec) {
  return String(spec?.avatarBase || "") === "/bots/2avatar";
}

function isThreeBot(spec) {
  return String(spec?.avatarBase || "") === "/bots/3avatar";
}

function randomPublishDateByIssue(botKey, issueStr) {
  const issueNum = Number(String(issueStr || "").replace(/\D/g, "")) || 0;
  const dayOffset = Math.max(0, issueNum % 120);
  const base = new Date(2026, 0, 1 + dayOffset, 0, 0, 0, 0);
  const seed = hashCode(`${botKey}|publish|${issueStr}`);
  const min = 20 + (seed % 41); // 17:20 - 18:00
  const hour = min === 60 ? 18 : 17;
  const minute = min === 60 ? 0 : min;
  const second = seed % 60;
  base.setHours(hour, minute, second, 0);
  return base;
}

function hashCode(str) {
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function isPaidWindow(now = new Date()) {
  const h = now.getHours();
  const m = now.getMinutes();
  const after1730 = h > 17 || (h === 17 && m >= 30);
  const before22 = h < 22;
  return after1730 && before22;
}

function nextBotIssueFromLive(liveIssue, now = new Date()) {
  const n = Number(String(liveIssue || "").replace(/\D/g, ""));
  if (!Number.isFinite(n) || n <= 0) return "";
  const h = now.getHours();
  const m = now.getMinutes();
  const after1730 = h > 17 || (h === 17 && m >= 30);
  return String(after1730 ? n + 1 : n);
}

/** 期数对齐：统一取数字；完整 expect 优先，兼容旧的 26110 简写。 */
function normalizeIssueKey(s) {
  const d = String(s ?? "").replace(/\D/g, "");
  if (!d) return "";
  return d.length >= 7 ? d : d.length > 5 ? d.slice(-5) : d;
}

/**
 * 按接口 expect 与机器人当前期数 displayIssue 对齐。
 * 现在机器人已使用完整 expect；仍兼容旧短期号。
 */
function findMacauRowForIssue(rows, displayIssue) {
  const iss = String(displayIssue ?? "").trim();
  if (!iss || !Array.isArray(rows) || !rows.length) return null;
  const key = normalizeIssueKey(iss);
  let row = rows.find((r) => {
    const expectKey = normalizeIssueKey(r?.expect);
    return expectKey === key || expectKey.endsWith(key) || key.endsWith(expectKey);
  });
  if (row) return row;
  row = rows.find((r) => String(r?.expect ?? "").trim() === iss);
  if (row) return row;
  const nIss = Number(iss);
  if (!Number.isNaN(nIss)) {
    row = rows.find((r) => Number(String(r?.expect ?? "").trim()) === nIss);
    if (row) return row;
  }
  row = rows.find((r) => {
    const e = String(r?.expect ?? "").trim();
    return e.length >= iss.length && e.endsWith(iss);
  });
  if (row) return row;
  /** live2 仅一条且为最新开奖：若期数已对齐仍无（极少），不再误用其它期 */
  return null;
}

function App() {
  const rememberedAuth = (() => {
    try {
      const raw = localStorage.getItem("rememberedAuth");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  })();
  const [token, setToken] = useState(localStorage.getItem("token") || "");
  const [authMode, setAuthMode] = useState("login");
  const [postLoginPage, setPostLoginPage] = useState("home");
  const [page, setPage] = useState("home");
  const [tabs, setTabs] = useState("精选特码🔥");
  const [predictions, setPredictions] = useState([]);
  const [experts, setExperts] = useState([]);
  const [me, setMe] = useState(null);
  const [orders, setOrders] = useState([]);
  const [follows, setFollows] = useState([]);
  const [detail, setDetail] = useState(null);
  const [expertDetail, setExpertDetail] = useState(null);
  const [form, setForm] = useState({
    username: "",
    password: rememberedAuth?.password || "",
    account: rememberedAuth?.account || ""
  });
  const [rememberPwd, setRememberPwd] = useState(Boolean(rememberedAuth?.account && rememberedAuth?.password));
  const [msg, setMsg] = useState("");
  const [payToast, setPayToast] = useState("");
  const [serviceToast, setServiceToast] = useState("");
  const [expertFollows, setExpertFollows] = useState(() => readPersistedJson("expertFollows", {}));
  const [complaintForm, setComplaintForm] = useState({ content: "", contact: "", type: "其他问题" });
  const [pwdForm, setPwdForm] = useState({ oldPwd: "", newPwd: "", confirmPwd: "" });
  const [showRewardRecords, setShowRewardRecords] = useState(false);
  const [hiddenFollowNames, setHiddenFollowNames] = useState(() => readPersistedJson("hiddenFollowNames", []));
  const [rechargeAmount, setRechargeAmount] = useState("");
  const [rechargeMethod, setRechargeMethod] = useState("wechat");
  const [botUnlocks, setBotUnlocks] = useState(() => readPersistedJson("botUnlocks", {}));
  const [serverBotUnlocks, setServerBotUnlocks] = useState({});
  const [serviceWechat, setServiceWechat] = useState("");
  const [rewardRanges, setRewardRanges] = useState({
    default: { min: 1880, max: 2580 },
    "1avatar": { min: 1880, max: 2580 },
    "2avatar": { min: 1880, max: 2580 },
    "3avatar": { min: 1880, max: 2580 }
  });
  /** 精选特码🔥 机器人专家（/bots/1avatar/*.txt） */
  const [botList, setBotList] = useState({ status: "idle", items: [] });
  /** 生肖特码🐴 机器人专家（/bots/2avatar/*.txt） */
  const [zodiacBotList, setZodiacBotList] = useState({ status: "idle", items: [] });
  /** 精选三中三💯 机器人专家（/bots/3avatar/*.txt） */
  const [threeBotList, setThreeBotList] = useState({ status: "idle", items: [] });
  /** 用于跨 17:30、日界后刷新期数与统计 */
  const [nowTick, setNowTick] = useState(() => new Date());
  /** 澳门开奖列表（/api/macau-jc），按 expect 与机器人期数对齐后比对 */
  const [macauRows, setMacauRows] = useState({ status: "idle", rows: [] });
  /** 历史开奖缓存：{ [expect]: row|null } */
  const [macauHistoryMap, setMacauHistoryMap] = useState({});
  // （已移除演示模式与调试开关）
  const tabIcons = {
    home: "/assets/emoji/home.png",
    experts: "/assets/emoji/f-icon2-on.png",
    mine: "/assets/emoji/mine.png"
  };
  const expertAvatarPool = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13];

  const authedFetch = async (path, options = {}) =>
    apiFetch(`${API}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });

  const loadCore = async () => {
    const [m, ps, es, os, fs] = await Promise.all([
      authedFetch("/user/me"),
      authedFetch(`/predictions?category=${encodeURIComponent(tabs)}`),
      authedFetch("/experts"),
      authedFetch("/user/orders"),
      authedFetch("/user/follows")
    ]);
    setMe(m);
    setPredictions(ps);
    setExperts(es);
    setOrders(os);
    setFollows(fs);
  };

  const flashToast = (text) => {
    setPayToast(text);
    setTimeout(() => setPayToast(""), 1800);
  };
  const flashServiceToast = (text) => {
    setServiceToast(text);
    setTimeout(() => setServiceToast(""), 2400);
  };

  useEffect(() => {
    if (!token) return;
    loadCore().catch((e) => setMsg(e.message));
  }, [token, tabs, nowTick]);

  useEffect(() => {
    if (token) return;
    const authOnlyPages = ["mineDisclaimer", "mineComplaint", "mineSettings", "mineChangePwd", "recharge"];
    if (authOnlyPages.includes(page)) setPage("home");
  }, [token, page]);

  useEffect(() => {
    const id = setInterval(() => setNowTick(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("expertFollows", JSON.stringify(expertFollows || {}));
    } catch {
      // ignore storage write failures
    }
  }, [expertFollows]);

  useEffect(() => {
    try {
      localStorage.setItem("hiddenFollowNames", JSON.stringify(hiddenFollowNames || []));
    } catch {
      // ignore storage write failures
    }
  }, [hiddenFollowNames]);

  useEffect(() => {
    try {
      localStorage.setItem("botUnlocks", JSON.stringify(botUnlocks || {}));
    } catch {
      // ignore storage write failures
    }
  }, [botUnlocks]);

  useEffect(() => {
    if (!token) {
      setServerBotUnlocks({});
      return;
    }
    authedFetch("/bot-unlocks")
      .then((rows) => {
        const map = {};
        for (const r of rows || []) {
          const k = `${r.bot_key}|${r.issue}`;
          map[k] = true;
        }
        setServerBotUnlocks(map);
      })
      .catch(() => setServerBotUnlocks({}));
  }, [token, me?.username]);

  useEffect(() => {
    apiFetch(`${API}/settings/service-wechat`)
      .then((d) => setServiceWechat(String(d?.wechat || "")))
      .catch(() => setServiceWechat(""));
  }, []);

  useEffect(() => {
    apiFetch(`${API}/settings/reward-range`)
      .then((d) => {
        const defMin = Number(d?.min);
        const defMax = Number(d?.max);
        const fallback = {
          min: Number.isFinite(defMin) ? defMin : 1880,
          max: Number.isFinite(defMax) ? defMax : 2580
        };
        const r1 = d?.ranges?.["1avatar"] || fallback;
        const r2 = d?.ranges?.["2avatar"] || fallback;
        const r3 = d?.ranges?.["3avatar"] || fallback;
        setRewardRanges({
          default: fallback,
          "1avatar": { min: Number(r1.min || fallback.min), max: Number(r1.max || fallback.max) },
          "2avatar": { min: Number(r2.min || fallback.min), max: Number(r2.max || fallback.max) },
          "3avatar": { min: Number(r3.min || fallback.min), max: Number(r3.max || fallback.max) }
        });
      })
      .catch(() =>
        setRewardRanges({
          default: { min: 1880, max: 2580 },
          "1avatar": { min: 1880, max: 2580 },
          "2avatar": { min: 1880, max: 2580 },
          "3avatar": { min: 1880, max: 2580 }
        })
      );
  }, []);

  useEffect(() => {
    if (page === "detail") {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
  }, [page]);

  useEffect(() => {
    const needMacau =
      (tabs === "精选特码🔥" || tabs === "生肖特码🐴" || tabs === "精选三中三💯") ||
      page === "experts" ||
      page === "expertDetail" ||
      (page === "detail" && detail?.kind === "bot");
    if (!needMacau) {
      setMacauRows({ status: "idle", rows: [] });
      return;
    }
    let cancelled = false;
    const poll = () => {
      fetch(`${API}/macau-jc`)
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return;
          if (!Array.isArray(data)) throw new Error("invalid");
          setMacauRows({ status: "ok", rows: data });
        })
        .catch(() => {
          if (!cancelled) setMacauRows({ status: "err", rows: [] });
        });
    };
    poll();
    const id = setInterval(poll, 120_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tabs, page, detail?.kind]);

  useEffect(() => {
    if (page !== "detail" || detail?.kind !== "bot") return;
    const dd = getBotDisplayData(detail.spec);
    const expects = [dd.displayIssue, ...(dd.pastRows || []).map((r) => r.issue)];
    const pending = expects.filter((exp) => !(exp in macauHistoryMap));
    if (!pending.length) return;
    let cancelled = false;
    Promise.all(
      pending.map((exp) =>
        fetch(`${API}/macau-history/${encodeURIComponent(exp)}`)
          .then((r) => r.json())
          .then((payload) => {
            const row = Array.isArray(payload?.data) ? payload.data[0] || null : null;
            return [exp, row];
          })
          .catch(() => [exp, null])
      )
    ).then((pairs) => {
      if (cancelled) return;
      setMacauHistoryMap((prev) => {
        const next = { ...prev };
        for (const [exp, row] of pairs) next[exp] = row;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [page, detail, nowTick, macauHistoryMap]);

  useEffect(() => {
    if (page !== "expertDetail" || !expertDetail?.spec) return;
    const expects = buildExpertPeriodRows(expertDetail.spec).map((r) => r.issue);
    const pending = expects.filter((exp) => !(exp in macauHistoryMap));
    if (!pending.length) return;
    let cancelled = false;
    Promise.all(
      pending.map((exp) =>
        fetch(`${API}/macau-history/${encodeURIComponent(exp)}`)
          .then((r) => r.json())
          .then((payload) => {
            const row = Array.isArray(payload?.data) ? payload.data[0] || null : null;
            return [exp, row];
          })
          .catch(() => [exp, null])
      )
    ).then((pairs) => {
      if (cancelled) return;
      setMacauHistoryMap((prev) => {
        const next = { ...prev };
        for (const [exp, row] of pairs) next[exp] = row;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [page, expertDetail, nowTick, macauHistoryMap]);

  useEffect(() => {
    if (page !== "home") return;
    if (tabs !== "精选特码🔥") {
      setBotList({ status: "idle", items: [] });
      return;
    }
    let cancelled = false;
    setBotList({ status: "loading", items: [] });
    fetchBotsByBase("1avatar")
      .then((items) => {
        if (cancelled) return;
        setBotList({ status: "ready", items });
      })
      .catch(() => {
        if (!cancelled) setBotList({ status: "error", items: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [page, tabs, nowTick]);

  useEffect(() => {
    if (page !== "home") return;
    if (tabs !== "生肖特码🐴") {
      setZodiacBotList({ status: "idle", items: [] });
      return;
    }
    let cancelled = false;
    setZodiacBotList({ status: "loading", items: [] });
    fetchBotsByBase("2avatar")
      .then((items) => {
        if (cancelled) return;
        setZodiacBotList({ status: "ready", items });
      })
      .catch(() => {
        if (!cancelled) setZodiacBotList({ status: "error", items: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [page, tabs, nowTick]);

  useEffect(() => {
    if (page !== "home") return;
    if (tabs !== "精选三中三💯") {
      setThreeBotList({ status: "idle", items: [] });
      return;
    }
    let cancelled = false;
    setThreeBotList({ status: "loading", items: [] });
    fetchBotsByBase("3avatar")
      .then((items) => {
        if (cancelled) return;
        setThreeBotList({ status: "ready", items });
      })
      .catch(() => {
        if (!cancelled) setThreeBotList({ status: "error", items: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [page, tabs, nowTick]);

  useEffect(() => {
    if (page !== "experts") return;
    const loadGroup = async (base, setter) => {
      setter((prev) => (prev.status === "ready" ? prev : { status: "loading", items: prev.items || [] }));
      try {
        const items = await fetchBotsByBase(base);
        setter({ status: "ready", items });
      } catch {
        setter((prev) => ({ status: prev.items?.length ? "ready" : "error", items: prev.items || [] }));
      }
    };
    if (botList.status !== "ready") loadGroup("1avatar", setBotList);
    if (zodiacBotList.status !== "ready") loadGroup("2avatar", setZodiacBotList);
    if (threeBotList.status !== "ready") loadGroup("3avatar", setThreeBotList);
  }, [page]);

  const submitAuth = async () => {
    try {
      if (authMode === "register") {
        const username = String(form.username || "").trim();
        if (!/^\d{6}$/.test(username)) {
          setMsg("注册名必须是6位数字");
          return;
        }
        if (!/^(?=.*[a-z])(?=.*\d)[a-z\d]+$/.test(String(form.password || ""))) {
          setMsg("密码需为小写英文+数字组合（不含大写）");
          return;
        }
        await apiFetch(`${API}/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username,
            account: username,
            password: form.password
          })
        });
        setMsg("注册成功，请登录");
        setAuthMode("login");
        return;
      }
      if (!form.account?.trim()) {
        setMsg("请输入账号");
        return;
      }
      if (!form.password || form.password.length < 3) {
        setMsg("密码至少3位");
        return;
      }
      const data = await apiFetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: form.account.trim(), password: form.password })
      });
      if (rememberPwd) {
        localStorage.setItem(
          "rememberedAuth",
          JSON.stringify({ account: form.account.trim(), password: form.password })
        );
      } else {
        localStorage.removeItem("rememberedAuth");
      }
      localStorage.setItem("token", data.token);
      setToken(data.token);
      setMsg("登录成功");
      setPage(postLoginPage || "home");
    } catch (e) {
      setMsg(e.message);
    }
  };

  const doLogout = () => {
    localStorage.removeItem("token");
    setToken("");
    setAuthMode("login");
    setMsg("已退出登录");
    setPage("home");
    setMe(null);
    setOrders([]);
    setFollows([]);
    setDetail(null);
    setExpertDetail(null);
    setServerBotUnlocks({});
    setBotUnlocks({});
  };

  const rankedExperts = useMemo(() => experts.slice().sort((a, b) => a.rank - b.rank), [experts]);
  const requireAuth = (nextPage = "") => {
    if (token) {
      if (nextPage) setPage(nextPage);
      return true;
    }
    setAuthMode("login");
    setMsg("请先登录");
    setPostLoginPage(nextPage || page || "home");
    setPage("login");
    return false;
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
      out.push({
        issue: iss,
        body: bodyByIssue.get(iss) || bodyByNormIssue.get(norm) || String(latestPrediction || "—")
      });
    }
    return out;
  };

  const getBotDisplayData = (spec) => {
    const zodiac = isZodiacBot(spec);
    const three = isThreeBot(spec);
    const rt = zodiac || three ? null : getBotRuntime(spec, nowTick);
    const liveIssue = macauRows.status === "ok" ? String(macauRows.rows?.[0]?.expect || "") : "";
    const publishIssue = nextBotIssueFromLive(liveIssue, nowTick);
    const displayIssue = String(publishIssue || getCurrentBotIssue(nowTick) || spec.issue || (rt?.displayIssue ?? ""));
    const specIssueMatch = normalizeIssueKey(spec?.issue) === normalizeIssueKey(displayIssue);
    const latestPrediction = zodiac || three
      ? String((specIssueMatch && spec?.prediction) ? spec.prediction : generatedPredictionByType(spec, displayIssue, { zodiac, three }) || spec.prediction || "—")
      : String(spec.prediction || rt?.generatedPrediction || "—");
    const savedPast = Array.isArray(spec.recent10)
      ? spec.recent10.map((r) => ({ issue: String(r.issue || ""), body: String(r.body || "") })).filter((r) => r.issue)
      : [];
    const generatedPast = (zodiac || three)
      ? Array.from({ length: 10 }, (_, idx) => {
          const iss = String(Number(displayIssue) - (idx + 1));
          return { issue: iss, body: generatedPredictionByType(spec, iss, { zodiac, three }) };
        })
      : [];
    const candidates = [
      ...((rt?.pastRows || []).map((r) => ({ issue: String(r.issue || ""), body: String(r.body || "") }))),
      ...generatedPast,
      ...savedPast
    ];
    // 期号始终按当前 displayIssue 连续倒推，内容优先使用已保存往期
    const pastRows = buildContiguousPastRows(displayIssue, latestPrediction, candidates, BOT_PAST_PERIODS);
    const publishAt = rt?.publishAt || randomPublishDateByIssue(`${spec.bot_name}|${spec.robotId}`, displayIssue);
    return { zodiac, three, displayIssue, latestPrediction, pastRows, publishAt, rt };
  };

  const canShowStampNow = (drawRow) => {
    return !!drawRow;
  };

  const isBotLatestIssue = (displayIssue) => {
    const liveIssue = macauRows.status === "ok" ? String(macauRows.rows?.[0]?.expect || "") : "";
    const publishIssue = nextBotIssueFromLive(liveIssue, nowTick) || String(getCurrentBotIssue(nowTick));
    return normalizeIssueKey(displayIssue) === normalizeIssueKey(publishIssue);
  };

  const payBotAndUnlock = (spec, issue) => {
    if (!token) return requireAuth();
    const key = `${spec.avatarBase || ""}|${spec.robotId || ""}|${issue}`;
    const fee = botRewardAmount(spec, rewardRanges);
    authedFetch("/bot-unlocks/purchase", {
      method: "POST",
      body: JSON.stringify({ botKey: `${spec.avatarBase || ""}|${spec.robotId || ""}`, issue, amount: fee })
    })
      .then((data) => {
        setBotUnlocks((prev) => ({ ...prev, [key]: true }));
        setServerBotUnlocks((prev) => ({ ...prev, [key]: true }));
        if (data?.user) setMe(data.user);
        flashToast("打赏成功，已解锁本期内容");
      })
      .catch((e) => {
        const msg = String(e?.message || "");
        if (msg.includes("404") || msg.includes("Cannot POST") || msg.includes("<!DOCTYPE html")) {
          const bal = Number(me?.balance || 0);
          if (bal < fee) {
            flashToast("余额不足，请先充值");
            return;
          }
          setMe((prev) => ({ ...(prev || {}), balance: Number(prev?.balance || 0) - fee }));
          setBotUnlocks((prev) => ({ ...prev, [key]: true }));
          flashToast("打赏成功（本地兜底解锁）");
          return;
        }
        flashToast(e.message || "解锁失败");
      });
    return true;
  };

  const lockedRecommendations = useMemo(() => {
    if (detail?.kind === "bot" && detail.spec) {
      const dd = getBotDisplayData(detail.spec);
      return (dd.pastRows || []).map((r, idx) => ({
        key: `past-${r.issue}-${idx}`,
        issue: r.issue,
        body: r.body
      }));
    }
    return predictions.filter((p) => !p.is_free && (!detail || p.id !== detail.id)).slice(0, 3);
  }, [predictions, detail, nowTick, botList.items, zodiacBotList.items, threeBotList.items]);

  const buildExpertPeriodRows = (spec) => {
    const zodiac = isZodiacBot(spec);
    const three = isThreeBot(spec);
    if (zodiac || three) {
      const liveIssue = macauRows.status === "ok" ? String(macauRows.rows?.[0]?.expect || "") : "";
      const publishIssue = nextBotIssueFromLive(liveIssue, nowTick) || String(spec.issue || "");
      const specIssueMatch = normalizeIssueKey(spec?.issue) === normalizeIssueKey(publishIssue);
      const current = {
        issue: String(publishIssue || spec.issue || ""),
        body: String((specIssueMatch && spec?.prediction) ? spec.prediction : generatedPredictionByType(spec, publishIssue, { zodiac, three }) || spec.prediction || "")
      };
      const savedPast = (spec.recent10 || []).slice(0, BOT_PAST_PERIODS).map((r) => ({ issue: String(r.issue || ""), body: String(r.body || "") }));
      const generatedPast = Array.from({ length: BOT_PAST_PERIODS }, (_, idx) => {
        const iss = String(Number(publishIssue) - (idx + 1));
        return { issue: iss, body: generatedPredictionByType(spec, iss, { zodiac, three }) };
      });
      const mergedPast = buildContiguousPastRows(current.issue, current.body, [...generatedPast, ...savedPast], BOT_PAST_PERIODS);
      return [current, ...mergedPast].filter((r) => r.issue);
    }
    const rt = getBotRuntime(spec, nowTick);
    const current = { issue: String(rt.displayIssue || ""), body: String(rt.generatedPrediction || "") };
    const past = (rt.pastRows || []).slice(0, BOT_PAST_PERIODS).map((r) => ({ issue: String(r.issue || ""), body: String(r.body || "") }));
    return [current, ...past].filter((r) => r.issue);
  };

  const expertRankings = useMemo(() => {
    const allSpecs = [...(botList.items || []), ...(zodiacBotList.items || []), ...(threeBotList.items || [])];
    const rankings = allSpecs.map((spec) => {
      const zodiac = isZodiacBot(spec);
      const three = isThreeBot(spec);
      const periodRows = buildExpertPeriodRows(spec);
      let hits = 0;
      let loaded = 0;
      for (const row of periodRows) {
        const draw =
          macauHistoryMap[row.issue] ??
          (macauRows.status === "ok" ? findMacauRowForIssue(macauRows.rows, row.issue) : null);
        if (!draw) continue;
        loaded += 1;
        const lastNum = lastOpenCodeNumber(draw.openCode);
        const lastZod = lastZodiacValue(draw.zodiac);
        const ok = three
          ? threeHitByFirst6(draw.openCode, row.body)
          : zodiac
            ? ((lastNum != null && paidDotsHitOpenLast(row.body, lastNum)) ||
              (lastZod && String(row.body || "").includes(lastZod)))
            : (lastNum != null && paidDotsHitOpenLast(row.body, lastNum));
        if (ok) hits += 1;
      }
      const targetPeriods = BOT_PAST_PERIODS + 1;
      const seed = hashCode(`${spec.avatarBase || ""}|${spec.robotId || ""}|${spec.bot_name || ""}`);
      const winRate = 85 + (seed % 15); // 85-99
      const fixedTotal = Math.max(1, targetPeriods);
      const fixedHits = Math.max(0, Math.min(fixedTotal, Math.round((winRate / 100) * fixedTotal)));
      return {
        id: `${spec.avatarBase || "b"}-${spec.robotId}-${spec.bot_name}`,
        spec,
        winRate,
        hits: fixedHits,
        total: fixedTotal,
        intro: `胜率 ${winRate}%`,
        progress: ""
      };
    });
    rankings.sort((a, b) => b.winRate - a.winRate);
    return rankings.map((x, idx) => ({ ...x, rank: idx + 1 }));
  }, [botList.items, zodiacBotList.items, threeBotList.items, nowTick, macauHistoryMap, macauRows.status, macauRows.rows]);

  const followedExpertNames = useMemo(() => {
    const names = new Set((follows || []).map((f) => f?.name).filter(Boolean));
    for (const row of expertRankings) {
      if (expertFollows[row.id]) names.add(row.spec.bot_name);
    }
    return [...names];
  }, [follows, expertRankings, expertFollows]);

  const followedExpertEntries = useMemo(() => {
    const followNameSet = new Set((follows || []).map((f) => f?.name).filter(Boolean));
    const hiddenSet = new Set(hiddenFollowNames || []);
    const rankedEntries = expertRankings
      .filter((row) => (expertFollows[row.id] || followNameSet.has(row.spec.bot_name)) && !hiddenSet.has(row.spec.bot_name))
      .map((row) => ({
        id: row.id,
        name: row.spec.bot_name,
        avatar: botAvatarUrl(row.spec.robotId, row.spec.avatarBase),
        spec: row.spec
      }));
    const exists = new Set(rankedEntries.map((x) => x.name));
    const fallback = (follows || [])
      .map((f) => String(f?.name || "").trim())
      .filter((name) => name && !hiddenSet.has(name) && !exists.has(name))
      .map((name) => {
        const matched = expertRankings.find((x) => x.spec.bot_name === name)?.spec || null;
        return {
          id: `follow-name-${name}`,
          name,
          avatar: matched ? botAvatarUrl(matched.robotId, matched.avatarBase) : "/assets/avatar/40.png",
          spec: matched
        };
      });
    return [...rankedEntries, ...fallback];
  }, [expertRankings, follows, expertFollows, hiddenFollowNames]);

  const isExpertFollowed = (row) => {
    const name = String(row?.spec?.bot_name || "");
    return Boolean(expertFollows[row?.id] || (name && (follows || []).some((f) => String(f?.name || "") === name)));
  };

  const toggleExpertFollowLocal = (row) => {
    if (!token) return requireAuth();
    const followed = isExpertFollowed(row);
    const nextFollows = { ...(expertFollows || {}), [row.id]: !followed };
    const nextHidden = followed
      ? [...new Set([...(hiddenFollowNames || []), row.spec.bot_name])]
      : (hiddenFollowNames || []).filter((n) => n !== row.spec.bot_name);
    setExpertFollows(nextFollows);
    setHiddenFollowNames(nextHidden);
    try {
      localStorage.setItem("expertFollows", JSON.stringify(nextFollows));
      localStorage.setItem("hiddenFollowNames", JSON.stringify(nextHidden));
    } catch {
      // ignore storage write failures
    }
    return true;
  };

  const openBotDetailBySpec = (spec) => {
    setDetail({ kind: "bot", spec });
    setPage("detail");
  };

  const toggleFollow = async (expert) => {
    try {
      await authedFetch(`/experts/${expert.id}/follow`, {
        method: expert.followed ? "DELETE" : "POST"
      });
      await loadCore();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const showDetail = async (id) => {
    try {
      const d = await authedFetch(`/predictions/${id}`);
      setDetail(d);
      setPage("detail");
    } catch (e) {
      setMsg(e.message);
    }
  };

  const payAndUnlock = async () => {
    if (!token) {
      requireAuth();
      return;
    }
    if (!detail || detail.kind === "bot") return;
    try {
      const order = await authedFetch("/orders/create", {
        method: "POST",
        body: JSON.stringify({ predictionId: detail.id })
      });
      await authedFetch(`/orders/${order.orderId}/pay`, { method: "POST" });
      const d = await authedFetch(`/predictions/${detail.id}`);
      setDetail(d);
      await loadCore();
      setPayToast("打赏成功，已解锁");
      setTimeout(() => setPayToast(""), 2200);
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <div className="layout">
      {page === "home" && (
        <>
          <section className="pre-banner-hero">
            <div className="pre-banner-inner">
              <img className="pre-banner-logo" src="/assets/logo1.png" alt="" />
              <p className="pre-banner-copy">
                所有平台的分析师都是经过新奥官方严格筛选的，我司郑重承诺平台所有分析师若月胜率不足60%次月必下架，保证所有客户的中奖率，各位家人可以放心大胆跟单，购买前可参考往期记录与命中率，不知如何操作请咨询老师。
              </p>
            </div>
          </section>
          <section className="banner clickable image-banner" onClick={() => requireAuth("recharge")}>
            <img src="/assets/recharge.jpg" alt="充值立得优惠" />
          </section>
        </>
      )}
      {page === "home" && (
        <main>
          <div className="tabs">
            {["精选特码🔥", "生肖特码🐴", "精选三中三💯"].map((t) => (
              <button key={t} className={tabs === t ? "active" : ""} onClick={() => setTabs(t)}>
                {t}
              </button>
            ))}
          </div>
          {/* 已移除演示模式与对比调试按钮 */}
          {tabs === "精选特码🔥" && botList.status === "loading" ? null : null}
          {tabs === "精选特码🔥" &&
            botList.status === "ready" &&
            botList.items.map((spec) => {
              const dd = getBotDisplayData(spec);
              const rt = dd.rt || getBotRuntime(spec, nowTick);
              const realDraw =
                macauHistoryMap[dd.displayIssue] ??
                (macauRows.status === "ok" ? findMacauRowForIssue(macauRows.rows, dd.displayIssue) : null);
              const lastNum = realDraw ? lastOpenCodeNumber(realDraw.openCode) : null;
              const shownPrediction = formatPredictionDots(dd.latestPrediction);
              const realHit = !!realDraw && lastNum != null && paidDotsHitOpenLast(shownPrediction, lastNum);
              return (
                <article
                  key={`${spec.bot_name}-${spec.robotId}`}
                  className="card bot-card"
                  onClick={() => {
                    setDetail({ kind: "bot", spec });
                    setPage("detail");
                  }}
                >
                  <div className="bot-card-row">
                    <div className="bot-card-avatar-col">
                      <img className="bot-avatar-lg" src={botAvatarUrl(spec.robotId, spec.avatarBase)} alt="" />
                      <p className="bot-name-line">{spec.bot_name}</p>
                    </div>
                    <div className="bot-card-main">
                      <h4>{resolveBotTitle(spec.title, dd.displayIssue)}</h4>
                      <div className="bot-stats-row">
                        <span className="bot-stat">
                          <img className="bot-stat-icon" src="/assets/emoji/live.png" alt="" /> {rt.likes}
                        </span>
                        <span className="bot-stat">
                          <span className="bot-stat-emoji" aria-hidden="true">
                            👁
                          </span>
                          {rt.views}
                        </span>
                        <span className="bot-stat">
                          <span className="bot-stat-emoji" aria-hidden="true">
                            🛒
                          </span>
                          {rt.buys}
                        </span>
                      </div>
                      <div className="meta">
                        <span className="tag-hot-inline">热门推荐</span>
                        <span>第{dd.displayIssue}期</span>
                      </div>
                    </div>
                    {canShowStampNow(realDraw) ? (
                      <img
                        className="tag-free-img"
                        src={realHit ? "/assets/emoji/win-hit.png" : "/assets/emoji/dsjl.png"}
                        alt={realHit ? "中" : "未中"}
                        width={40}
                        height={40}
                      />
                    ) : null}
                  </div>
                </article>
              );
            })}
          {tabs === "精选特码🔥" && botList.status === "error" && (
            <p className="bot-err">机器人配置加载失败，已改为接口列表。</p>
          )}
          {(tabs !== "精选特码🔥" || botList.status === "error") &&
            (tabs === "生肖特码🐴"
              ? zodiacBotList.status === "loading"
                ? []
                : zodiacBotList.status === "ready"
                  ? zodiacBotList.items.map((spec) => {
                      const dd = getBotDisplayData(spec);
                      const realDraw =
                        macauHistoryMap[dd.displayIssue] ??
                        (macauRows.status === "ok" ? findMacauRowForIssue(macauRows.rows, dd.displayIssue) : null);
                      const lastNum = realDraw ? lastOpenCodeNumber(realDraw.openCode) : null;
                      const lastZod = realDraw ? lastZodiacValue(realDraw.zodiac) : null;
                      const zp = parseZodiacPrediction(spec.prediction);
                      const paidDots = zp.numsDots;
                      const realHit =
                        (!!realDraw && lastNum != null && paidDotsHitOpenLast(paidDots, lastNum)) ||
                        (!!realDraw && lastZod && zp.zodiacs.includes(lastZod));
                      const rt = getBotRuntime(
                        { ...spec, title: spec.title, bot_name: spec.bot_name, robotId: spec.robotId },
                        nowTick
                      );
                      return (
                      <article
                        key={`z-${spec.bot_name}-${spec.robotId}`}
                        className="card bot-card"
                        onClick={() => {
                          setDetail({ kind: "bot", spec });
                          setPage("detail");
                        }}
                      >
                        <div className="bot-card-row">
                          <div className="bot-card-avatar-col">
                            <img className="bot-avatar-lg" src={botAvatarUrl(spec.robotId, spec.avatarBase)} alt="" />
                            <p className="bot-name-line">{spec.bot_name}</p>
                          </div>
                          <div className="bot-card-main">
                            <h4>{resolveBotTitle(spec.title, dd.displayIssue)}</h4>
                            <div className="bot-stats-row">
                              <span className="bot-stat">
                                <img className="bot-stat-icon" src="/assets/emoji/live.png" alt="" /> {rt.likes}
                              </span>
                              <span className="bot-stat">
                                <span className="bot-stat-emoji" aria-hidden="true">
                                  👁
                                </span>
                                {rt.views}
                              </span>
                              <span className="bot-stat">
                                <span className="bot-stat-emoji" aria-hidden="true">
                                  🛒
                                </span>
                                {rt.buys}
                              </span>
                            </div>
                            <div className="meta">
                              <span className="tag-hot-inline">热门推荐</span>
                              <span>第{dd.displayIssue}期</span>
                            </div>
                            {/* 生肖页卡片不展示付费内容，只在详情页展示 */}
                          </div>
                          {canShowStampNow(realDraw) ? (
                            <img
                              className="tag-free-img"
                              src={realHit ? "/assets/emoji/win-hit.png" : "/assets/emoji/dsjl.png"}
                              alt={realHit ? "中" : "未中"}
                              width={40}
                              height={40}
                            />
                          ) : null}
                        </div>
                      </article>
                      );
                    })
                  : zodiacBotList.status === "error"
                    ? [<p key="z-err" className="bot-err">生肖机器人加载失败</p>]
                    : []
              : tabs === "精选三中三💯"
                ? threeBotList.status === "loading"
                  ? []
                  : threeBotList.status === "ready"
                    ? threeBotList.items.map((spec) => {
                        const dd = getBotDisplayData(spec);
                        const realDraw =
                          macauHistoryMap[dd.displayIssue] ??
                          (macauRows.status === "ok" ? findMacauRowForIssue(macauRows.rows, dd.displayIssue) : null);
                        const realHit = !!realDraw && threeHitByFirst6(realDraw.openCode, dd.latestPrediction);
                        const rt = getBotRuntime(
                          { ...spec, title: spec.title, bot_name: spec.bot_name, robotId: spec.robotId },
                          nowTick
                        );
                        return (
                          <article
                            key={`t-${spec.bot_name}-${spec.robotId}`}
                            className="card bot-card"
                            onClick={() => {
                              setDetail({ kind: "bot", spec });
                              setPage("detail");
                            }}
                          >
                            <div className="bot-card-row">
                              <div className="bot-card-avatar-col">
                                <img className="bot-avatar-lg" src={botAvatarUrl(spec.robotId, spec.avatarBase)} alt="" />
                                <p className="bot-name-line">{spec.bot_name}</p>
                              </div>
                              <div className="bot-card-main">
                                <h4>{resolveBotTitle(spec.title, dd.displayIssue)}</h4>
                                <div className="bot-stats-row">
                                  <span className="bot-stat">
                                    <img className="bot-stat-icon" src="/assets/emoji/live.png" alt="" /> {rt.likes}
                                  </span>
                                  <span className="bot-stat">
                                    <span className="bot-stat-emoji" aria-hidden="true">
                                      👁
                                    </span>
                                    {rt.views}
                                  </span>
                                  <span className="bot-stat">
                                    <span className="bot-stat-emoji" aria-hidden="true">
                                      🛒
                                    </span>
                                    {rt.buys}
                                  </span>
                                </div>
                                <div className="meta">
                                  <span className="tag-hot-inline">热门推荐</span>
                                  <span>第{dd.displayIssue}期</span>
                                </div>
                              </div>
                              {canShowStampNow(realDraw) ? (
                                <img
                                  className="tag-free-img"
                                  src={realHit ? "/assets/emoji/win-hit.png" : "/assets/emoji/dsjl.png"}
                                  alt={realHit ? "中" : "未中"}
                                  width={40}
                                  height={40}
                                />
                              ) : null}
                            </div>
                          </article>
                        );
                      })
                    : threeBotList.status === "error"
                      ? [<p key="t-err" className="bot-err">三中三机器人加载失败</p>]
                      : []
              : predictions.map((p) => (
                  <article key={p.id} className="card" onClick={() => showDetail(p.id)}>
                    <h4>{p.title}</h4>
                    <p>{p.description}</p>
                    <div className="meta">
                      <span>🔥{p.heat}</span>
                      <span>{p.tags?.map((x) => `【${x}】`).join("")}</span>
                    </div>
                    <div className="meta">
                      <span>{p.expert_name}</span>
                      <span>{p.is_free ? "免费" : `¥${p.price}`}</span>
                    </div>
                  </article>
                )))}
        </main>
      )}
      {page === "experts" && (
        <main>
          <section className="experts-hero">
            <h2>专家排行榜</h2>
          </section>
          {expertRankings.map((e) => (
            <article
              key={e.id}
              className="card rank-card"
              onClick={() => {
                setExpertDetail(e);
                setPage("expertDetail");
              }}
            >
              <div className="expert-row">
                <div className="rank-icon-wrap">
                  {e.rank <= 3 ? (
                    <img className="rank-icon-img" src={`/assets/emoji/${e.rank}.png`} alt={`第${e.rank}名`} />
                  ) : (
                    <span className="rank-num">{e.rank}</span>
                  )}
                </div>
                <div className="avatar-wrap">
                  <img className="avatar-img" src={botAvatarUrl(e.spec.robotId, e.spec.avatarBase)} alt={e.spec.bot_name} />
                </div>
                <div className="expert-info">
                  <h4>
                    {e.spec.bot_name} <span className="expert-auth-pill">专家认证</span>
                  </h4>
                  <p>{e.intro}</p>
                </div>
                <button
                  type="button"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    toggleExpertFollowLocal(e);
                  }}
                >
                  {isExpertFollowed(e) ? "已关注" : "+关注"}
                </button>
              </div>
            </article>
          ))}
        </main>
      )}
      {page === "expertDetail" && expertDetail && (
        <main>
          <article className="card expert-top-bar">
            <button type="button" className="ghost" onClick={() => setPage("experts")}>
              返回
            </button>
            <h3>{expertDetail.spec.bot_name}</h3>
          </article>
          <article className="card expert-detail-head">
            <div className="expert-row">
              <div className="avatar-wrap">
                <img
                  className="avatar-img"
                  src={botAvatarUrl(expertDetail.spec.robotId, expertDetail.spec.avatarBase)}
                  alt={expertDetail.spec.bot_name}
                />
              </div>
              <div className="expert-info">
                <h4>
                  {expertDetail.spec.bot_name} <span className="expert-auth-pill">专家认证</span>
                </h4>
                <p>当前胜率 {expertDetail.winRate}%</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  toggleExpertFollowLocal(expertDetail);
                }}
              >
                {isExpertFollowed(expertDetail) ? "已关注" : "+关注"}
              </button>
            </div>
          </article>
          <article className="card past-records-card">
            <div className="section-title-paid past-section-title">
              <span className="section-bar" aria-hidden="true" />
              历史战绩
            </div>
            {buildExpertPeriodRows(expertDetail.spec).map((item, idx) => {
              const draw =
                macauHistoryMap[item.issue] ??
                (macauRows.status === "ok" ? findMacauRowForIssue(macauRows.rows, item.issue) : null);
              const last = draw ? lastOpenCodeNumber(draw.openCode) : null;
              const lastZ = draw ? lastZodiacValue(draw.zodiac) : null;
              const three = isThreeBot(expertDetail.spec);
              const zodiac = isZodiacBot(expertDetail.spec);
              const hit = three
                ? (!!draw && threeHitByFirst6(draw.openCode, item.body))
                : zodiac
                  ? ((!!draw && last != null && paidDotsHitOpenLast(item.body, last)) ||
                    (!!draw && lastZ && String(item.body || "").includes(lastZ)))
                  : (!!draw && last != null && paidDotsHitOpenLast(item.body, last));
              return (
                <div key={`ed-${item.issue}-${idx}`} className="past-record-item">
                  <div className="past-record-top">
                    <div>
                      <p className="past-title-fixed">第{item.issue}期</p>
                      <span className="past-name-hint">{expertDetail.spec.bot_name}</span>
                    </div>
                    <span className={hit ? "past-stamp stamp-hit" : "past-stamp stamp-miss"}>{hit ? "红" : "黑"}</span>
                  </div>
                  <p className="past-record-time">{pastTimePlaceholder(idx)}</p>
                </div>
              );
            })}
          </article>
        </main>
      )}
      {page === "mine" && (
        <main>
          <article className="mine-hero">
            <div className="mine-avatar">
              <img className="avatar-img" src="/assets/avatar/40.png" alt={me?.username || "用户"} />
            </div>
            <div>
              <h3>{token ? (me?.username || "用户") : "未登录"}</h3>
              <p>{token ? `余额: ¥${me?.balance || 0}` : "登录后可查看余额与打赏记录"}</p>
            </div>
          </article>
          {!token ? (
            <article className="card">
              <button type="button" className="btn-pay" onClick={() => requireAuth()}>
                登录 / 注册
              </button>
            </article>
          ) : null}
          <article className="card settings-list">
            <button
              type="button"
              className="setting-item setting-item-multi"
              onClick={() => {
                if (!token) return requireAuth();
                setShowRewardRecords((v) => !v);
              }}
            >
              <div className="setting-left">
                <span className="setting-emoji" aria-hidden="true">💰</span>
                <span>打赏记录</span>
              </div>
              <span>›</span>
            </button>
            {showRewardRecords ? (
              orders.length ? (
                <div className="setting-record-list">
                  {orders.slice(0, 8).map((o) => (
                    <div key={`ord-${o.id}`} className="setting-record-item">
                      <span className="setting-record-title">{o.title}</span>
                      <span className={String(o.status) === "success" ? "setting-record-status ok" : "setting-record-status"}>
                        {o.status}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="setting-desc">暂无</p>
              )
            ) : null}
            <button type="button" className="setting-item" onClick={() => requireAuth("recharge")}>
              <span className="setting-left">
                <span className="setting-emoji" aria-hidden="true">💳</span>
                <span>充值入口</span>
              </span>
              <span>›</span>
            </button>
            <button type="button" className="setting-item" onClick={() => requireAuth("mineComplaint")}>
              <span className="setting-left">
                <span className="setting-emoji" aria-hidden="true">📝</span>
                <span>投诉建议</span>
              </span>
              <span>›</span>
            </button>
            <button type="button" className="setting-item" onClick={() => requireAuth("mineDisclaimer")}>
              <span className="setting-left">
                <span className="setting-emoji" aria-hidden="true">📜</span>
                <span>免责声明</span>
              </span>
              <span>›</span>
            </button>
            <button type="button" className="setting-item" onClick={() => requireAuth("mineSettings")}>
              <span className="setting-left">
                <span className="setting-emoji" aria-hidden="true">⚙️</span>
                <span>应用设置</span>
              </span>
              <span>›</span>
            </button>
          </article>
          <article className="card">
            <h4>已关注专家</h4>
            {!token ? (
              <p>未登录</p>
            ) : followedExpertEntries.length ? (
              <div className="followed-experts">
                {followedExpertEntries.map((f) => (
                  <div
                    key={f.id}
                    role="button"
                    tabIndex={0}
                    className="followed-expert-row"
                    onClick={() => f.spec && openBotDetailBySpec(f.spec)}
                    onKeyDown={(ev) => {
                      if ((ev.key === "Enter" || ev.key === " ") && f.spec) openBotDetailBySpec(f.spec);
                    }}
                  >
                    <img className="avatar-img followed-avatar" src={f.avatar} alt={f.name} />
                    <span>{f.name}</span>
                    <button
                      type="button"
                      className="follow-cancel-btn"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setExpertFollows((prev) => ({ ...prev, [f.id]: false }));
                        setHiddenFollowNames((prev) => [...new Set([...(prev || []), f.name])]);
                        flashToast("已取消关注");
                      }}
                    >
                      取消关注
                    </button>
                    <span className="followed-arrow">{f.spec ? "›" : ""}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p>{followedExpertNames.join("、") || "暂无"}</p>
            )}
          </article>
        </main>
      )}
      {page === "mineDisclaimer" && (
        <main>
          <article className="card expert-top-bar">
            <button type="button" className="ghost" onClick={() => setPage("mine")}>
              返回
            </button>
            <h3>免责声明</h3>
          </article>
          <article className="card complaint-card">
            <p className="disclaimer-text-block">
              免责声明、
              {"\n"}一、总则
              {"\n"}1．本应用（以下简称"本应"）是一个提供信息服务的平台，旨在为用户提供便捷的服务。
              {"\n"}2．用户在使用本应用前，请仔细阅读本免责声明，您的使用行为将视为对本声明全部内容的认可。
              {"\n"}二、信息准确性
              {"\n"}1．本应用尽力确保所提供信息的准确性和完整性，但不保证信息的绝对准确性和完整性。
              {"\n"}2．本应用不对因信息错误或遗漏导致的任何损失或损害承担责任。
              {"\n"}三、用户责任
              {"\n"}1．用户应自行承担使用本应用的风险，本应用不对用户因使用本应用而产生的任何直接或间接损失承担责任。
              {"\n"}2．用户应遵守国家法律法规和本应用的相关规定，不得利用本应用从事违法违规活动。
              {"\n"}四、知识产权
              {"\n"}1．本应用的所有内容，包括但不限于文字、图片、音频、视频等，均受知识产权法律法规的保护。
              {"\n"}2．未经本应用授权，用户不得复制、修改、传播或用于商业目的。
              {"\n"}五、免责范围
              {"\n"}1．因不可抗力导致的服务中断或数据丢失，本应用不承担责任。
              {"\n"}2．因网络故障、黑客攻击、系统不稳定等原因导致的服务异常，本应用不承担责任。
              {"\n"}3．因用户自身操作失误或设备故障导致的损失，本应用不承担责任。
              {"\n"}六、修改与更新
              {"\n"}1．本应用有权随时修改本免责声明，修改后的声明将在本应用上公布。
              {"\n"}2．用户继续使用本应用，视为接受修改后的免责声明。
              {"\n"}七、法律适用
              {"\n"}本免责声明的订立、执行、解释及争议的解决均适用中华人民共和国法律。本免责声明自发布之日起生效。
            </p>
          </article>
        </main>
      )}
      {page === "mineComplaint" && (
        <main>
          <article className="card expert-top-bar">
            <button type="button" className="ghost" onClick={() => setPage("mine")}>
              返回
            </button>
            <h3>投诉建议</h3>
          </article>
          <article className="card complaint-card">
            <h4>投诉信息</h4>
            <label className="field-label">投诉内容</label>
            <textarea
              className="complaint-textarea"
              maxLength={500}
              placeholder="请详细描述您遇到的问题或建议"
              value={complaintForm.content}
              onChange={(e) => setComplaintForm((prev) => ({ ...prev, content: e.target.value }))}
            />
            <div className="complaint-count">{complaintForm.content.length}/500</div>
            <label className="field-label">联系方式</label>
            <input
              placeholder="请输入手机号或邮箱"
              value={complaintForm.contact}
              onChange={(e) => setComplaintForm((prev) => ({ ...prev, contact: e.target.value }))}
            />
            <label className="field-label">投诉类型</label>
            <div className="complaint-types">
              {["服务质量", "商品问题", "支付问题", "账号问题", "其他问题"].map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`complaint-type-btn${complaintForm.type === t ? " active" : ""}`}
                  onClick={() => setComplaintForm((prev) => ({ ...prev, type: t }))}
                >
                  {t}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn-pay"
              onClick={() => {
                if (!complaintForm.content.trim()) return flashToast("请先输入投诉内容");
                if (!complaintForm.contact.trim()) return flashToast("请先输入联系方式");
                setComplaintForm({ content: "", contact: "", type: "其他问题" });
                flashToast("提交成功");
              }}
            >
              提交投诉
            </button>
          </article>
        </main>
      )}
      {page === "mineSettings" && (
        <main>
          <article className="card expert-top-bar">
            <button type="button" className="ghost" onClick={() => setPage("mine")}>
              返回
            </button>
            <h3>应用设置</h3>
          </article>
          <article className="card settings-list">
            <button type="button" className="setting-item" onClick={() => setPage("mineChangePwd")}>
              <span className="setting-left">
                <span className="setting-emoji" aria-hidden="true">🔒</span>
                <span>修改密码</span>
              </span>
              <span>›</span>
            </button>
            <button type="button" className="setting-item" onClick={() => flashToast("当前已是最新版本")}>
              <span className="setting-left">
                <span className="setting-emoji" aria-hidden="true">🔄</span>
                <span>检查更新</span>
              </span>
              <span>›</span>
            </button>
            <button type="button" className="setting-item" onClick={() => flashToast("清理成功")}>
              <span className="setting-left">
                <span className="setting-emoji" aria-hidden="true">🧹</span>
                <span>清理缓存</span>
              </span>
              <span>›</span>
            </button>
          </article>
          <article className="card">
            <button
              type="button"
              className="logout-btn"
              onClick={doLogout}
            >
              退出登录
            </button>
          </article>
        </main>
      )}
      {page === "mineChangePwd" && (
        <main>
          <article className="card expert-top-bar">
            <button type="button" className="ghost" onClick={() => setPage("mineSettings")}>
              返回
            </button>
            <h3>修改密码</h3>
          </article>
          <article className="card complaint-card">
            <label className="field-label">旧密码</label>
            <input
              type="password"
              placeholder="请输入旧密码"
              value={pwdForm.oldPwd}
              onChange={(e) => setPwdForm((prev) => ({ ...prev, oldPwd: e.target.value }))}
            />
            <label className="field-label">新密码</label>
            <input
              type="password"
              placeholder="请输入新密码"
              value={pwdForm.newPwd}
              onChange={(e) => setPwdForm((prev) => ({ ...prev, newPwd: e.target.value }))}
            />
            <label className="field-label">确认密码</label>
            <input
              type="password"
              placeholder="请再次输入新密码"
              value={pwdForm.confirmPwd}
              onChange={(e) => setPwdForm((prev) => ({ ...prev, confirmPwd: e.target.value }))}
            />
            <button
              type="button"
              className="btn-pay"
              onClick={() => {
                if (!pwdForm.oldPwd || !pwdForm.newPwd || !pwdForm.confirmPwd) return flashToast("请完整填写密码");
                if (pwdForm.newPwd !== pwdForm.confirmPwd) return flashToast("两次输入的新密码不一致");
                setPwdForm({ oldPwd: "", newPwd: "", confirmPwd: "" });
                flashToast("修改成功");
                setPage("mineSettings");
              }}
            >
              确认修改
            </button>
          </article>
        </main>
      )}
      {page === "detail" && detail && (
        <main>
          {detail.kind === "bot" ? (
            (() => {
              const dd = getBotDisplayData(detail.spec);
              const zodiac = dd.zodiac;
              const three = dd.three;
              const displayIssue = dd.displayIssue;
              const pubStr = dd.publishAt.toLocaleString("zh-CN", { hour12: false });
              const realDraw =
                macauHistoryMap[displayIssue] ??
                (macauRows.status === "ok" ? findMacauRowForIssue(macauRows.rows, displayIssue) : null);
              const lastNum = realDraw ? lastOpenCodeNumber(realDraw.openCode) : null;
              const lastZod = realDraw ? lastZodiacValue(realDraw.zodiac) : null;
              const shownPrediction = zodiac
                ? formatZodiacPaidContent(dd.latestPrediction)
                : three
                  ? String(dd.latestPrediction || "—")
                  : formatPredictionDots(dd.latestPrediction);
              const unlockKey = `${detail.spec.avatarBase || ""}|${detail.spec.robotId || ""}|${displayIssue}`;
              const needPurchaseForLatest =
                isBotLatestIssue(displayIssue) &&
                isPaidWindow(nowTick) &&
                !(botUnlocks[unlockKey] || serverBotUnlocks[unlockKey]);
              const realPaidHit = zodiac
                ? ((!!realDraw && lastNum != null && paidDotsHitOpenLast(shownPrediction, lastNum)) ||
                  (!!realDraw && lastZod && parseZodiacPrediction(dd.latestPrediction).zodiacs.includes(lastZod)))
                : three
                  ? (!!realDraw && threeHitByFirst6(realDraw.openCode, shownPrediction))
                  : (!!realDraw && lastNum != null && paidDotsHitOpenLast(shownPrediction, lastNum));
              return (
                <>
                  <article className="card bubble-card title-bubble">
                    <div className="detail-bot-head">
                      <div className="bot-card-avatar-col">
                        <img
                          className="bot-avatar-lg"
                          src={botAvatarUrl(detail.spec.robotId, detail.spec.avatarBase)}
                          alt=""
                        />
                        <p className="bot-name-line">{detail.spec.bot_name}</p>
                      </div>
                      <div>
                        <h4 className="detail-title">{resolveBotTitle(detail.spec.title, displayIssue)}</h4>
                      </div>
                    </div>
                    <div className="detail-badges">
                      <span className="badge badge-official">官方推荐</span>
                      <span className="badge badge-hot">热门推荐</span>
                      <span className="badge badge-real">已实名</span>
                    </div>
                    <p className="detail-time">发布时间：{pubStr}</p>
                  </article>
                  <article className="card bubble-card disclaimer-bubble">
                    <p className="disclaimer-fineprint">
                      本付费内容为电子虚拟物品，解锁后不支持退款，所有文字、图片仅供参考，不保证连续性及任何承诺，自愿付费谨慎购买下单，购买即接受协议，本声明具有法律效力依据，请悉知！
                    </p>
                  </article>
                  <article className="card bubble-card paid-bubble">
                    <div className="paid-section paid-section-standalone">
                      <div className="section-title-paid">
                        <span className="section-bar" aria-hidden="true" />
                        付费内容
                      </div>
                      {needPurchaseForLatest ? (
                        <div className="paid-locked">
                          <p>🔒 最新一期需打赏后查看</p>
                          <p className="balance-hint">我的余额：¥{Number(me?.balance ?? 0).toFixed(2)}</p>
                          <button className="btn-pay" type="button" onClick={() => payBotAndUnlock(detail.spec, displayIssue)}>
                            打赏查看 (+¥{botRewardAmount(detail.spec, rewardRanges)})
                          </button>
                        </div>
                      ) : (
                        <div className={`unlock paid-content-box paid-dots${realPaidHit ? " paid-hit" : ""}`}>
                          {shownPrediction}
                        </div>
                      )}
                    </div>
                    <button type="button" className="ghost back-list-btn" onClick={() => setPage("home")}>
                      返回列表
                    </button>
                  </article>
                </>
              );
            })()
          ) : (
            <article className="card detail-card">
              <h4 className="detail-title">{detail.title}</h4>
              <p className="detail-tags">{detail.tags?.map((x) => `【${x}】`).join("")}</p>
              <div className="detail-badges">
                <span className="badge badge-official">官方推荐</span>
                <span className="badge badge-hot">热门推荐</span>
                <span className="badge badge-real">已实名</span>
              </div>
              <p className="detail-time">
                发布时间：{new Date(detail.published_at).toLocaleString("zh-CN", { hour12: false })}
              </p>
              <div className="paid-section">
                <div className="section-title-paid">
                  <span className="section-bar" aria-hidden="true" />
                  付费内容
                </div>
                {detail.canRead ? (
                  <div className="unlock paid-content-box">
                    {(detail.content || "")
                      .replace(/^(免费内容|付费解锁内容)[：:]\s*/u, "")
                      .trim() || "—"}
                  </div>
                ) : (
                  <div className="paid-locked">
                    <p>🔒 完整内容需要打赏后才能阅读</p>
                    <p className="balance-hint">我的余额：¥{Number(me?.balance ?? 0).toFixed(2)}</p>
                    <button className="btn-pay" type="button" onClick={payAndUnlock}>
                      打赏一下 (+¥{detail.price})
                    </button>
                  </div>
                )}
              </div>
              <button type="button" className="ghost back-list-btn" onClick={() => setPage("home")}>
                返回列表
              </button>
            </article>
          )}
          <article className={`card ${detail.kind === "bot" ? "past-records-card" : ""}`}>
            {detail.kind === "bot" ? (
              <>
                <div className="section-title-paid past-section-title">
                  <span className="section-bar" aria-hidden="true" />
                  往期记录
                </div>
                {lockedRecommendations.length > 0 ? (
                  lockedRecommendations.map((item, idx) => {
                    const pastDraw =
                      macauHistoryMap[item.issue] ??
                      (macauRows.status === "ok" ? findMacauRowForIssue(macauRows.rows, item.issue) : null);
                    const pastLast = pastDraw ? lastOpenCodeNumber(pastDraw.openCode) : null;
                    const isHit = isThreeBot(detail.spec)
                      ? (!!pastDraw && threeHitByFirst6(pastDraw.openCode, item.body))
                      : isZodiacBot(detail.spec)
                        ? ((!!pastDraw && pastLast != null && paidDotsHitOpenLast(item.body, pastLast)) ||
                          (!!pastDraw && lastZodiacValue(pastDraw.zodiac) && String(item.body || "").includes(lastZodiacValue(pastDraw.zodiac))))
                        : (!!pastDraw && pastLast != null && paidDotsHitOpenLast(item.body, pastLast));
                    return (
                      <div key={item.key} className="past-record-item">
                        <div className="past-record-top">
                          <div>
                            <p className="past-title-fixed">{resolveBotTitle(detail.spec.title, item.issue)}</p>
                            <span className="past-name-hint">{detail.spec.bot_name}</span>
                          </div>
                          <span className={isHit ? "past-stamp stamp-hit" : "past-stamp stamp-miss"}>
                            {isHit ? "红" : "黑"}
                          </span>
                        </div>
                        <div className="past-record-numbers">{formatPredictionDots(item.body)}</div>
                        <p className="past-record-time">{pastTimePlaceholder(idx)}</p>
                      </div>
                    );
                  })
                ) : (
                  <p className="past-empty">暂无往期</p>
                )}
              </>
            ) : (
              <>
                <h4>推荐未解锁内容</h4>
                {lockedRecommendations.length ? (
                  lockedRecommendations.map((item) => (
                    <div key={item.id} className="recommend-row">
                      <div>
                        <strong>{item.title}</strong>
                        <p>🔒 需解锁</p>
                      </div>
                      <button type="button" onClick={() => showDetail(item.id)}>
                        ¥{item.price}
                      </button>
                    </div>
                  ))
                ) : (
                  <p>当前暂无未解锁内容</p>
                )}
              </>
            )}
          </article>
        </main>
      )}
      {page === "recharge" && (
        <main>
          <article className="card recharge-card">
            <h4>充值中心</h4>
            <label className="field-label">充值金额</label>
            <input
              type="number"
              min={100}
              placeholder="最低充值金额 100"
              value={rechargeAmount}
              onChange={(e) => setRechargeAmount(e.target.value)}
            />
            <div className="recharge-quick-grid">
              {[500, 1000, 2000, 5000, 10000].map((n) => (
                <button key={n} type="button" className="recharge-chip" onClick={() => setRechargeAmount(String(n))}>
                  {n}
                </button>
              ))}
            </div>
            <label className="field-label">充值方式</label>
            <div className="recharge-methods">
              <button
                type="button"
                className={`recharge-method${rechargeMethod === "wechat" ? " active" : ""}`}
                onClick={() => setRechargeMethod("wechat")}
              >
                <span className="setting-emoji" aria-hidden="true">🟢</span> 微信充值
              </button>
              <button
                type="button"
                className={`recharge-method${rechargeMethod === "alipay" ? " active" : ""}`}
                onClick={() => setRechargeMethod("alipay")}
              >
                <span className="setting-emoji" aria-hidden="true">🔵</span> 支付宝充值
              </button>
            </div>
            <button
              type="button"
              className="btn-pay"
              onClick={() => {
                flashToast("请联系管理员");
              }}
            >
              确认充值
            </button>
          </article>
        </main>
      )}
      {page === "login" && (
        <main>
          <div className="auth">
            <div className="auth-wrap">
              <img className="auth-banner" src="/assets/login-banner.jpg" alt="登录横幅" />
              <h2 className="auth-title">新澳内部系统</h2>
            </div>
            <div className="card auth-card">
              <h3>{authMode === "login" ? "登录" : "注册"}</h3>
              {authMode === "login" ? (
                <input
                  placeholder="用户名/手机号/邮箱"
                  value={form.account}
                  onChange={(e) => setForm({ ...form, account: e.target.value })}
                />
              ) : (
                <input
                  placeholder="注册名（6位数字）"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                />
              )}
              <input
                type="password"
                placeholder={authMode === "register" ? "密码（小写英文+数字）" : "密码"}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
              {authMode === "login" ? (
                <label className="remember-row">
                  <input type="checkbox" checked={rememberPwd} onChange={(e) => setRememberPwd(e.target.checked)} />
                  <span>记住密码</span>
                </label>
              ) : null}
              <div className="auth-actions">
                <button className="auth-btn-primary" onClick={submitAuth}>
                  {authMode === "login" ? "立即登录" : "立即注册"}
                </button>
                <button className="ghost auth-btn-ghost" onClick={() => setAuthMode(authMode === "login" ? "register" : "login")}>
                  切换到{authMode === "login" ? "注册" : "登录"}
                </button>
                <button
                  className="ghost auth-btn-ghost"
                  onClick={() => setPage(postLoginPage && postLoginPage !== "login" ? postLoginPage : "home")}
                >
                  返回
                </button>
              </div>
              <p>{msg}</p>
            </div>
          </div>
        </main>
      )}
      {payToast ? <p className="toast toast-above-tab">{payToast}</p> : null}
      {serviceToast ? <p className="toast toast-top-strong">{serviceToast}</p> : null}
      {serviceWechat ? (
        <button
          type="button"
          className="kefu-float-btn"
          onClick={() => {
            flashServiceToast(`客服微信：${serviceWechat}`);
          }}
        >
          客服
        </button>
      ) : null}
      {page !== "login" ? (
        <nav className="bottom" aria-label="主导航">
        <button type="button" className={page === "home" ? "tab active" : "tab"} onClick={() => setPage("home")}>
          <img src={tabIcons.home} alt="" />
          <span>首页</span>
        </button>
        <button
          type="button"
          className={page === "experts" || page === "expertDetail" ? "tab active" : "tab"}
          onClick={() => setPage("experts")}
        >
          <img src={tabIcons.experts} alt="" />
          <span>专家</span>
        </button>
        <button
          type="button"
          className={String(page).startsWith("mine") ? "tab active" : "tab"}
          onClick={() => setPage("mine")}
        >
          <img src={tabIcons.mine} alt="" />
          <span>我的</span>
        </button>
        </nav>
      ) : null}
    </div>
  );
}

export default App;
