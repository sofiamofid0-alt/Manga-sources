(function () {
  "use strict";

  const BASE_URL = "https://mangatime.org";
  const ALLOWED_HOSTS = new Set(["mangatime.org"]);
  const MAX_BODY_BYTES = 2 * 1024 * 1024;
  const MAX_CHAPTER_PAGES = 50;

  const ADULT_KEYWORDS = new Set([
    "adult",
    "18+",
    "r-18",
    "hentai",
    "nsfw",
    "erotica",
    "smut",
    "pornographic"
  ]);

  const CHALLENGE_MARKERS = [
    "cf-browser-verification",
    "cf-challenge",
    "challenge-platform",
    "g-recaptcha",
    "hcaptcha",
    "just a moment...",
    "attention required! | cloudflare"
  ];

  const LOGIN_OR_DRM_MARKERS = [
    "login-required-wall",
    "please sign in to read",
    "drm-protected-content",
    "vip-paywall-locked"
  ];

  function decodeEntities(text) {
    if (typeof text !== "string") return "";
    return text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripTags(html) {
    if (typeof html !== "string") return "";
    return decodeEntities(html.replace(/<[^>]*>/g, " "));
  }

  function validateHttpsUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) {
      throw new Error("INVALID_URL: empty URL");
    }
    let resolved = rawUrl.trim();
    if (resolved.startsWith("/")) {
      resolved = BASE_URL + resolved;
    }
    let parsed;
    try {
      parsed = new URL(resolved);
    } catch (_err) {
      throw new Error("INVALID_URL: malformed URL");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("UNSAFE_PROTOCOL: HTTPS required");
    }
    if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new Error("UNDECLARED_HOST: " + parsed.hostname);
    }
    return parsed.toString();
  }

  function normalizeItemID(raw) {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error("INVALID_ITEM_ID");
    }
    const trimmed = raw.trim();
    if (trimmed.startsWith("https://")) {
      const valid = validateHttpsUrl(trimmed);
      const u = new URL(valid);
      return u.pathname.replace(/\/+$/, "");
    }
    const path = trimmed.startsWith("/") ? trimmed : "/" + trimmed;
    const clean = path.replace(/\/+$/, "");
    if (!/^\/manga\/[a-zA-Z0-9_-]+$/.test(clean)) {
      throw new Error("INVALID_ITEM_ID: " + clean);
    }
    return clean;
  }

  function normalizeChapterID(raw) {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error("INVALID_CHAPTER_ID");
    }
    const trimmed = raw.trim();
    if (trimmed.startsWith("https://")) {
      const valid = validateHttpsUrl(trimmed);
      const u = new URL(valid);
      return u.pathname.replace(/\/+$/, "");
    }
    const path = trimmed.startsWith("/") ? trimmed : "/" + trimmed;
    const clean = path.replace(/\/+$/, "");
    if (!/^\/manga\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/.test(clean)) {
      throw new Error("INVALID_CHAPTER_ID: " + clean);
    }
    return clean;
  }

  function containsAdultTag(tagsOrText) {
    const list = Array.isArray(tagsOrText) ? tagsOrText : [tagsOrText];
    for (const entry of list) {
      const lower = String(entry || "").toLowerCase().trim();
      if (ADULT_KEYWORDS.has(lower)) return true;
      for (const kw of ADULT_KEYWORDS) {
        if (lower.split(/[\s,;/|]+/).includes(kw)) return true;
      }
    }
    return false;
  }

  function assertSafeHtmlResponse(response, bodyText) {
    if (!response || typeof response.status !== "number") {
      throw new Error("NETWORK_ERROR: missing response status");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error("HTTP_ERROR: status " + response.status);
    }
    if (response.finalURL) {
      validateHttpsUrl(response.finalURL);
    }
    if (typeof bodyText !== "string" || !bodyText.trim()) {
      throw new Error("EMPTY_RESPONSE: body is empty");
    }
    if (bodyText.length > MAX_BODY_BYTES) {
      throw new Error("RESPONSE_TOO_LARGE");
    }
    const lower = bodyText.toLowerCase();
    for (const marker of CHALLENGE_MARKERS) {
      if (lower.includes(marker)) {
        throw new Error("CHALLENGE_BLOCKED: anti-bot or CAPTCHA page detected");
      }
    }
    for (const marker of LOGIN_OR_DRM_MARKERS) {
      if (lower.includes(marker)) {
        throw new Error("ACCESS_RESTRICTED: login, paywall, or DRM detected");
      }
    }
  }

  async function requestHtml(pathOrUrl) {
    const url = validateHttpsUrl(pathOrUrl);
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error("RUNTIME_MISSING_FETCHV2");
    }
    const response = await globalThis.fetchv2(url, {
      method: "GET",
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "Referer": BASE_URL + "/"
      }
    });
    const text = typeof response.text === "function"
      ? await response.text()
      : String(response.body || "");
    assertSafeHtmlResponse(response, text);
    return text;
  }

  function getAttr(tagHtml, attrName) {
    const regex = new RegExp(attrName + '=\\s*["\']([^"\']*)["\']', "i");
    const match = tagHtml.match(regex);
    return match ? decodeEntities(match[1]) : "";
  }

  function parseCardsFromRegion(regionHtml) {
    const items = [];
    const seen = new Set();
    const cardRegex = /<article\b[^>]*class=["'][^"']*\bmanga-card\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi;
    let match;
    while ((match = cardRegex.exec(regionHtml)) !== null) {
      const fullCard = match[0];
      const inner = match[1];
      const rawTags = getAttr(fullCard, "data-tags");
      const tagList = rawTags
        ? rawTags.split(",").map((t) => t.trim()).filter(Boolean)
        : [];
      if (containsAdultTag(tagList)) {
        continue;
      }

      const linkMatch = inner.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;

      let itemID;
      let href;
      try {
        itemID = normalizeItemID(linkMatch[1]);
        href = validateHttpsUrl(itemID);
      } catch (_err) {
        continue;
      }

      if (seen.has(itemID)) continue;

      const titleAttr = getAttr(fullCard, "data-title");
      const title = titleAttr || stripTags(linkMatch[2]);
      if (!title || containsAdultTag(title)) continue;

      const imgMatch = inner.match(/<img\b[^>]*>/i);
      let cover = "";
      if (imgMatch) {
        const rawCover = getAttr(imgMatch[0], "src") || getAttr(imgMatch[0], "data-src");
        if (rawCover) {
          try {
            cover = validateHttpsUrl(rawCover);
          } catch (_err) {
            cover = "";
          }
        }
      }

      const statusRaw = getAttr(fullCard, "data-status").toLowerCase();
      seen.add(itemID);
      items.push({
        itemID,
        title,
        href,
        cover,
        status: statusRaw || undefined
      });
    }
    return items;
  }

  function hasNextPageLink(html) {
    return /<a\b[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i.test(html);
  }

  function extractNextPageHref(html) {
    const m = html.match(/<a\b[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i);
    return m ? decodeEntities(m[1]) : null;
  }

  async function discoveryHome() {
    const html = await requestHtml(BASE_URL + "/");
    const sections = [];
    const sectionRegex = /<section\b([^>]*)>([\s\S]*?)<\/section>/gi;
    let match;
    while ((match = sectionRegex.exec(html)) !== null) {
      const attrs = match[1];
      const inner = match[2];
      const sectionID = getAttr(attrs, "data-section-id");
      const sectionTitle = getAttr(attrs, "data-section-title");
      if (!sectionID || !sectionTitle) continue;
      const items = parseCardsFromRegion(inner).map(({ itemID, title, href, cover }) => ({
        itemID,
        title,
        href,
        cover
      }));
      if (items.length > 0) {
        sections.push({
          id: sectionID,
          title: sectionTitle,
          items,
          hasMore: getAttr(attrs, "data-has-more") === "true"
        });
      }
    }
    if (sections.length === 0) {
      throw new Error("PARSE_ERROR: no discovery sections found");
    }
    return { sections };
  }

  async function discoveryFeed(feedID, page = 1) {
    if (typeof feedID !== "string" || !/^[a-z0-9_-]+$/i.test(feedID)) {
      throw new Error("INVALID_FEED_ID");
    }
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const html = await requestHtml(`${BASE_URL}/discover/${encodeURIComponent(feedID)}?page=${pageNum}`);
    const items = parseCardsFromRegion(html).map(({ itemID, title, href, cover }) => ({
      itemID,
      title,
      href,
      cover
    }));
    return {
      feedID,
      page: pageNum,
      items,
      hasMore: hasNextPageLink(html)
    };
  }

  async function searchResults(query, page = 1, filters = {}) {
    const cleanQuery = typeof query === "string" ? query.trim() : "";
    if (!cleanQuery) {
      throw new Error("INVALID_SEARCH_QUERY: query cannot be empty");
    }
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const params = new URLSearchParams();
    params.set("q", cleanQuery);
    params.set("page", String(pageNum));
    if (filters && typeof filters.status === "string" && filters.status.trim()) {
      params.set("status", filters.status.trim().toLowerCase());
    }

    const html = await requestHtml(`${BASE_URL}/search?${params.toString()}`);
    let cards = parseCardsFromRegion(html);

    if (filters && typeof filters.status === "string" && filters.status.trim()) {
      const targetStatus = filters.status.trim().toLowerCase();
      cards = cards.filter((c) => c.status === targetStatus);
    }

    const items = cards.map(({ itemID, title, href, cover }) => ({
      itemID,
      title,
      href,
      cover
    }));

    return {
      query: cleanQuery,
      page: pageNum,
      items,
      hasMore: hasNextPageLink(html)
    };
  }

  function normalizeStatus(rawStatus) {
    const s = String(rawStatus || "").toLowerCase().trim();
    if (s === "ongoing" || s === "releasing") return "ongoing";
    if (s === "completed" || s === "complete") return "completed";
    if (s === "hiatus" || s === "on hiatus") return "hiatus";
    if (s === "cancelled" || s === "canceled" || s === "dropped") return "cancelled";
    return "unknown";
  }

  async function extractDetails(itemID) {
    const canonicalID = normalizeItemID(itemID);
    const href = validateHttpsUrl(canonicalID);
    const html = await requestHtml(href);

    const titleMatch = html.match(/<h1\b[^>]*class=["'][^"']*\bmanga-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i);
    const title = titleMatch ? stripTags(titleMatch[1]) : "";
    if (!title) {
      throw new Error("PARSE_ERROR: missing manga title");
    }

    const tags = [];
    const tagRegex = /<a\b[^>]*class=["'][^"']*\bmanga-tag\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(html)) !== null) {
      const t = stripTags(tagMatch[1]);
      if (t && !tags.includes(t)) tags.push(t);
    }

    if (containsAdultTag(title) || containsAdultTag(tags)) {
      throw new Error("POLICY_REJECTED: adult-only content is not permitted");
    }

    const coverMatch = html.match(/<img\b[^>]*class=["'][^"']*\bmanga-cover\b[^"']*["'][^>]*>/i);
    let cover = "";
    if (coverMatch) {
      const rawCover = getAttr(coverMatch[0], "src");
      if (rawCover) cover = validateHttpsUrl(rawCover);
    }

    const descMatch = html.match(/<div\b[^>]*class=["'][^"']*\bmanga-description\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const description = descMatch ? stripTags(descMatch[1]) : "";

    const authorMatch = html.match(/<span\b[^>]*class=["'][^"']*\bmanga-author\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const author = authorMatch ? stripTags(authorMatch[1]) : "Unknown";

    const statusMatch = html.match(/<span\b[^>]*class=["'][^"']*\bmanga-status\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const status = normalizeStatus(statusMatch ? stripTags(statusMatch[1]) : "");

    return {
      itemID: canonicalID,
      title,
      href,
      cover,
      description,
      author,
      status,
      tags
    };
  }

  function parseChaptersFromHtml(html, canonicalItemID) {
    const chapters = [];
    const rowRegex = /<li\b[^>]*class=["'][^"']*\bchapter-item\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const rowTag = match[0];
      const inner = match[1];
      const linkMatch = inner.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;

      const chapterID = normalizeChapterID(linkMatch[1]);
      if (!chapterID.startsWith(canonicalItemID + "/")) {
        throw new Error("IDENTITY_MISMATCH: chapter does not belong to item " + canonicalItemID);
      }
      const href = validateHttpsUrl(chapterID);
      const title = stripTags(linkMatch[2]);
      const numRaw = getAttr(rowTag, "data-number");
      const number = numRaw !== "" && !Number.isNaN(Number(numRaw)) ? Number(numRaw) : undefined;

      chapters.push({
        chapterID,
        itemID: canonicalItemID,
        title,
        number,
        href
      });
    }
    return chapters;
  }

  async function extractChapters(itemID) {
    const canonicalID = normalizeItemID(itemID);
    let nextUrl = validateHttpsUrl(canonicalID + "/chapters?page=1");
    const visitedUrls = new Set();
    const seenChapters = new Set();
    const allChapters = [];

    for (let pageCount = 0; pageCount < MAX_CHAPTER_PAGES && nextUrl; pageCount += 1) {
      if (visitedUrls.has(nextUrl)) {
        break;
      }
      visitedUrls.add(nextUrl);

      const html = await requestHtml(nextUrl);
      const batch = parseChaptersFromHtml(html, canonicalID);
      for (const ch of batch) {
        if (!seenChapters.has(ch.chapterID)) {
          seenChapters.add(ch.chapterID);
          allChapters.push(ch);
        }
      }

      const nextHref = extractNextPageHref(html);
      nextUrl = nextHref ? validateHttpsUrl(nextHref) : null;
    }

    if (allChapters.length === 0) {
      throw new Error("PARSE_ERROR: no chapters found for " + canonicalID);
    }

    allChapters.sort((a, b) => {
      if (typeof a.number === "number" && typeof b.number === "number") {
        return a.number - b.number;
      }
      return 0;
    });

    return allChapters;
  }

  async function extractImages(chapterID) {
    const canonicalChapterID = normalizeChapterID(chapterID);
    const chapterUrl = validateHttpsUrl(canonicalChapterID);
    const html = await requestHtml(chapterUrl);

    const containerMatch = html.match(/<div\b[^>]*class=["'][^"']*\breader-images\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    if (!containerMatch) {
      throw new Error("PARSE_ERROR: reader container missing");
    }

    const pages = [];
    const seenUrls = new Set();
    const imgRegex = /<img\b[^>]*class=["'][^"']*\bpage-image\b[^"']*["'][^>]*>/gi;
    let match;
    while ((match = imgRegex.exec(containerMatch[1])) !== null) {
      const rawSrc = getAttr(match[0], "data-src") || getAttr(match[0], "src");
      if (!rawSrc) continue;
      const validUrl = validateHttpsUrl(rawSrc);
      if (seenUrls.has(validUrl)) continue;
      seenUrls.add(validUrl);
      pages.push({
        index: pages.length,
        url: validUrl,
        headers: {
          "Referer": chapterUrl
        }
      });
    }

    if (pages.length === 0) {
      throw new Error("EMPTY_CHAPTER_PAGES: no valid HTTPS images found");
    }

    return {
      chapterID: canonicalChapterID,
      pages
    };
  }

  globalThis.SynthetiqModule = {
    id: "mangatime-v1",
    familyID: "mangatime-v1",
    version: "0.1.0",
    discoveryHome,
    discoveryFeed,
    searchResults,
    extractDetails,
    extractChapters,
    extractImages
  };
})();
