// Dramov v8 Serverless Function: Endless Streaming Catalog
// Supports:
// 1) Per-platform '热播库' (feedType=platform): Movies & TV Shows ONLY (no documentaries), sorted by Score Desc -> Year Desc.
// 2) Cross-platform '热播电视剧' (feedType=hot_shows) & '热播电影' (feedType=hot_movies): All 6 platforms mixed, sorted PURELY by popularity!

const GRAPHQL_ENDPOINT = "https://apis.justwatch.com/graphql";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PLATFORM_DEFS = {
  netflix: { id: "netflix", matchNames: ["netflix"], fallbackCodes: ["nfx"] },
  disney: { id: "disney", matchNames: ["disney plus", "disney+"], fallbackCodes: ["dnp"] },
  hbo: { id: "hbo", matchNames: ["max", "hbo max"], fallbackCodes: ["mxx", "hbm"] },
  prime: { id: "prime", matchNames: ["amazon prime video", "prime video"], fallbackCodes: ["amp", "prv"] },
  paramount: { id: "paramount", matchNames: ["paramount plus", "paramount+"], fallbackCodes: ["pmp"] },
  apple: { id: "apple", matchNames: ["apple tv+", "apple tv plus", "apple tv"], fallbackCodes: ["atp"] },
  hulu: { id: "hulu", matchNames: ["hulu"], fallbackCodes: ["hlu"] },
  peacock: { id: "peacock", matchNames: ["peacock", "peacock premium", "peacock premium plus"], fallbackCodes: ["pct", "pcp"] }
};

// 地区专区（与 charts.js 保持一致）
const REGION_DEFS = {
  gat: { id: "gat", country: "TW", productionCountries: ["TW", "HK", "MO"] },
  jk: { id: "jk", country: "US", productionCountries: ["JP", "KR"] }
};

const SCORE_BANDS = [
  { min: 8.6, max: 10.0 },
  { min: 8.1, max: 8.59 },
  { min: 7.7, max: 8.09 },
  { min: 7.3, max: 7.69 },
  { min: 6.8, max: 7.29 },
  { min: 6.0, max: 6.79 }
];

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
  hst: "历史",
  war: "战争",
  mys: "悬疑",
  fmly: "家庭",
  wsn: "西部"
};

function withTimeout(promise, ms = 6200) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
  ]);
}

