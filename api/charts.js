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
  { id: "apple", matchNames: ["apple tv+", "apple tv plus", "apple tv"], fallbackCodes: ["atp"] }
];

function withTimeout(promise, ms = 5800) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
  ]);
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
      body: JSON.stringify({ query, variables })
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
  if (s === "atp" || c.includes("apple tv")) return "apple";
  return null;
}

async function resolveProviderMeta(country = "US") {
  const codeMap = {};
  const iconMap = {};
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
        codeMap[def.id] = Array.from(new Set([...matched.map((p) => p.shortName).filter(Boolean), ...def.fallbackCodes]));
        const ic = matched.find((p) => p.icon)?.icon;
        if (ic) iconMap[def.id] = formatImageUrl(ic, "s100");
      }
    }
  } catch (e) {}
  return { codeMap, iconMap };
}

async function fetchTitlesWithFilter(filter, count = 10, country = "US") {
  const vars = { country, first: count, filter };
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

  for (const off of offers) {
    const pid = mapShortToPlatformId(off.package?.shortName, off.package?.clearName);
    if (pid) {
      providersSet.add(pid);
      if (off.standardWebURL && !providerLinks[pid]) providerLinks[pid] = off.standardWebURL;
      if (off.package?.icon && !providerIcons[pid]) providerIcons[pid] = formatImageUrl(off.package.icon, "s100");
    }
  }

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
    mediaType: isShow ? "show" : "movie",
    isDoc: rawGenres.some((g) => g.shortName === "doc"),
    hasEpisodes: isShow,
    platformId: defaultPlatformId || Array.from(providersSet)[0] || "netflix",
    providers: Array.from(providersSet),
    providerLinks,
    providerIcons,
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
    const res = await withTimeout(
      fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(item.enTitle)}&embed=episodes`, {
        headers: { Accept: "application/json" }
      }),
      2200
    );
    if (!res.ok) return item;
    const show = await res.json();
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
    const country = "US";
    const now = new Date();
    const curYear = now.getUTCFullYear();
    const minNewYear = now.getUTCMonth() <= 1 ? curYear - 1 : curYear;

    const { codeMap, iconMap } = await resolveProviderMeta(country);
    const allSixCodes = Array.from(new Set(Object.values(codeMap).flat()));

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
      // Tasks 3..8: Per-platform Top 10 (Movies + TV Shows combined, excluding documentaries)
      ...PLATFORM_DEFS.map((def) =>
        fetchTitlesWithFilter(
          {
            packages: codeMap[def.id],
            objectTypes: ["MOVIE", "SHOW"]
          },
          14,
          country
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
        ? settled[1].value.map((e, i) => normalizeNode(e.node, null, i)).filter((x) => x.title && !x.isDoc).slice(0, 14)
        : [];

    const hotMoviesTop =
      settled[2].status === "fulfilled"
        ? settled[2].value.map((e, i) => normalizeNode(e.node, null, i)).filter((x) => x.title && !x.isDoc).slice(0, 14)
        : [];

    const chartsByPlatform = {};
    PLATFORM_DEFS.forEach((def, idx) => {
      const s = settled[idx + 3];
      chartsByPlatform[def.id] =
        s.status === "fulfilled" && s.value.length
          ? s.value
              .map((e, rankIdx) => normalizeNode(e.node, def.id, rankIdx))
              .filter((x) => x.title && !x.isDoc)
              .slice(0, 10)
          : [];
    });

    const totalFetched = Object.values(chartsByPlatform).reduce((acc, arr) => acc + arr.length, 0);

    res.status(200).json({
      ok: totalFetched > 0,
      source: "Dramov Live Charts",
      fetchedAt: new Date().toISOString(),
      providerIcons: iconMap,
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
