// Dramov Serverless Function: Multi-Platform Live Drama & Movie Aggregator

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function withTimeout(promise, ms = 4800) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
  ]);
}

async function fetchJson(url, headers = {}) {
  const res = await withTimeout(
    fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        ...headers
      }
    }),
    4800
  );
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

function parseEpisodeBadge(text = "") {
  const raw = String(text || "").trim();
  let aired = 0;
  let total = 0;
  let isFinished = false;

  const mUp = raw.match(/更新至第?\s*(\d+)\s*[集话期]/);
  const mTot = raw.match(/[共全]\s*(\d+)\s*[集话期]|(\d+)\s*[集话期]全/);
  if (mUp) aired = parseInt(mUp[1], 10) || 0;
  if (mTot) total = parseInt(mTot[1] || mTot[2], 10) || 0;

  if (!mUp && mTot) {
    isFinished = true;
    aired = total;
  }
  if (/完结|全\d+[集话]|\d+[集话]全/.test(raw) && !raw.includes("更新至")) {
    isFinished = true;
    if (total > 0 && aired === 0) aired = total;
  }
  return { aired, total, isFinished, raw };
}

async function fetchIqiyi() {
  const url =
    "https://pcw-api.iqiyi.com/search/recommend/list?channel_id=2&data_type=1&mode=11&page_id=1&ret_num=16";
  const json = await fetchJson(url, { Referer: "https://www.iqiyi.com/" });
  const list = (json && json.data && json.data.list) || [];
  return list
    .slice(0, 14)
    .map((it) => {
      const badgeText = it.dq_updatestatus || it.updateStatus || "";
      const parsed = parseEpisodeBadge(badgeText);
      const total = Number(it.albumDocInfo?.itemTotalNumber) || parsed.total || 0;
      const aired = parsed.aired || (parsed.isFinished ? total : 0);
      return {
        extId: "iqiyi_" + (it.albumId || it.tvId || it.name),
        mediaType: "drama",
        title: String(it.name || "").trim(),
        platform: "爱奇艺",
        platforms: ["爱奇艺"],
        category: "国产剧",
        genre: Array.isArray(it.categories) ? it.categories.slice(0, 2).join(" / ") : "热播剧集",
        totalEpisodes: total,
        airedEpisodes: aired,
        isFinished: parsed.isFinished || (total > 0 && aired >= total),
        statusText: badgeText || (aired ? `更新至第 ${aired} 集` : "热播中"),
        poster: String(it.imageUrl || "").replace(/^http:/, "https:"),
        score: it.score ? String(it.score) : "",
        playUrl: it.playUrl ? String(it.playUrl).replace(/^http:/, "https:") : "https://www.iqiyi.com/"
      };
    })
    .filter((x) => x.title);
}

async function fetchMango() {
  const url =
    "https://pianku.api.mgtv.com/rider/list/pcweb/v3?platform=pcweb&channelId=2&pn=1&pc=14&kind=a1&sort=c2";
  const json = await fetchJson(url, { Referer: "https://www.mgtv.com/" });
  const list = (json && json.data && json.data.hitDocs) || [];
  return list
    .slice(0, 12)
    .map((it) => {
      const badgeText = it.updateInfo || it.rightCorner?.text || "";
      const parsed = parseEpisodeBadge(badgeText);
      return {
        extId: "mgtv_" + (it.clipId || it.playPartId || it.title),
        mediaType: "drama",
        title: String(it.title || "").trim(),
        platform: "芒果TV",
        platforms: ["芒果TV"],
        category: "国产剧",
        genre: Array.isArray(it.kind) ? it.kind.slice(0, 2).join(" / ") : "青春都市",
        totalEpisodes: parsed.total || 0,
        airedEpisodes: parsed.aired || 0,
        isFinished: parsed.isFinished,
        statusText: badgeText || "正在热播",
        poster: String(it.img || "").replace(/^http:/, "https:"),
        score: it.zhihuScore ? String(it.zhihuScore) : "",
        playUrl: it.playPartId
          ? `https://www.mgtv.com/b/${it.clipId}/${it.playPartId}.html`
          : "https://www.mgtv.com/tv/"
      };
    })
    .filter((x) => x.title);
}