async function queryUpstream(query, variables = {}, timeoutMs = 6200) {
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
  }
}
`;

const CATALOG_PAGE_QUERY = `
query GetPlatformCatalog($country: Country!, $first: Int!, $after: String, $filter: TitleFilter) {
  popularTitles(country: $country, first: $first, after: $after, sortBy: POPULAR, filter: $filter) {
    pageInfo {
      hasNextPage
      endCursor
    }
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

async function resolveCodeMap(country = "US") {
  const map = {};
  Object.values(PLATFORM_DEFS).forEach((d) => { map[d.id] = [...d.fallbackCodes]; });
  try {
    const res = await queryUpstream(PACKAGES_QUERY, { country, platform: "WEB" }, 3500);
    const pkgs = res?.data?.packages || [];
    Object.values(PLATFORM_DEFS).forEach((def) => {
      const matched = pkgs.filter((p) => {
        const cn = String(p.clearName || "").toLowerCase().trim();
        const tn = String(p.technicalName || "").toLowerCase().trim();
        return def.matchNames.some((m) => cn === m || tn === m.replace(/\s+/g, ""));
      });
      if (matched.length) {
        map[def.id] = Array.from(new Set([...matched.map((p) => p.shortName).filter(Boolean), ...def.fallbackCodes]));
      }
    });
  } catch (e) {}
  return map;
}

function normalizeCatalogNode(node, forcedPlatformId = null, rankOrder = 0) {
  const zh = node.contentZh || {};
  const en = node.contentEn || {};
  const sc = en.scoring || {};
  const isShow = node.objectType === "SHOW";
  const rawGenres = Array.isArray(en.genres) ? en.genres : [];

  // Strictly exclude Documentaries ('doc') per user preference!
  if (rawGenres.some((g) => g.shortName === "doc")) return null;

  const offers = Array.isArray(node.offers) ? node.offers : [];
  const providersSet = new Set();
  const providerLinks = {};
  const isRegion = Boolean(forcedPlatformId && REGION_DEFS[forcedPlatformId]);
  if (forcedPlatformId && !isRegion) providersSet.add(forcedPlatformId);

  const otherOffers = [];
  for (const off of offers) {
    const pid = mapShortToPlatformId(off.package?.shortName, off.package?.clearName);
    if (pid) {
      providersSet.add(pid);
      if (off.standardWebURL && !providerLinks[pid]) providerLinks[pid] = off.standardWebURL;
    } else if (
      off.package?.clearName &&
      (!off.monetizationType || ["FLATRATE", "FREE", "ADS"].includes(off.monetizationType)) &&
      !otherOffers.some((o) => o.name === off.package.clearName) &&
      otherOffers.length < 4
    ) {
      otherOffers.push({
        name: off.package.clearName,
        icon: off.package.icon ? formatImageUrl(off.package.icon, "s100") : "",
        url: off.standardWebURL || ""
      });
    }
  }

  const primaryPid = forcedPlatformId || Array.from(providersSet)[0] || "netflix";
  if (!isRegion) providersSet.add(primaryPid);

  const imdb = sc.imdbScore ? Number(Number(sc.imdbScore).toFixed(1)) : null;
  const tmdbScore = sc.tmdbScore ? Number(Number(sc.tmdbScore).toFixed(1)) : null;
  const finalScore = imdb || tmdbScore || 7.5;

  const tomato = sc.tomatoMeter ? Math.round(Number(sc.tomatoMeter)) : null;
  const popcornPct = tmdbScore
    ? Math.min(99, Math.max(55, Math.round(tmdbScore * 10)))
    : Math.min(98, Math.max(60, Math.round(finalScore * 10 + 3)));

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
    id: "cat_" + (node.id || node.objectId || Math.random().toString(36).slice(2)),
    jwId: node.id || "",
    title: zh.title || en.title || "",
    enTitle: en.title || zh.title || "",
    mediaType: isShow ? "show" : "movie",
    hasEpisodes: isShow,
    platformId: primaryPid,
    providers: Array.from(providersSet),
    providerLinks,
    otherOffers,
    heat: Math.round((Number(sc.tmdbPopularity) || Math.max(50, 1000 - rankOrder * 8)) * 10) / 10,
    imdb: finalScore,
    imdbVotes: sc.imdbVotes ? Number(sc.imdbVotes) : 0,
    tomatoPct: tomato,
    popcornPct,
    year: en.originalReleaseYear || 2025,
    releaseDate: en.originalReleaseDate || (en.originalReleaseYear ? `${en.originalReleaseYear}-01-01` : ""),
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

function sortScoreThenYearDesc(items) {
  return items.sort((a, b) => {
    const sa = Math.round((Number(a.imdb) || 0) * 10);
    const sb = Math.round((Number(b.imdb) || 0) * 10);
    if (sb !== sa) return sb - sa;
    const ya = Number(a.year) || 0;
    const yb = Number(b.year) || 0;
    if (yb !== ya) return yb - ya;
    const da = Date.parse(a.releaseDate || "") || 0;
    const db = Date.parse(b.releaseDate || "") || 0;
    if (db !== da) return db - da;
    return (Number(b.heat) || 0) - (Number(a.heat) || 0);
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");

  try {
    const q = req.query || {};
    const feedType = q.feedType ? String(q.feedType) : "platform"; // 'platform' | 'hot_shows' | 'hot_movies'
    const cursor = q.cursor ? String(q.cursor) : null;
    const country = "US";
    const codeMap = await resolveCodeMap(country);

    // =========================================================================
    // MODE A: Cross-Platform Pure Popularity Stream ('hot_shows' or 'hot_movies')
    // Preserves exact upstream POPULAR order (purely who is most watched/popular!)
    // =========================================================================
    if (feedType === "hot_shows" || feedType === "hot_movies") {
      const allSix = Array.from(new Set(Object.values(codeMap).flat()));
      const objTypes = feedType === "hot_shows" ? ["SHOW"] : ["MOVIE"];
      const rPop = await queryUpstream(CATALOG_PAGE_QUERY, {
        country,
        first: 50,
        after: cursor,
        filter: {
          packages: allSix,
          objectTypes: objTypes
        }
      });
      const conn = rPop?.data?.popularTitles;
      const items = Array.isArray(conn?.edges)
        ? conn.edges.map((e, idx) => normalizeCatalogNode(e.node, null, idx)).filter((x) => x && x.title)
        : [];
      const hasMore = Boolean(conn?.pageInfo?.hasNextPage && conn?.pageInfo?.endCursor);

      return res.status(200).json({
        ok: true,
        feedType,
        mode: "popular",
        nextBand: 0,
        nextCursor: hasMore ? conn.pageInfo.endCursor : "",
        hasMore,
        items
      });
    }

    // =========================================================================
    // MODE B: Single-Platform '热播库' (Sorted by Score Desc -> Year Desc!)
    // =========================================================================
    const region = REGION_DEFS[q.platform] || null;
    const platformId = region ? region.id : PLATFORM_DEFS[q.platform] ? q.platform : "netflix";
    const scopeCountry = region ? region.country : country;
    // 平台按上架服务筛，地区按出品国家筛
    const scopeFilter = region ? { productionCountries: region.productionCountries } : null;
    const bandIdx = Math.max(0, Math.min(SCORE_BANDS.length - 1, Number(q.band) || 0));
    const mode = q.mode ? String(q.mode) : "auto";
    const packages = codeMap[platformId] || PLATFORM_DEFS.netflix.fallbackCodes;
    const scope = (extra) => Object.assign(scopeFilter || { packages }, { objectTypes: ["SHOW", "MOVIE"] }, extra || {});
    const sort = ["curated", "new", "score"].includes(String(q.sort)) ? String(q.sort) : "score";

    // 精选：平台上正热门、且 IMDb ≥ 7.0 的片子，页内按“评分 + 新片加分”排序
    // 最新：近两年上线的新片新剧（剧集按首播年份），页内按上线日期从新到旧
    if (sort === "curated" || sort === "new") {
      const curYear = new Date().getUTCFullYear();
      const filter = scope(sort === "curated" ? { imdbScore: { min: 7.0 } } : { releaseYear: { min: curYear - 1 } });
      const rSort = await queryUpstream(CATALOG_PAGE_QUERY, { country: scopeCountry, first: 40, after: cursor, filter }).catch(() => null);
      const sConn = rSort?.data?.popularTitles;
      if (sConn && Array.isArray(sConn.edges)) {
        const nowMs = Date.now();
        const recencyBonus = (it) => {
          const days = (nowMs - (Date.parse(it.releaseDate || "") || 0)) / 86400000;
          return days <= 365 ? 0.8 : days <= 730 ? 0.4 : 0;
        };
        const items = sConn.edges.map((e, i) => normalizeCatalogNode(e.node, platformId, i)).filter((x) => x && x.title);
        if (sort === "curated") {
          items.sort((a, b) => (Number(b.imdb) + recencyBonus(b)) - (Number(a.imdb) + recencyBonus(a)));
        } else {
          items.sort((a, b) => (Date.parse(b.releaseDate || "") || 0) - (Date.parse(a.releaseDate || "") || 0) || (Number(b.year) || 0) - (Number(a.year) || 0));
        }
        const more = Boolean(sConn.pageInfo?.hasNextPage && sConn.pageInfo?.endCursor);
        return res.status(200).json({
          ok: true,
          feedType: "platform",
          mode: sort,
          platform: platformId,
          band: 0,
          nextBand: 0,
          nextCursor: more ? sConn.pageInfo.endCursor : "",
          hasMore: more,
          items
        });
      }
      // 上游失败时落到下面的按评分分段逻辑
    }

    if (mode !== "deep") {
      const band = SCORE_BANDS[bandIdx];
      const rBand = await queryUpstream(CATALOG_PAGE_QUERY, {
        country: scopeCountry,
        first: 60,
        after: cursor,
        filter: scope({ imdbScore: { min: band.min, max: band.max } })
      }).catch(() => null);

      const conn = rBand?.data?.popularTitles;
      if (conn && Array.isArray(conn.edges)) {
        const items = sortScoreThenYearDesc(
          conn.edges.map((e, i) => normalizeCatalogNode(e.node, platformId, i)).filter((x) => x && x.title)
        );
        const hasMoreInBand = Boolean(conn.pageInfo?.hasNextPage && conn.pageInfo?.endCursor);
        const nextBand = hasMoreInBand ? bandIdx : bandIdx + 1;
        const nextCursor = hasMoreInBand ? conn.pageInfo.endCursor : "";
        const hasMoreOverall = hasMoreInBand || nextBand < SCORE_BANDS.length;

        return res.status(200).json({
          ok: true,
          feedType: "platform",
          mode: "banded",
          platform: platformId,
          band: bandIdx,
          nextBand,
          nextCursor,
          hasMore: hasMoreOverall,
          items
        });
      }
    }

    let curAfter = cursor;
    let hasNext = true;
    const collected = [];
    for (let step = 0; step < 3 && hasNext; step++) {
      const rDeep = await queryUpstream(CATALOG_PAGE_QUERY, {
        country: scopeCountry,
        first: 65,
        after: curAfter,
        filter: scope()
      });
      const dConn = rDeep?.data?.popularTitles;
      if (!dConn || !Array.isArray(dConn.edges) || !dConn.edges.length) {
        hasNext = false;
        break;
      }
      dConn.edges.forEach((e, idx) => {
        const norm = normalizeCatalogNode(e.node, platformId, idx);
        if (norm && norm.title) collected.push(norm);
      });
      hasNext = Boolean(dConn.pageInfo?.hasNextPage && dConn.pageInfo?.endCursor);
      curAfter = hasNext ? dConn.pageInfo.endCursor : "";
    }

    sortScoreThenYearDesc(collected);

    return res.status(200).json({
      ok: true,
      feedType: "platform",
      mode: "deep",
      platform: platformId,
      band: 0,
      nextBand: 0,
      nextCursor: curAfter || "",
      hasMore: hasNext,
      items: collected
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: String(err.message || err),
      hasMore: false,
      items: []
    });
  }
};
