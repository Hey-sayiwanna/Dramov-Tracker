// Dramov v5 Serverless Function: Live Streaming Charts & Recent New Dramas
// Fetches bilingual (zh + en) titles, clean international vertical key-art posters,
// IMDb + Rotten Tomatoes + audience scores, official provider icons, and 60-day hot new dramas.

const GRAPHQL_ENDPOINT = "https://apis.justwatch.com/graphql";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PLATFORM_DEFS = [
  { id: "netflix", matchNames: ["netflix"], fallbackCodes: ["nfx"] },
  { id: "disney", matchNames: ["disney plus", "disney+"], fallbackCodes: ["dnp"] },
  { id: "hbo", matchNames: ["max", "hbo max"], fallbackCodes: ["mxx", "hbm"] },
  { id: "prime", matchNames: ["amazon prime video", "prime video"], fallbackCodes: ["amp", "prv"] },
  { id: "paramount", matchNames: ["paramount plus", "paramount+"], fallbackCodes: ["pmp"] },
  { id: "apple", matchNames: ["apple tv+", "apple tv plus", "apple tv"], fallbackCodes: ["atp"] },
  { id: "hulu", matchNames: ["hulu"], fallbackCodes: ["hlu"] },
  { id: "peacock", matchNames: ["peacock", "peacock premium", "peacock premium plus"], fallbackCodes: ["pct", "pcp"] }
];

// 可选的排行地区（JustWatch 每日榜是按国家分的，没有真正的「全球榜」）
const CHART_REGIONS = ["US", "SG", "TW", "HK", "GB", "JP", "KR"];

// 地区专区：看“当地人在看什么”，用当地的每日流媒体榜（JustWatch 按该国用户的实际点击/观看意向统计，
// 覆盖当地所有平台：韩国 TVING / Wavve / Coupang Play / Netflix…，日本 U-NEXT / ABEMA / TVer / Netflix…，
// 台湾 friDay / myVideo / KKTV / CATCHPLAY+ / Netflix…，香港 myTV SUPER / Viu / Netflix…），只收当地出品的剧和电影。
// 港澳台：台湾榜 + 香港榜合并计分（两边都热的排更前；JustWatch 没有澳门站）
const REGION_DEFS = [
  { id: "gat", countries: ["TW", "HK"], productionCountries: ["TW", "HK", "MO"] },
  { id: "kr", countries: ["KR"], productionCountries: ["KR"], locale: { zhCountry: "TW", enCountry: "US" } },
  // 日本榜只收日剧和电影：动画番剧另算，不然会被动画占满
  { id: "jp", countries: ["JP"], productionCountries: ["JP"], locale: { zhCountry: "TW", enCountry: "US" }, skipAnimeShows: true }
];
const REGION_TASKS = REGION_DEFS.flatMap((rg) => rg.countries.map((c) => ({ rg, country: c })));

// 一个地区一份榜：各国榜按名次给分（第 1 名 1/2、第 2 名 1/3…，剧和电影各自排名），多国合并相加；
// 最后取 7 部剧 + 3 部电影（不够时互相补齐），按分数排
function buildRegionChart(rg, edgeLists) {
  const scored = new Map();
  edgeLists.forEach((edges) => {
    const items = sortByChartRank(
      (edges || [])
        .map((e, i) => normalizeNode(e.node, rg.id, i))
        .filter((x) => x.title && !x.isDoc && !(rg.skipAnimeShows && x.mediaType === "show" && x.isAnime))
    );
    const pos = { show: 0, movie: 0 };
    items.forEach((it) => {
      const p = pos[it.mediaType]++;
      const key = it.jwId || it.enTitle;
      const pts = 1 / (p + 2);
      const cur = scored.get(key);
      if (cur) {
        cur.s += pts;
        cur.best = Math.min(cur.best, p);
      } else {
        scored.set(key, { it, s: pts, best: p });
      }
    });
  });
  const byScore = (a, b) => b.s - a.s || a.best - b.best;
  const all = Array.from(scored.values()).sort(byScore);
  const shows = all.filter((x) => x.it.mediaType === "show");
  const movies = all.filter((x) => x.it.mediaType === "movie");
  const nMovies = Math.min(movies.length, Math.max(3, 10 - shows.length));
  const nShows = Math.min(shows.length, 10 - nMovies);
  return shows.slice(0, nShows).concat(movies.slice(0, nMovies)).sort(byScore).map((x) => x.it);
}