async function fetchBilibili() {
  const [tvRes, gcRes, mvRes] = await Promise.allSettled([
    fetchJson(
      "https://api.bilibili.com/pgc/season/index/result?type=1&season_type=5&is_finish=-1&order=0&sort=0&page=1&pagesize=10",
      { Referer: "https://www.bilibili.com/" }
    ),
    fetchJson(
      "https://api.bilibili.com/pgc/season/index/result?type=1&season_type=4&is_finish=0&order=0&sort=0&page=1&pagesize=10",
      { Referer: "https://www.bilibili.com/" }
    ),
    fetchJson(
      "https://api.bilibili.com/pgc/season/index/result?type=1&season_type=2&is_finish=-1&order=0&sort=0&page=1&pagesize=8",
      { Referer: "https://www.bilibili.com/" }
    )
  ]);

  const items = [];
  const collect = (res, catLabel, mType) => {
    if (res.status !== "fulfilled") return;
    const arr = (res.value && res.value.data && res.value.data.list) || [];
    for (const it of arr) {
      const parsed = parseEpisodeBadge(it.index_show || "");
      items.push({
        extId: "bili_" + it.season_id,
        mediaType: mType,
        title: String(it.title || "").trim(),
        platform: "哔哩哔哩",
        platforms: ["哔哩哔哩"],
        category: catLabel,
        genre: it.subTitle ? String(it.subTitle).slice(0, 16) : catLabel,
        totalEpisodes: mType === "movie" ? 1 : (parsed.total || 0),
        airedEpisodes: mType === "movie" ? 1 : (parsed.aired || 0),
        isFinished: mType === "movie" ? true : (it.is_finish === 1 || parsed.isFinished),
        statusText: it.index_show || (mType === "movie" ? "正片已上线" : ""),
        poster: String(it.cover || "").replace(/^http:/, "https:"),
        score: it.score ? String(it.score) : "",
        playUrl: it.link
          ? String(it.link).replace(/^http:/, "https:")
          : `https://www.bilibili.com/bangumi/play/ss${it.season_id}`
      });
    }
  };
  collect(tvRes, "电视剧", "drama");
  collect(gcRes, "国创番剧", "drama");
  collect(mvRes, "电影新片", "movie");
  return items;
}

async function fetchDoubanHot() {
  const [tvRes, mvRes] = await Promise.allSettled([
    fetchJson(
      "https://movie.douban.com/j/search_subjects?type=tv&tag=%E7%83%AD%E9%97%A8&sort=time&page_limit=12&page_start=0",
      { Referer: "https://movie.douban.com/" }
    ),
    fetchJson(
      "https://movie.douban.com/j/search_subjects?type=movie&tag=%E7%83%AD%E9%97%A8&sort=time&page_limit=10&page_start=0",
      { Referer: "https://movie.douban.com/" }
    )
  ]);

  const out = [];
  if (tvRes.status === "fulfilled") {
    for (const it of tvRes.value?.subjects || []) {
      const parsed = parseEpisodeBadge(it.episodes_info || "");
      out.push({
        extId: "douban_tv_" + it.id,
        mediaType: "drama",
        title: String(it.title || "").trim(),
        platform: "全网热播",
        platforms: ["全网热播"],
        category: "热门剧集",
        genre: it.is_new ? "近期新开播" : "热播剧集",
        totalEpisodes: parsed.total || 0,
        airedEpisodes: parsed.aired || 0,
        isFinished: parsed.isFinished,
        statusText: it.episodes_info || "正在热播",
        poster: String(it.cover || "").replace(/^http:/, "https:"),
        score: it.rate ? String(it.rate) : "",
        playUrl: it.url || `https://movie.douban.com/subject/${it.id}/`
      });
    }
  }
  if (mvRes.status === "fulfilled") {
    for (const it of mvRes.value?.subjects || []) {
      out.push({
        extId: "douban_mv_" + it.id,
        mediaType: "movie",
        title: String(it.title || "").trim(),
        platform: "海外其他",
        platforms: ["院线 / 流媒体"],
        category: "热门电影",
        genre: it.is_new ? "新上映电影" : "高分电影",
        totalEpisodes: 1,
        airedEpisodes: 1,
        isFinished: true,
        statusText: "正片已上线",
        poster: String(it.cover || "").replace(/^http:/, "https:"),
        score: it.rate ? String(it.rate) : "",
        playUrl: it.url || `https://movie.douban.com/subject/${it.id}/`
      });
    }
  }
  return out.filter((x) => x.title);
}

