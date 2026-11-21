// Dramov 擂台赛程：自动从 TheSportsDB 拉取 WWE / AEW / UFC 即将举行的赛事
// - 免费公开接口（key 123），由 Vercel CDN 缓存 6 小时：服务器替手机去取，手机不用后台刷新
// - 每周固定节目（Raw / SmackDown / NXT / Dynamite / Collision）由前端按规则生成，这里只补充场馆
// - 取不到时返回空列表，前端继续用内置赛程

const LEAGUES = [
  { org: "WWE", id: 4444 },
  { org: "AEW", id: 4563 },
  { org: "UFC", id: 4443 }
];
const WEEKLY_PATTERNS = [
  { id: "raw", re: /^(wwe\s+)?raw\b/i },
  { id: "smackdown", re: /^(wwe\s+)?smack\s*down\b/i },
  { id: "nxt", re: /^(wwe\s+)?nxt\s*(#|\d|$)/i },
  { id: "dynamite", re: /^(aew\s+)?dynamite\b/i },
  { id: "collision", re: /^(aew\s+)?collision\b/i },
  { id: "rampage", re: /^(aew\s+)?rampage\b/i }
];

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

async function fetchLeague(league) {
  const url = `https://www.thesportsdb.com/api/v1/json/123/eventsnextleague.php?id=${league.id}`;
  const res = await withTimeout(fetch(url, { headers: { Accept: "application/json", "User-Agent": "Dramov/1.0 (personal schedule app)" } }), 6000);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  return Array.isArray(data && data.events) ? data.events : [];
}

function cleanName(org, name) {
  let n = String(name || "").replace(/\s+/g, " ").trim();
  if (org === "UFC" && !/^ufc/i.test(n)) n = "UFC " + n;
  return n;
}

// TheSportsDB 的 strTimestamp 是 UTC
function parseUtc(ev) {
  const ts = String(ev.strTimestamp || "").trim();
  if (ts) {
    const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts + "Z";
    const ms = Date.parse(iso);
    // 00:00 UTC 且正好落在赛事当天 → 多半是“时间未定”的占位；落在第二天（如美东晚 7 点）则是真实开赛时间
    const placeholder = /T00:00(:00)?/.test(ts) && ts.slice(0, 10) === String(ev.dateEvent || "");
    if (!Number.isNaN(ms) && !placeholder) return new Date(ms).toISOString();
  }
  const t = String(ev.strTime || "").trim();
  if (ev.dateEvent && /^\d\d:\d\d/.test(t) && !/^00:00/.test(t)) {
    const ms = Date.parse(`${ev.dateEvent}T${t.slice(0, 5)}:00Z`);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");

  const today = new Date(Date.now() - 36 * 3600000).toISOString().slice(0, 10);
  const events = [];
  const venues = {};
  const settled = await Promise.allSettled(LEAGUES.map(fetchLeague));

  settled.forEach((s, idx) => {
    if (s.status !== "fulfilled") return;
    const org = LEAGUES[idx].org;
    s.value.forEach((ev) => {
      const date = String(ev.dateEvent || "").slice(0, 10);
      const name = cleanName(org, ev.strEvent);
      if (!/^\d{4}-\d\d-\d\d$/.test(date) || !name || date < today) return;
      if (/cancel|postpon/i.test(String(ev.strStatus || ""))) return;
      const city = [ev.strCity, ev.strCountry].filter(Boolean).join(", ");
      const weekly = WEEKLY_PATTERNS.find((w) => w.re.test(name.replace(/^(WWE|AEW)\s+/i, "")) || w.re.test(name));
      if (weekly) {
        if (ev.strVenue || city) venues[`${date}|${weekly.id}`] = { venue: ev.strVenue || "", city };
        return;
      }
      events.push({ org, name, date, utc: parseUtc(ev), venue: ev.strVenue || "", city });
    });
  });

  res.status(200).json({
    ok: settled.some((s) => s.status === "fulfilled"),
    source: "TheSportsDB",
    fetchedAt: new Date().toISOString(),
    events,
    venues
  });
};