function withTimeout(promise, ms = 5800) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
  ]);
}

// 韩国 / 日本的片：榜单和片库按当地（KR / JP）算，但中文片名、简介取台湾的繁中资料，英文资料取美区，
// 否则当地片在 KR / JP 区没有中文标题，只会显示韩文 / 日文或拼音
function localizeQuery(query, variables) {
  const v = Object.assign({}, variables || {});
  if (!v.zhCountry && !v.enCountry) return { query, variables: v };
  let q = query;
  const decl = [];
  for (const [lang, key] of [["zh", "zhCountry"], ["en", "enCountry"]]) {
    if (!v[key]) continue;
    const re = new RegExp('content\\(country: \\$country, language: "' + lang + '"\\)', "g");
    if (re.test(q)) {
      q = q.replace(re, 'content(country: $' + key + ', language: "' + lang + '")');
      decl.push("$" + key + ": Country!");
    } else {
      delete v[key];
    }
  }
  if (decl.length) q = q.replace(/\(\$country: Country!/, "($country: Country!, " + decl.join(", "));
  return { query: q, variables: v };
}

async function queryUpstream(query, variables = {}, timeoutMs = 5800) {
  const res = await withTimeout(
    fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(localizeQuery(query, variables))
    }),
    timeoutMs
  );
  if (!res.ok) throw new Error("Upstream HTTP " + res.status);
  return res.json();
}

const PACKAGES_QUERY = `
query GetPackages($country: Country!, $platform: Platform!) {
  packages(country: $country, platform: $platform) {
    clearName
    shortName
    technicalName
    icon(profile: S100)
  }
}
`;

const POPULAR_BILINGUAL_QUERY = `
query GetPopularBilingual($country: Country!, $first: Int!, $filter: TitleFilter) {
  popularTitles(country: $country, first: $first, sortBy: POPULAR, filter: $filter) {
    edges {
      node {
        id
        objectType
        objectId
        contentZh: content(country: $country, language: "zh") {
          title
          shortDescription
        }
        contentEn: content(country: $country, language: "en") {
          title
          originalReleaseYear
          originalReleaseDate
          shortDescription
          runtime
          ageCertification
          posterUrl
          backdrops {
            backdropUrl
          }
          genres {
            shortName
          }
          externalIds {
            imdbId
          }
          scoring {
            imdbScore
            imdbVotes
            tmdbScore
            tmdbPopularity
            tomatoMeter
          }
          credits {
            role
            name
            characterName
          }
        }
        ... on Show {
          totalSeasonCount
        }
        ... on MovieOrShowOrSeasonOrEpisode {
          offers(country: $country, platform: WEB) {
            monetizationType
            standardWebURL
            package {
              clearName
              shortName
              icon(profile: S100)
            }
          }
        }
      }
    }
  }
}
`;

// 在 BILINGUAL 基础上加 JustWatch 每日流媒体榜排名与热度趋势；字段不可用时自动退回 BILINGUAL
const CHART_FIELDS = `
        ... on MovieOrShowOrSeason {
          popularityRank(country: $country) {
            rank
            trend
            trendDifference
          }
          streamingCharts(country: $country) {
            edges {
              streamingChartInfo {
                rank
                trend
                trendDifference
                daysInTop10
              }
            }
          }
        }`;
const POPULAR_RICH_QUERY = POPULAR_BILINGUAL_QUERY.replace(
  /(\.\.\. on Show \{\s*totalSeasonCount\s*\})/,
  "$1" + CHART_FIELDS
);