function mapChannelToPlatform(name = "") {
  const s = String(name || "").toLowerCase();
  if (s.includes("tencent") || s.includes("wetv")) return "腾讯视频";
  if (s.includes("iqiyi")) return "爱奇艺";
  if (s.includes("youku")) return "优酷";
  if (s.includes("mango")) return "芒果TV";
  if (s.includes("bilibili")) return "哔哩哔哩";
  if (s.includes("netflix")) return "Netflix";
  if (s.includes("disney")) return "Disney+";
  if (s.includes("apple")) return "Apple TV+";
  if (s.includes("hbo") || s === "max") return "HBO Max";
  if (s.includes("prime") || s.includes("amazon")) return "Prime Video";
  return name || "海外其他";
}

async function fetchTvMazeToday() {
  const today = new Date().toISOString().slice(0, 10);
  const data = await fetchJson(`https://api.tvmaze.com/schedule/web?date=${today}`);
  if (!Array.isArray(data)) return [];
  const seen = new Map();
  for (const ep of data) {
    const show = ep._embedded?.show || ep.show || {};
    if (!show.id || !show.name) continue;
    const ch = show.webChannel?.name || show.network?.name || "";
    const platform = mapChannelToPlatform(ch);
    const epNum = Number(ep.number) || 1;
    const prev = seen.get(show.id);
    if (!prev || epNum > prev.airedEpisodes) {
      seen.set(show.id, {
        extId: "tvmaze_" + show.id,
        mediaType: "drama",
        title: show.name,
        platform,
        platforms: [platform],
        category: "流媒体剧集",
        genre: Array.isArray(show.genres) && show.genres.length ? show.genres.slice(0, 2).join(" / ") : "流媒体新剧",
        totalEpisodes: 0,
        airedEpisodes: epNum,
        isFinished: show.status === "Ended",
        statusText: `S${ep.season || 1} 更新至第 ${epNum} 集`,
        poster: String(show.image?.medium || show.image?.original || "").replace(/^http:/, "https:"),
        score: show.rating?.average ? String(show.rating.average) : "",
        updateTime: ep.airtime || "今日更新",
        playUrl: show.officialSite || show.url || "https://www.tvmaze.com/",
        updatedToday: true
      });
    }
  }
  return Array.from(seen.values()).slice(0, 20);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");

  const results = await Promise.allSettled([
    fetchIqiyi(),
    fetchMango(),
    fetchBilibili(),
    fetchDoubanHot(),
    fetchTvMazeToday()
  ]);

  const items = [];
  const activeSources = [];

  if (results[0].status === "fulfilled" && results[0].value.length) {
    items.push(...results[0].value);
    activeSources.push("爱奇艺片库");
  }
  if (results[1].status === "fulfilled" && results[1].value.length) {
    items.push(...results[1].value);
    activeSources.push("芒果TV片库");
  }
  if (results[2].status === "fulfilled" && results[2].value.length) {
    items.push(...results[2].value);
    activeSources.push("哔哩哔哩影视");
  }
  if (results[3].status === "fulfilled" && results[3].value.length) {
    items.push(...results[3].value);
    activeSources.push("豆瓣剧影榜");
  }
  if (results[4].status === "fulfilled" && results[4].value.length) {
    items.push(...results[4].value);
    activeSources.push("TVmaze排播");
  }

  res.status(200).json({
    ok: true,
    fetchedAt: new Date().toISOString(),
    activeSources,
    items
  });
};
