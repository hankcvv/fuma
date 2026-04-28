import { useEffect, useMemo, useState } from "react";
import { Button, Card, Checkbox, Form, Input, Modal, Select, Space, Statistic, Table, Tabs, Tag, message } from "antd";
import "antd/dist/reset.css";
import { getBotRuntime } from "./botParser.js";

const API = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");
function nextBotIssueFromLive(liveIssue, now = new Date()) {
  const n = Number(String(liveIssue || "").replace(/\D/g, ""));
  if (!Number.isFinite(n) || n <= 0) return "";
  const h = now.getHours();
  const m = now.getMinutes();
  const after1730 = h > 17 || (h === 17 && m >= 30);
  return String(after1730 ? n + 1 : n);
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

export default function AdminApp() {
  const [token, setToken] = useState(localStorage.getItem("admin_token") || "");
  const [loading, setLoading] = useState(false);
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [orderRecords, setOrderRecords] = useState([]);
  const [subAdmins, setSubAdmins] = useState([]);
  const [serviceWechat, setServiceWechat] = useState("");
  const [rewardMin, setRewardMin] = useState("1880");
  const [rewardMax, setRewardMax] = useState("2580");
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
  const [historyToolOpen, setHistoryToolOpen] = useState(false);
  const [historySaving, setHistorySaving] = useState(false);
  const [historyBase, setHistoryBase] = useState("1avatar");
  const [historyIssue, setHistoryIssue] = useState("");
  const [historySelectedIds, setHistorySelectedIds] = useState([]);
  const [historyNumInput, setHistoryNumInput] = useState("");
  const [historyZodiacInput, setHistoryZodiacInput] = useState("鼠");
  const [historyThreeA, setHistoryThreeA] = useState("");
  const [historyThreeB, setHistoryThreeB] = useState("");
  const [historyThreeC, setHistoryThreeC] = useState("");
  const [loginForm] = Form.useForm();
  const { withAuth } = useAdminApi(token);
  const filteredRobotExperts = useMemo(() => {
    if (expertType === "all") return robotExperts;
    return (robotExperts || []).filter((x) => String(x.base || "") === expertType);
  }, [robotExperts, expertType]);
  const historyRowsByBase = useMemo(
    () => (robotExperts || []).filter((x) => x.base === historyBase),
    [robotExperts, historyBase]
  );
  const historyIssueOptions = useMemo(() => {
    const set = new Set();
    for (const r of historyRowsByBase) {
      if (r.latestIssue) set.add(String(r.latestIssue));
      for (const p of (r.effectiveRecent10 || r.recent10 || [])) {
        if (p?.issue) set.add(String(p.issue));
      }
    }
    return [...set].sort((a, b) => Number(b) - Number(a));
  }, [historyRowsByBase]);
  const ZODIAC_OPTIONS = ["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"];
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

  const buildContiguousPastRows = (displayIssue, latestPrediction, candidateRows = [], limit = 10) => {
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
    const rows = await withAuth("/admin/bot-experts").catch(() => null);
    if (!Array.isArray(rows)) {
      return robotExperts;
    }
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
      const syncedPast = buildContiguousPastRows(displayIssue, displayPred, candidates, 10);
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
      // 历史接口波动时不阻断列表，未统计到开奖时仅回退成 0/待开奖展示。
      const winRate = loaded > 0 ? Math.round((hits / loaded) * 100) : 0;
      return {
        ...spec,
        id: `${spec.base}:${spec.file}`,
        name: spec.bot_name,
        winRate,
        latestIssue: spec.displayIssue,
        latestContent: String(spec.displayPred || "—").slice(0, 90),
        latestStamp: prevDraw ? (prevHit ? "hit" : "miss") : "pending",
        effectivePrediction: spec.displayPred || "",
        effectiveRecent10: spec.periodRows.slice(1, 11)
      };
    });
    setRobotExperts(all);
    return all;
  };

  const loadAll = async () => {
    if (!token) return;
    setLoading(true);
    const [o, u, od, sa, st] = await Promise.allSettled([
      withAuth("/admin/overview").catch(() => ({ users: 0, experts: 0, orders: 0, paidAmount: 0 })),
      withAuth("/admin/users").catch(() => []),
      withAuth("/admin/orders").catch(() => []),
      withAuth("/admin/subadmins").catch(() => []),
      withAuth("/admin/settings").catch(() => ({}))
    ]);
    if (o.status === "fulfilled") setOverview(o.value);
    if (u.status === "fulfilled") setUsers(Array.isArray(u.value) ? u.value : []);
    if (od.status === "fulfilled") setOrderRecords(Array.isArray(od.value) ? od.value : []);
    if (sa.status === "fulfilled") setSubAdmins(Array.isArray(sa.value) ? sa.value : []);
    if (st.status === "fulfilled") {
      setServiceWechat(String(st.value?.serviceWechat || ""));
      setRewardMin(String(st.value?.rewardMin ?? 1880));
      setRewardMax(String(st.value?.rewardMax ?? 2580));
    }
    try {
      const botRows = await loadRobotExperts();
      if (!Array.isArray(botRows)) {
        setRobotExperts((prev) => prev || []);
      }
    } catch {
      setRobotExperts((prev) => prev || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, [token]);

  useEffect(() => {
    if (!historyIssueOptions.length) {
      setHistoryIssue("");
      return;
    }
    setHistoryIssue((prev) => (prev && historyIssueOptions.includes(prev) ? prev : historyIssueOptions[0]));
    setHistorySelectedIds([]);
  }, [historyIssueOptions]);

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
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap>
          <span>客服微信号：</span>
          <Input
            value={serviceWechat}
            onChange={(e) => setServiceWechat(e.target.value)}
            placeholder="例如 wx123456"
            style={{ width: 220 }}
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
          <span style={{ marginLeft: 10 }}>打赏随机金额区间：</span>
          <Input
            value={rewardMin}
            onChange={(e) => setRewardMin(e.target.value)}
            placeholder="最小金额"
            style={{ width: 120 }}
          />
          <span>-</span>
          <Input
            value={rewardMax}
            onChange={(e) => setRewardMax(e.target.value)}
            placeholder="最大金额"
            style={{ width: 120 }}
          />
          <Button
            type="primary"
            onClick={async () => {
              const min = Number(rewardMin);
              const max = Number(rewardMax);
              if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) {
                message.error("请输入有效金额区间");
                return;
              }
              try {
                const data = await withAuth("/admin/settings", {
                  method: "PUT",
                  body: JSON.stringify({
                    serviceWechat: String(serviceWechat || "").trim(),
                    rewardMin: Math.floor(min),
                    rewardMax: Math.floor(max)
                  })
                });
                setRewardMin(String(data?.rewardMin ?? Math.floor(min)));
                setRewardMax(String(data?.rewardMax ?? Math.floor(max)));
                message.success("打赏金额区间已保存（随机生效）");
              } catch (e) {
                message.error(e.message || "保存失败");
              }
            }}
          >
            保存打赏金额
          </Button>
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
                  <Button onClick={() => setHistoryToolOpen(true)}>
                    修改往期记录
                  </Button>
                </Space>
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
          }
        ]}
      />

      <Modal
        width={860}
        open={historyToolOpen}
        title="修改往期记录"
        okText="确认修改"
        cancelText="取消"
        confirmLoading={historySaving}
        onCancel={() => setHistoryToolOpen(false)}
        onOk={async () => {
          if (!historyIssue) {
            message.error("请先选择期数");
            return;
          }
          const targets = historyRowsByBase.filter((r) => historySelectedIds.includes(r.id));
          if (!targets.length) {
            message.error("请至少勾选一个机器人");
            return;
          }
          let nextNum = Number(historyNumInput);
          if (historyBase === "1avatar" || historyBase === "2avatar") {
            if (!Number.isFinite(nextNum) || nextNum < 1 || nextNum > 49) {
              message.error("请输入 1-49 的数字");
              return;
            }
            nextNum = Math.floor(nextNum);
          }
          if (historyBase === "3avatar") {
            const a = Number(historyThreeA);
            const b = Number(historyThreeB);
            const c = Number(historyThreeC);
            if (![a, b, c].every((x) => Number.isFinite(x) && x >= 1 && x <= 49)) {
              message.error("三中三请填写 3 个 1-49 的数字");
              return;
            }
          }
          try {
            setHistorySaving(true);
            for (const row of targets) {
              const oldRecent = Array.isArray(row.effectiveRecent10) ? row.effectiveRecent10 : (Array.isArray(row.recent10) ? row.recent10 : []);
              const recent10 = oldRecent.map((r) => ({ issue: String(r.issue || ""), body: String(r.body || "") }));
              const idx = recent10.findIndex((r) => normalizeIssueKey(r.issue) === normalizeIssueKey(historyIssue));
              const sourceBody = idx >= 0 ? recent10[idx].body : String(row.effectivePrediction || row.prediction || "");
              let nextBody = sourceBody;
              if (historyBase === "1avatar") {
                nextBody = replaceOneNum(sourceBody, nextNum);
              } else if (historyBase === "2avatar") {
                nextBody = replaceOneNum(replaceOneZodiac(sourceBody, historyZodiacInput), nextNum);
              } else {
                nextBody = replaceOneThreeGroup(sourceBody, historyThreeA, historyThreeB, historyThreeC);
              }
              if (idx >= 0) recent10[idx] = { ...recent10[idx], body: nextBody };
              else recent10.unshift({ issue: String(historyIssue), body: nextBody });
              await withAuth(`/admin/bot-experts/${row.base}/${row.file}`, {
                method: "PUT",
                body: JSON.stringify({
                  issue: String(row.latestIssue || row.issue || ""),
                  prediction: String(row.effectivePrediction || row.prediction || ""),
                  recent10
                })
              });
            }
            message.success(`已更新 ${targets.length} 个机器人在第${historyIssue}期的往期内容`);
            setHistoryToolOpen(false);
            await loadAll();
          } catch (e) {
            message.error(e.message || "批量修改失败");
          } finally {
            setHistorySaving(false);
          }
        }}
      >
        <div style={{ display: "grid", gap: 10 }}>
          <Space wrap>
            <span>版面：</span>
            <Select
              style={{ width: 220 }}
              value={historyBase}
              onChange={setHistoryBase}
              options={[
                { value: "1avatar", label: "精选特码机器人" },
                { value: "2avatar", label: "生肖特码机器人" },
                { value: "3avatar", label: "精选三中三机器人" }
              ]}
            />
            <span>期数：</span>
            <Select
              style={{ width: 160 }}
              value={historyIssue || undefined}
              onChange={setHistoryIssue}
              options={historyIssueOptions.map((x) => ({ value: x, label: x }))}
              placeholder="选择期数"
            />
          </Space>
          {historyBase === "2avatar" ? (
            <Space wrap>
              <span>生肖：</span>
              <Select
                style={{ width: 120 }}
                value={historyZodiacInput}
                onChange={setHistoryZodiacInput}
                options={ZODIAC_OPTIONS.map((z) => ({ value: z, label: z }))}
              />
              <span>数字：</span>
              <Input style={{ width: 140 }} value={historyNumInput} onChange={(e) => setHistoryNumInput(e.target.value)} placeholder="1-49" />
            </Space>
          ) : historyBase === "3avatar" ? (
            <Space wrap>
              <span>替换组：</span>
              <Input style={{ width: 90 }} value={historyThreeA} onChange={(e) => setHistoryThreeA(e.target.value)} placeholder="01" />
              <span>-</span>
              <Input style={{ width: 90 }} value={historyThreeB} onChange={(e) => setHistoryThreeB(e.target.value)} placeholder="08" />
              <span>-</span>
              <Input style={{ width: 90 }} value={historyThreeC} onChange={(e) => setHistoryThreeC(e.target.value)} placeholder="15" />
              <span style={{ color: "#999" }}>会随机替换一整组</span>
            </Space>
          ) : (
            <Space wrap>
              <span>数字：</span>
              <Input style={{ width: 140 }} value={historyNumInput} onChange={(e) => setHistoryNumInput(e.target.value)} placeholder="1-49" />
            </Space>
          )}
          <div style={{ maxHeight: 280, overflow: "auto", background: "#fafafa", padding: 10, borderRadius: 8, border: "1px solid #eee" }}>
            <div style={{ marginBottom: 8, color: "#666" }}>
              勾选机器人（右侧显示命中率）
            </div>
            <div style={{ marginBottom: 8 }}>
              <Checkbox
                checked={historyRowsByBase.length > 0 && historySelectedIds.length === historyRowsByBase.length}
                indeterminate={historySelectedIds.length > 0 && historySelectedIds.length < historyRowsByBase.length}
                onChange={(e) => {
                  if (e.target.checked) {
                    setHistorySelectedIds(historyRowsByBase.map((r) => r.id));
                  } else {
                    setHistorySelectedIds([]);
                  }
                }}
              >
                全选
              </Checkbox>
            </div>
            <Checkbox.Group
              style={{ width: "100%" }}
              value={historySelectedIds}
              onChange={(vals) => setHistorySelectedIds(vals)}
            >
              <div style={{ display: "grid", gap: 8 }}>
                {historyRowsByBase.map((r) => (
                  <label key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#fff", padding: "6px 8px", borderRadius: 6 }}>
                    <Checkbox value={r.id}>{r.name}</Checkbox>
                    <span style={{ color: "#888" }}>命中率 {Number(r.winRate || 0)}%</span>
                  </label>
                ))}
              </div>
            </Checkbox.Group>
          </div>
        </div>
      </Modal>

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
            const recent10 = [];
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