const POPULAR_MIN_QUERY = `
query GetPopularMin($country: Country!, $first: Int!, $filter: TitleFilter) {
  popularTitles(country: $country, first: $first, filter: $filter) {
    edges {
      node {
        id
        objectType
        objectId
        contentZh: content(country: $country, language: "zh") {
          title
          shortDescription
        }
        contentEn: content(country: $country, language: "en") {
          title
          originalReleaseYear
          originalReleaseDate
          shortDescription
          posterUrl
          externalIds {
            imdbId
          }
          scoring {
            imdbScore
            tmdbScore
            tmdbPopularity
          }
        }
        ... on Show {
          totalSeasonCount
        }
        ... on MovieOrShowOrSeasonOrEpisode {
          offers(country: $country, platform: WEB) {
            monetizationType
            standardWebURL
            package {
              clearName
              shortName
              icon(profile: S100)
            }
          }
        }
      }
    }
  }
}
`;

const GENRE_ZH = {
  act: "动作",
  drm: "剧情",
  cmy: "喜剧",
  scf: "科幻",
  trl: "惊悚",
  crm: "犯罪",
  fnt: "奇幻",
  hrr: "恐怖",
  rma: "爱情",
  ani: "动画",
  doc: "纪录片",
  hst: "历史",
  war: "战争",
  mys: "悬疑",
  fmly: "家庭",
  wsn: "西部"
};

function formatImageUrl(rawPath, profile = "s718") {
  if (!rawPath) return "";
  const p = String(rawPath).replace("{profile}", profile).replace("{format}", "jpg");
  return p.startsWith("http") ? p : `https://images.justwatch.com${p}`;
}

function mapShortToPlatformId(shortName = "", clearName = "") {
  const s = String(shortName).toLowerCase();
  const c = String(clearName).toLowerCase();
  if (s === "nfx" || c.includes("netflix")) return "netflix";
  if (s === "dnp" || c.includes("disney")) return "disney";
  if (s === "mxx" || s === "hbm" || c === "max" || c.includes("hbo")) return "hbo";
  if (s === "amp" || s === "prv" || c.includes("prime video")) return "prime";
  if (s === "pmp" || c.includes("paramount")) return "paramount";
  if (s === "atp" || c.includes("apple tv+") || c === "apple tv") return "apple";
  if (s === "hlu" || c === "hulu" || c.startsWith("hulu ")) return "hulu";
  if (s === "pct" || s === "pcp" || c.startsWith("peacock")) return "peacock";
  return null;
}

async function resolveProviderMeta(country = "US") {
  const codeMap = {};
  const iconMap = {};
  const available = new Set();
  for (const def of PLATFORM_DEFS) codeMap[def.id] = [...def.fallbackCodes];
  try {
    const res = await queryUpstream(PACKAGES_QUERY, { country, platform: "WEB" });
    const pkgs = res?.data?.packages || [];
    for (const def of PLATFORM_DEFS) {
      const matched = pkgs.filter((p) => {
        const cn = String(p.clearName || "").toLowerCase().trim();
        const tn = String(p.technicalName || "").toLowerCase().trim();
        return def.matchNames.some((m) => cn === m || tn === m.replace(/\s+/g, ""));
      });
      if (matched.length) {
        available.add(def.id);
        codeMap[def.id] = Array.from(new Set([...matched.map((p) => p.shortName).filter(Boolean), ...def.fallbackCodes]));
        const ic = matched.find((p) => p.icon)?.icon;
        if (ic) iconMap[def.id] = formatImageUrl(ic, "s100");
      }
    }
  } catch (e) {}
  return { codeMap, iconMap, available };
}

async function fetchTitlesWithFilter(filter, count = 10, country = "US", locale = null) {
  const vars = Object.assign({ country, first: count, filter }, locale || {});
  try {
    const r0 = await queryUpstream(POPULAR_RICH_QUERY, vars);
    const edges0 = r0?.data?.popularTitles?.edges || [];
    if (edges0.length) return edges0;
  } catch (e) {}
  try {
    const r1 = await queryUpstream(POPULAR_BILINGUAL_QUERY, vars);
    const edges1 = r1?.data?.popularTitles?.edges || [];
    if (edges1.length) return edges1;
    const r2 = await queryUpstream(POPULAR_MIN_QUERY, vars);
    return r2?.data?.popularTitles?.edges || [];
  } catch (e) {
    try {
      const r2 = await queryUpstream(POPULAR_MIN_QUERY, vars);
      return r2?.data?.popularTitles?.edges || [];
    } catch (e2) {
      return [];
    }
  }
}

