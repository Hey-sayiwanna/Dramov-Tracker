// Dramov v7 Serverless Function: Endless Acclaimed Platform Catalog
// Supports per-platform pagination (Netflix, Disney+, HBO Max, Prime Video, Paramount+, Apple TV+)
// mixing TV Series (剧集), Movies (电影), and Documentaries (纪录片), sorted by Score Desc -> Year Desc.

const GRAPHQL_ENDPOINT = "https://apis.justwatch.com/graphql";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PLATFORM_DEFS = {
  netflix: { id: "netflix", matchNames: ["netflix"], fallbackCodes: ["nfx"] },
  disney: { id: "disney", matchNames: ["disney plus", "disney+"], fallbackCodes: ["dnp"] },
  hbo: { id: "hbo", matchNames: ["max", "hbo max"], fallbackCodes: ["mxx", "hbm"] },
  prime: { id: "prime", matchNames: ["amazon prime video", "prime video"], fallbackCodes: ["amp", "prv"] },
  paramount: { id: "paramount", matchNames: ["paramount plus", "paramount+"], fallbackCodes: ["pmp"] },
  apple: { id: "apple", matchNames: ["apple tv+", "apple tv plus", "apple tv"], fallbackCodes: ["atp"] }
};

// Descending score bands so streaming batches stay globally ordered from 9.x -> 8.x -> 7.x -> 6.x
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
  doc: "纪录片",
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
  if (s === "atp" || c.includes("apple tv")) return "apple";
  return null;
}

async function resolvePackageCodes(platformId, country = "US") {
  const def = PLATFORM_DEFS[platformId] || PLATFORM_DEFS.netflix;
  let codes = [...def.fallbackCodes];
  try {
    const res = await queryUpstream(PACKAGES_QUERY, { country, platform: "WEB" }, 3500);
    const pkgs = res?.data?.packages || [];
    const matched = pkgs.filter((p) => {
      const cn = String(p.clearName || "").toLowerCase().trim();
      const tn = String(p.technicalName || "").toLowerCase().trim();
      return def.matchNames.some((m) => cn === m || tn === m.replace(/\s+/g, ""));
    });
    if (matched.length) {
      codes = Array.from(new Set([...matched.map((p) => p.shortName).filter(Boolean), ...def.fallbackCodes]));
    }
  } catch (e) {}
  return codes;
}

function normalizeCatalogNode(node, platformId) {
  const zh = node.contentZh || {};
  const en = node.contentEn || {};
  const sc = en.scoring || {};
  const isShow = node.objectType === "SHOW";
  const rawGenres = Array.isArray(en.genres) ? en.genres : [];
  const isDoc = rawGenres.some((g) => g.shortName === "doc");
  const offers = Array.isArray(node.offers) ? node.offers : [];

  const providersSet = new Set([platformId]);
  const providerLinks = {};
  for (const off of offers) {
    const pid = mapShortToPlatformId(off.package?.shortName, off.package?.clearName);
    if (pid) {
      providersSet.add(pid);
      if (off.standardWebURL && !providerLinks[pid]) providerLinks[pid] = off.standardWebURL;
    }
  }

  const imdb = sc.imdbScore ? Number(Number(sc.imdbScore).toFixed(1)) : null;
  const tmdbScore = sc.tmdbScore ? Number(Number(sc.tmdbScore).toFixed(1)) : null;
  const finalScore = imdb || tmdbScore || 0;
  if (!finalScore) return null;

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
    mediaType: isDoc ? "doc" : (isShow ? "show" : "movie"),
    hasEpisodes: isShow,
    platformId,
    providers: Array.from(providersSet),
    providerLinks,
    heat: Math.round((Number(sc.tmdbPopularity) || 100) * 10) / 10,
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
    genres: genres.length ? genres : [isDoc ? "纪录片" : (isShow ? "剧情" : "电影")],
    synopsis: zh.shortDescription || en.shortDescription || "",
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
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=7200");

  try {
    const q = req.query || {};
    const platformId = PLATFORM_DEFS[q.platform] ? q.platform : "netflix";
    const bandIdx = Math.max(0, Math.min(SCORE_BANDS.length - 1, Number(q.band) || 0));
    const cursor = q.cursor ? String(q.cursor) : null;
    const mode = q.mode ? String(q.mode) : "auto";
    const country = "US";

    const packages = await resolvePackageCodes(platformId, country);

    // Strategy 1: Score-band filtered GraphQL pagination so batches stay globally descending by score!
    if (mode !== "deep") {
      const band = SCORE_BANDS[bandIdx];
      const bandedFilter = {
        packages,
        objectTypes: ["SHOW", "MOVIE"],
        imdbScore: { min: band.min, max: band.max }
      };
      const rBand = await queryUpstream(CATALOG_PAGE_QUERY, {
        country,
        first: 60,
        after: cursor,
        filter: bandedFilter
      }).catch(() => null);

      const conn = rBand?.data?.popularTitles;
      if (conn && Array.isArray(conn.edges)) {
        const items = sortScoreThenYearDesc(
          conn.edges.map((e) => normalizeCatalogNode(e.node, platformId)).filter((x) => x && x.title)
        );
        const hasMoreInBand = Boolean(conn.pageInfo?.hasNextPage && conn.pageInfo?.endCursor);
        const nextBand = hasMoreInBand ? bandIdx : bandIdx + 1;
        const nextCursor = hasMoreInBand ? conn.pageInfo.endCursor : "";
        const hasMoreOverall = hasMoreInBand || nextBand < SCORE_BANDS.length;

        return res.status(200).json({
          ok: true,
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

    // Strategy 2 (Automatic Fallback): Deep multi-page cursor sweep (fetches ~180 titles per call & sorts by Score -> Year)
    let curAfter = cursor;
    let hasNext = true;
    const collected = [];
    for (let step = 0; step < 3 && hasNext; step++) {
      const rDeep = await queryUpstream(CATALOG_PAGE_QUERY, {
        country,
        first: 65,
        after: curAfter,
        filter: {
          packages,
          objectTypes: ["SHOW", "MOVIE"]
        }
      });
      const dConn = rDeep?.data?.popularTitles;
      if (!dConn || !Array.isArray(dConn.edges) || !dConn.edges.length) {
        hasNext = false;
        break;
      }
      dConn.edges.forEach((e) => {
        const norm = normalizeCatalogNode(e.node, platformId);
        if (norm && norm.title) collected.push(norm);
      });
      hasNext = Boolean(dConn.pageInfo?.hasNextPage && dConn.pageInfo?.endCursor);
      curAfter = hasNext ? dConn.pageInfo.endCursor : "";
    }

    sortScoreThenYearDesc(collected);

    return res.status(200).json({
      ok: true,
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