function normalizeNode(node, defaultPlatformId, rankIdx = 0) {
  const zh = node.contentZh || {};
  const en = node.contentEn || {};
  const sc = en.scoring || {};
  const isShow = node.objectType === "SHOW";
  const offers = Array.isArray(node.offers) ? node.offers : [];

  const providersSet = new Set();
  const providerLinks = {};
  const providerIcons = {};
  if (defaultPlatformId) providersSet.add(defaultPlatformId);

  const otherOffers = [];
  for (const off of offers) {
    const pid = mapShortToPlatformId(off.package?.shortName, off.package?.clearName);
    if (pid) {
      providersSet.add(pid);
      if (off.standardWebURL && !providerLinks[pid]) providerLinks[pid] = off.standardWebURL;
      if (off.package?.icon && !providerIcons[pid]) providerIcons[pid] = formatImageUrl(off.package.icon, "s100");
    } else if (
      off.package?.clearName &&
      ["FLATRATE", "FREE", "ADS"].includes(off.monetizationType) &&
      !otherOffers.some((o) => o.name === off.package.clearName) &&
      otherOffers.length < 4
    ) {
      // 不在内置平台列表里的服务（如台湾的 friDay、LINE TV），详情页照样显示
      otherOffers.push({
        name: off.package.clearName,
        icon: off.package.icon ? formatImageUrl(off.package.icon, "s100") : "",
        url: off.standardWebURL || ""
      });
    }
  }
  if (defaultPlatformId && !PLATFORM_DEFS.some((d) => d.id === defaultPlatformId)) providersSet.delete(defaultPlatformId);
  const chartInfo = node.streamingCharts?.edges?.[0]?.streamingChartInfo || null;
  const popRank = node.popularityRank || null;

  const imdb = sc.imdbScore ? Number(Number(sc.imdbScore).toFixed(1)) : null;
  const imdbVotes = sc.imdbVotes ? Number(sc.imdbVotes) : 0;
  const tomato = sc.tomatoMeter ? Math.round(Number(sc.tomatoMeter)) : null;
  const tmdbScore = sc.tmdbScore ? Number(Number(sc.tmdbScore).toFixed(1)) : null;
  const popcornPct = tmdbScore
    ? Math.min(99, Math.max(55, Math.round(tmdbScore * 10)))
    : (imdb ? Math.min(98, Math.max(60, Math.round(imdb * 10 + 3))) : 85);

  const rawGenres = Array.isArray(en.genres) ? en.genres : [];
  const genres = rawGenres
    .map((g) => GENRE_ZH[g.shortName] || "")
    .filter(Boolean)
    .slice(0, 3);

  const rawCredits = Array.isArray(en.credits) ? en.credits : [];
  const actors = rawCredits
    .filter((cr) => cr.role === "ACTOR" || !cr.role)
    .slice(0, 8)
    .map((cr) => ({
      name: cr.name || "",
      enName: cr.name || "",
      role: cr.characterName || ""
    }))
    .filter((x) => x.name);

  const rawPoster = en.posterUrl || "";
  const backdrops = Array.isArray(en.backdrops)
    ? en.backdrops.slice(0, 4).map((b) => formatImageUrl(b.backdropUrl, "s1440")).filter(Boolean)
    : [];

  return {
    id: "jw_" + (node.id || node.objectId || Math.random().toString(36).slice(2)),
    jwId: node.id || "",
    title: zh.title || en.title || "Untitled",
    enTitle: en.title || zh.title || "",
    imdbId: (en.externalIds && en.externalIds.imdbId) || "",
    mediaType: isShow ? "show" : "movie",
    // 纪录片和视频播客（Podcast）都不进榜单
    isDoc: rawGenres.some((g) => g.shortName === "doc") || /podcast/i.test(`${en.title || ""} ${zh.title || ""}`),
    isAnime: rawGenres.some((g) => g.shortName === "ani"),
    hasEpisodes: isShow,
    platformId: defaultPlatformId || Array.from(providersSet)[0] || "netflix",
    providers: Array.from(providersSet),
    providerLinks,
    providerIcons,
    otherOffers,
    chartRank: chartInfo && chartInfo.rank ? Number(chartInfo.rank) : null,
    trend: (chartInfo && chartInfo.trend) || (popRank && popRank.trend) || "",
    trendDiff: Number((chartInfo && chartInfo.trendDifference) || (popRank && popRank.trendDifference) || 0),
    popRank: popRank && popRank.rank ? Number(popRank.rank) : null,
    daysInTop10: chartInfo ? Number(chartInfo.daysInTop10) || 0 : 0,
    heat: Math.round((Number(sc.tmdbPopularity) || (1000 - rankIdx * 35)) * 10) / 10,
    imdb: imdb || tmdbScore || 7.9,
    imdbVotes,
    tomatoPct: tomato,
    popcornPct,
    year: en.originalReleaseYear || new Date().getUTCFullYear(),
    releaseDate: en.originalReleaseDate || "",
    seasonNumber: node.totalSeasonCount || 1,
    totalEpisodes: 0,
    airedEpisodes: 0,
    runtime: Number(en.runtime) || 0,
    ageRating: en.ageCertification || (isShow ? "TV-MA" : "PG-13"),
    genres: genres.length ? genres : [isShow ? "剧情" : "电影"],
    synopsis: zh.shortDescription || en.shortDescription || "",
    synopsisEn: en.shortDescription || "",
    genreCodes: rawGenres.map((g) => g.shortName).filter(Boolean).slice(0, 3),
    posterHd: formatImageUrl(rawPoster, "s718"),
    posterThumb: formatImageUrl(rawPoster, "s332"),
    backdrops,
    cast: actors
  };
}

async function enrichPremiereDateViaTvmaze(item) {
  if (item.mediaType !== "show" || !item.enTitle) return item;
  try {
    // 有 IMDb 编号就按编号找（不会配错剧）；否则按片名找，但首播年份差超过 1 年就不认
    let show = null;
    if (item.imdbId) {
      const lr = await withTimeout(
        fetch(`https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(item.imdbId)}`, { headers: { Accept: "application/json" } }),
        2200
      );
      if (lr && lr.ok) {
        const base = await lr.json();
        if (base && base.id) {
          const er = await withTimeout(
            fetch(`https://api.tvmaze.com/shows/${base.id}?embed=episodes`, { headers: { Accept: "application/json" } }),
            2200
          );
          if (er && er.ok) show = await er.json();
        }
      }
    }
    if (!show) {
      const res = await withTimeout(
        fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(item.enTitle)}&embed=episodes`, {
          headers: { Accept: "application/json" }
        }),
        2200
      );
      if (!res.ok) return item;
      show = await res.json();
      const py = Number(String((show && show.premiered) || "").slice(0, 4)) || 0;
      if (show && item.year && py && Math.abs(py - Number(item.year)) > 1) return item;
      if (show && item.imdbId && show.externals && show.externals.imdb && show.externals.imdb !== item.imdbId) return item;
    }
    if (!show) return item;
    const eps = Array.isArray(show._embedded?.episodes) ? show._embedded.episodes : [];
    const nowMs = Date.now();
    // Check latest season premiere date as well as series premiere date
    let latestEpDate = show.premiered || "";
    if (eps.length) {
      const maxSeason = Math.max(...eps.map((e) => Number(e.season) || 1));
      const curSeasonEps = eps.filter((e) => (Number(e.season) || 1) === maxSeason);
      const sPremiere = curSeasonEps[0]?.airdate || "";
      if (sPremiere) latestEpDate = sPremiere;
      const airedCount = curSeasonEps.filter((e) => !e.airdate || Date.parse(e.airdate) <= nowMs + 86400000).length;
      item.seasonNumber = maxSeason;
      item.totalEpisodes = curSeasonEps.length;
      item.airedEpisodes = airedCount || curSeasonEps.length;
    }
    if (latestEpDate && (!item.releaseDate || Date.parse(latestEpDate) > Date.parse(item.releaseDate || "1970-01-01"))) {
      item.releaseDate = latestEpDate;
    }
    if (show.premiered) {
      const pYear = Number(String(show.premiered).slice(0, 4));
      if (pYear) item.premiereYear = pYear;
    }
  } catch (e) {}
  return item;
}

// 按 JustWatch 每日流媒体榜排名排序（没上榜的按热度排名，其后保持原有热度顺序）
function sortByChartRank(list) {
  return list
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const ra = a.it.chartRank || (a.it.popRank ? 100000 + a.it.popRank : 1e9 + a.i);
      const rb = b.it.chartRank || (b.it.popRank ? 100000 + b.it.popRank : 1e9 + b.i);
      return ra - rb;
    })
    .map((x) => x.it);
}

function daysSinceDateStr(dateStr) {
  if (!dateStr) return 9999;
  const ms = Date.parse(dateStr);
  if (Number.isNaN(ms)) return 9999;
  return (Date.now() - ms) / 86400000;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=86400");

  try {
    const wanted = String((req.query && req.query.region) || "US").toUpperCase();
    const country = CHART_REGIONS.includes(wanted) ? wanted : "US";
    const now = new Date();
    const curYear = now.getUTCFullYear();
    const minNewYear = now.getUTCMonth() <= 1 ? curYear - 1 : curYear;

    const { codeMap, iconMap, available } = await resolveProviderMeta(country);
    // 该地区没有上线的平台（如新加坡没有 Hulu / Peacock）自动改用美区榜
    const usMeta = country === "US" ? { codeMap, iconMap, available } : await resolveProviderMeta("US");
    const regionOf = {};
    PLATFORM_DEFS.forEach((def) => {
      regionOf[def.id] = country !== "US" && available.size && !available.has(def.id) ? "US" : country;
    });
    const localCodes = PLATFORM_DEFS.filter((d) => regionOf[d.id] === country).flatMap((d) => codeMap[d.id]);
    const allSixCodes = Array.from(new Set(localCodes.length ? localCodes : Object.values(codeMap).flat()));

    const tasks = [
      // Task 0: Hot NEW TV Shows released in the current window (for Homepage 8-Poster Hero)
      fetchTitlesWithFilter(
        {
          packages: allSixCodes,
          objectTypes: ["SHOW"],
          releaseYear: { min: minNewYear }
        },
        30,
        country
      ),
      // Task 1: Cross-Platform Hottest TV Shows (Pure popularity across all 6 streamers!)
      fetchTitlesWithFilter(
        {
          packages: allSixCodes,
          objectTypes: ["SHOW"]
        },
        18,
        country
      ),
      // Task 2: Cross-Platform Hottest Movies (Pure popularity across all 6 streamers!)
      fetchTitlesWithFilter(
        {
          packages: allSixCodes,
          objectTypes: ["MOVIE"]
        },
        18,
        country
      ),
      // Tasks 3..: Per-platform Top 10 (Movies + TV Shows combined, excluding documentaries)
      ...PLATFORM_DEFS.map(async (def) => {
        const c = regionOf[def.id];
        const codes = c === country ? codeMap[def.id] : usMeta.codeMap[def.id];
        const edges = await fetchTitlesWithFilter({ packages: codes, objectTypes: ["MOVIE", "SHOW"] }, 24, c);
        if (edges.length || c === "US") return edges;
        // 所选地区查不到这个平台的榜：退回美区
        regionOf[def.id] = "US";
        return fetchTitlesWithFilter({ packages: usMeta.codeMap[def.id], objectTypes: ["MOVIE", "SHOW"] }, 24, "US");
      }),
      // 地区专区：每个地区的每个国家各拉一份当地榜（当地出品，剧 + 电影）
      ...REGION_TASKS.map(({ rg, country: c }) =>
        fetchTitlesWithFilter(
          {
            productionCountries: rg.productionCountries,
            objectTypes: ["MOVIE", "SHOW"]
          },
          40,
          c,
          rg.locale || null
        )
      )
    ];

    const settled = await Promise.allSettled(tasks);

    const rawNewShowCandidates =
      settled[0].status === "fulfilled"
        ? settled[0].value.map((e, i) => normalizeNode(e.node, null, i)).filter((x) => x.title && !x.isDoc)
        : [];

    // Enrich top 12 new show candidates in parallel with TVmaze dates/episodes (fast 2.2s cap)
    await Promise.allSettled(rawNewShowCandidates.slice(0, 16).map((it) => enrichPremiereDateViaTvmaze(it)));

    // Strict 1-2 month (<= 62 days) hot new dramas first, fallback to <= 105 days / current-year S1-S2 new shows
    const tier60 = rawNewShowCandidates.filter((it) => {
      const d = daysSinceDateStr(it.releaseDate);
      return d >= -7 && d <= 65 && Number(it.year) >= minNewYear;
    });
    const tier105 = rawNewShowCandidates.filter((it) => {
      const d = daysSinceDateStr(it.releaseDate);
      return Number(it.year) >= minNewYear && (d <= 110 || (Number(it.seasonNumber) || 1) <= 2);
    });

    const heroMap = new Map();
    [...tier60, ...tier105, ...rawNewShowCandidates].forEach((it) => {
      const key = (it.enTitle || it.title).toLowerCase();
      if (!heroMap.has(key) && Number(it.year) >= minNewYear) {
        heroMap.set(key, it);
      }
    });
    const heroNewShows = Array.from(heroMap.values()).slice(0, 16);

    const hotShowsTop =
      settled[1].status === "fulfilled"
        ? sortByChartRank(settled[1].value.map((e, i) => normalizeNode(e.node, null, i)).filter((x) => x.title && !x.isDoc)).slice(0, 14)
        : [];

    const hotMoviesTop =
      settled[2].status === "fulfilled"
        ? sortByChartRank(settled[2].value.map((e, i) => normalizeNode(e.node, null, i)).filter((x) => x.title && !x.isDoc)).slice(0, 14)
        : [];

    const chartsByPlatform = {};
    PLATFORM_DEFS.forEach((def, idx) => {
      const s = settled[idx + 3];
      chartsByPlatform[def.id] =
        s.status === "fulfilled" && s.value.length
          ? sortByChartRank(
              s.value.map((e, rankIdx) => normalizeNode(e.node, def.id, rankIdx)).filter((x) => x.title && !x.isDoc)
            ).slice(0, 10)
          : [];
    });
    REGION_DEFS.forEach((rg) => {
      const lists = [];
      REGION_TASKS.forEach((t, ti) => {
        if (t.rg !== rg) return;
        const s = settled[PLATFORM_DEFS.length + 3 + ti];
        if (s && s.status === "fulfilled" && s.value.length) lists.push(s.value);
      });
      chartsByPlatform[rg.id] = lists.length ? buildRegionChart(rg, lists) : [];
    });

    const totalFetched = Object.values(chartsByPlatform).reduce((acc, arr) => acc + arr.length, 0);

    res.status(200).json({
      ok: totalFetched > 0,
      source: "Dramov Live Charts",
      fetchedAt: new Date().toISOString(),
      providerIcons: Object.assign({}, usMeta.iconMap, iconMap),
      region: country,
      regionOf,
      heroNewShows,
      hotShowsTop,
      hotMoviesTop,
      globalTop: [...hotShowsTop.slice(0, 5), ...hotMoviesTop.slice(0, 5)],
      chartsByPlatform
    });
  } catch (err) {
    res.status(200).json({
      ok: false,
      error: String(err.message || err),
      providerIcons: {},
      heroNewShows: [],
      globalTop: [],
      chartsByPlatform: {}
    });
  }
};
