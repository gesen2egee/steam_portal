// ==UserScript==
// @name         Steam 玩家心得入口－特價與清單匯入
// @namespace    steam-portal-local
// @version      1.5.0
// @description  讓 Steam 單檔入口優先讀取中央價格，並從已登入的 Steam 清單匯入 App ID。
// @match        file:///*
// @match        https://gesen2egee.github.io/steam_portal/*
// @match        https://store.steampowered.com/*
// @match        https://steamcommunity.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      store.steampowered.com
// @connect      raw.githubusercontent.com
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  var PAGE_SOURCE = "steam-portal-page";
  var USERSCRIPT_SOURCE = "steam-portal-userscript";
  var REQUEST_TYPE = "steam-portal-sale-batch-request";
  var RESPONSE_TYPE = "steam-portal-sale-batch-response";
  var PRICE_REQUEST_TYPE = "steam-portal-price-snapshot-request";
  var PRICE_RESPONSE_TYPE = "steam-portal-price-snapshot-response";
  var MAX_BATCH_SIZE = 500;
  var STEAM_URL = "https://store.steampowered.com/api/appdetails/";
  var PRICE_SNAPSHOT_URL = "https://raw.githubusercontent.com/gesen2egee/steam_portal/main/data/price.json";
  var STEAM_USERDATA_URL = "https://store.steampowered.com/dynamicstore/userdata/";

  var IMPORT_REQUEST_KEY = "steam-portal-import-request-v1";
  var IMPORT_RESULT_KEY = "steam-portal-import-result-v1";
  var IMPORT_REQUEST_TYPE = "steam-portal-import-request";
  var IMPORT_RESULT_TYPE = "steam-portal-import-result";
  var IMPORT_REQUEST_MAX_AGE_MS = 10 * 60 * 1000;
  var IMPORT_SCAN_INTERVAL_MS = 900;
  var IMPORT_SCAN_STABLE_ROUNDS = 4;
  var IMPORT_SCAN_MAX_ROUNDS = 40;
  var WISHLIST_DATA_MAX_PAGES = 1000;
  var WISHLIST_DATA_DELAY_MS = 180;
  var handledImportRequests = Object.create(null);

  function isPortalPage() {
    return location.protocol === "file:" || (
      String(location.hostname || "").toLowerCase() === "gesen2egee.github.io" &&
      /^\/steam_portal(?:\/|$)/i.test(String(location.pathname || ""))
    );
  }

  function normalizeImportKind(value) {
    return value === "wishlist" || value === "owned" ? value : "";
  }

  function parseStoredValue(value) {
    if (!value) return null;
    if (typeof value === "object") return value;
    try {
      var parsed = JSON.parse(String(value));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  function normalizeAppIds(values) {
    if (!Array.isArray(values)) return [];
    var seen = Object.create(null);
    var result = [];
    values.forEach(function (value) {
      var appid = Number(value);
      if (!Number.isInteger(appid) || appid <= 0 || appid > 100000000) return;
      var key = String(appid);
      if (seen[key]) return;
      seen[key] = true;
      result.push(appid);
    });
    return result;
  }

  function sendPageMessage(message) {
    window.postMessage(Object.assign({ source: USERSCRIPT_SOURCE }, message), "*");
  }

  function publishImportResult(kind, requestId, ok, appids, error, complete) {
    var payload = {
      requestId: String(requestId || ""),
      kind: normalizeImportKind(kind),
      ok: !!ok,
      complete: complete !== false,
      appids: normalizeAppIds(appids),
      error: error ? String(error) : "",
      sentAt: Date.now()
    };
    if (!payload.kind) return;
    try {
      GM_setValue(IMPORT_RESULT_KEY, JSON.stringify(payload));
    } catch (storageError) {
      payload.ok = false;
      payload.complete = false;
      payload.appids = [];
      payload.error = "油猴無法傳回清單資料";
    }
    if (isPortalPage()) {
      sendPageMessage({ type: IMPORT_RESULT_TYPE, requestId: payload.requestId, kind: payload.kind, ok: payload.ok, complete: payload.complete, appids: payload.appids, error: payload.error, sentAt: payload.sentAt });
    }
  }

  function sendImportRequestToOtherTabs(message) {
    try {
      GM_setValue(IMPORT_REQUEST_KEY, JSON.stringify({
        requestId: String(message.requestId || ""),
        kind: normalizeImportKind(message.kind),
        silent: !!message.silent,
        requestedAt: Date.now()
      }));
    } catch (error) {
      sendPageMessage({ type: IMPORT_RESULT_TYPE, requestId: String(message.requestId || ""), kind: normalizeImportKind(message.kind), ok: false, complete: false, appids: [], error: "油猴無法聯絡 Steam 分頁" });
    }
  }

  function pageKind() {
    var host = String(location.hostname || "").toLowerCase();
    var path = String(location.pathname || "").toLowerCase();
    if (host === "store.steampowered.com" && /^\/wishlist(?:\/|$)/.test(path)) return "wishlist";
    if (host === "store.steampowered.com" && /^\/library(?:\/|$)/.test(path)) return "owned";
    if (host === "steamcommunity.com" && /^\/(?:my|id\/[^/]+|profiles\/\d+)\/wishlist(?:\/|$)/.test(path)) return "wishlist";
    if (host === "steamcommunity.com" && /^\/(?:my|id\/[^/]+|profiles\/\d+)\/games(?:\/|$)/.test(path)) return "owned";
    return "";
  }

  function addAppId(value, result, seen) {
    var matches = String(value || "").match(/\d{1,9}/g) || [];
    matches.forEach(function (raw) {
      var appid = Number(raw);
      if (!Number.isInteger(appid) || appid <= 0 || appid > 100000000) return;
      var key = String(appid);
      if (seen[key]) return;
      seen[key] = true;
      result.push(appid);
    });
  }

  function addHrefAppId(value, result, seen) {
    var match = String(value || "").match(/(?:^|\/)(?:app|games)\/(\d+)(?:\/|$|[?#])/i);
    if (match) addAppId(match[1], result, seen);
  }

  function collectElementAppIds(element, result, seen) {
    ["data-ds-appid", "data-appid", "data-app-id"].forEach(function (attribute) {
      if (element.hasAttribute && element.hasAttribute(attribute)) addAppId(element.getAttribute(attribute), result, seen);
    });
    if (element.getAttribute) addHrefAppId(element.getAttribute("href"), result, seen);
  }

  function collectSelectorAppIds(selector, result, seen) {
    try {
      document.querySelectorAll(selector).forEach(function (element) {
        collectElementAppIds(element, result, seen);
      });
    } catch (error) {}
  }

  function collectEmbeddedStateAppIds(kind, result, seen) {
    var source = document.documentElement ? document.documentElement.innerHTML : "";
    var markers = kind === "wishlist" ? ["g_rgWishlistData", "g_rgWishlist"] : ["g_rgOwnedApps", "g_rgAppInfo"];
    markers.forEach(function (marker) {
      var start = source.indexOf(marker);
      if (start < 0) return;
      var chunk = source.slice(start, start + 1200000);
      var appidFields = /["']?appid["']?\s*[:=]\s*["']?(\d{1,9})/gi;
      var fieldMatch;
      while ((fieldMatch = appidFields.exec(chunk))) addAppId(fieldMatch[1], result, seen);
      var objectKeys = /(?:^|[,{]\s*)["']?(\d{2,9})["']?\s*:\s*\{/g;
      var keyMatch;
      while ((keyMatch = objectKeys.exec(chunk))) addAppId(keyMatch[1], result, seen);
      if (kind === "owned" && !result.length) {
        var numbers = chunk.match(/\b\d{3,8}\b/g) || [];
        numbers.forEach(function (value) { addAppId(value, result, seen); });
      }
    });
  }

  function collectImportAppIds(kind) {
    var result = [];
    var seen = Object.create(null);
    if (kind === "wishlist") {
      collectSelectorAppIds("#wishlist_ctn [data-ds-appid], .wishlist_row, .wishlist_item, [id^='WishlistItem_'], [id^='wishlist_item_']", result, seen);
      collectSelectorAppIds("[data-ds-appid], [data-appid], [data-app-id]", result, seen);
      collectSelectorAppIds(".wishlist_row a[href], .wishlist_item a[href]", result, seen);
    } else if (kind === "owned") {
      collectSelectorAppIds(".gameListRow, .gameListRowItem, .gameListRowItemName, #games_list_rows [data-appid], #games_list_rows a[href], #library [data-appid], #library a[href]", result, seen);
      collectSelectorAppIds("[data-ds-appid], [data-appid], [data-app-id]", result, seen);
      collectSelectorAppIds(".gameListRow a[href], .gameListRowItem a[href], #games_list_rows a[href], #library a[href]", result, seen);
    }
    if (!result.length) collectSelectorAppIds("a[href*='/app/'], a[href*='/games/']", result, seen);
    collectEmbeddedStateAppIds(kind, result, seen);
    return normalizeAppIds(result);
  }

  function importError(kind) {
    return kind === "wishlist" ? "願望清單頁沒有讀到 App ID；請確認已登入並讓清單載入完成" : "遊戲清單頁沒有讀到 App ID；請確認已登入並讓清單載入完成";
  }

  function pageSource() {
    return document.documentElement ? document.documentElement.innerHTML : "";
  }

  function currentOrigin() {
    if (location.origin) return location.origin;
    return String(location.protocol || "") + "//" + String(location.host || "");
  }

  function wishlistDataBaseUrl() {
    try {
      if (typeof window.g_strWishlistBaseURL === "string" && window.g_strWishlistBaseURL) return window.g_strWishlistBaseURL;
    } catch (error) {}
    var source = pageSource();
    var match = source.match(/g_strWishlistBaseURL\s*=\s*["']([^"']+)["']/i);
    if (match && match[1]) return match[1];

    var host = String(location.hostname || "").toLowerCase();
    var path = String(location.pathname || "");
    if (host === "steamcommunity.com") {
      var profileMatch = path.match(/^\/profiles\/(\d+)\/wishlist(?:\/|$)/i);
      if (profileMatch) return "https://store.steampowered.com/wishlist/profiles/" + profileMatch[1] + "/";
      var vanityMatch = path.match(/^\/id\/([^/]+)\/wishlist(?:\/|$)/i);
      if (vanityMatch) return "https://store.steampowered.com/wishlist/id/" + vanityMatch[1] + "/";
      if (/^\/my\/wishlist(?:\/|$)/i.test(path)) return "https://store.steampowered.com/wishlist/";
    }
    if (host === "store.steampowered.com" && /^\/wishlist(?:\/|$)/i.test(path)) {
      var storeProfileMatch = path.match(/^\/wishlist\/profiles\/(\d+)(?:\/|$)/i);
      if (storeProfileMatch) return currentOrigin() + "/wishlist/profiles/" + storeProfileMatch[1] + "/";
      var storeVanityMatch = path.match(/^\/wishlist\/id\/([^/]+)(?:\/|$)/i);
      if (storeVanityMatch) return currentOrigin() + "/wishlist/id/" + storeVanityMatch[1] + "/";
      var steamIdMatch = source.match(/(?:var\s+)?g_steamID\s*=\s*["'](\d{10,20})["']/i);
      if (steamIdMatch) return currentOrigin() + "/wishlist/profiles/" + steamIdMatch[1] + "/";
      return currentOrigin() + "/wishlist/";
    }
    return "";
  }

  function wishlistDataUrl(baseUrl, page) {
    var base = String(baseUrl || "").replace(/[?#].*$/, "").replace(/\/+$/, "/");
    if (!base) return "";
    if (!/\/wishlistdata\/$/i.test(base)) base += "wishlistdata/";
    return base + "?p=" + encodeURIComponent(String(page));
  }

  function collectWishlistValueAppIds(value, result, seen, depth) {
    if (!value || depth > 5) return;
    if (typeof value !== "object") {
      if (/^\d+$/.test(String(value))) addAppId(value, result, seen);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(function (item) { collectWishlistValueAppIds(item, result, seen, depth + 1); });
      return;
    }
    if (typeof value !== "object") return;
    Object.keys(value).forEach(function (key) {
      if (/^app_?id$/i.test(key)) addAppId(value[key], result, seen);
      if (/^\d{2,9}$/.test(key)) addAppId(key, result, seen);
      var item = value[key];
      if (!item || typeof item !== "object") return;
      if (Object.prototype.hasOwnProperty.call(item, "appid")) addAppId(item.appid, result, seen);
      collectWishlistValueAppIds(item, result, seen, depth + 1);
    });
  }

  function parseWishlistDataObject(parsed) {
    if (!parsed || typeof parsed !== "object") return { ok: false, error: "Steam 願望清單沒有回傳有效資料" };
    if (parsed.success === false || parsed.error) return { ok: false, error: "Steam 願望清單回傳錯誤" };
    var appids = [];
    collectWishlistValueAppIds(parsed, appids, Object.create(null), 0);
    return { ok: true, appids: normalizeAppIds(appids) };
  }

  function parseSteamUserDataObject(parsed) {
    if (!parsed || typeof parsed !== "object" || !Object.prototype.hasOwnProperty.call(parsed, "rgWishlist")) {
      return { ok: false, error: "Steam 使用者資料沒有願望清單欄位" };
    }
    var appids = [];
    collectWishlistValueAppIds(parsed.rgWishlist, appids, Object.create(null), 0);
    return { ok: true, appids: normalizeAppIds(appids) };
  }

  function claimImportRequest(request) {
    var kind = normalizeImportKind(request && request.kind);
    var requestId = String(request && request.requestId || "");
    if (!kind || !requestId || pageKind() !== kind || handledImportRequests[requestId]) return false;
    handledImportRequests[requestId] = true;
    return true;
  }

  function fetchWishlistSnapshot(request, onProgress, onComplete) {
    var kind = normalizeImportKind(request && request.kind);
    var requestId = String(request && request.requestId || "");
    var appids = [];
    var seen = Object.create(null);
    var page = 0;
    var settled = false;

    function merge(values) {
      var before = appids.length;
      normalizeAppIds(values).forEach(function (appid) {
        var key = String(appid);
        if (seen[key]) return;
        seen[key] = true;
        appids.push(appid);
      });
      return appids.length !== before;
    }

    function finish(ok, error) {
      if (settled) return;
      settled = true;
      var result = { ok: !!ok, appids: normalizeAppIds(appids), error: error ? String(error) : "" };
      publishImportResult(kind, requestId, result.ok, result.appids, result.error, result.ok);
      if (typeof onComplete === "function") onComplete(result);
    }

    function embeddedWishlistAppIds() {
      var values = [];
      var embeddedSeen = Object.create(null);
      collectEmbeddedStateAppIds("wishlist", values, embeddedSeen);
      return normalizeAppIds(values);
    }

    function pageLooksLoggedIn() {
      var source = pageSource();
      return /g_steamID\s*=\s*["']\d{10,20}["']/i.test(source) || /g_bLoggedIn\s*=\s*true/i.test(source) || /g_rgWishlistData/i.test(source);
    }

    function finishFromEmbedded(error) {
      var embedded = embeddedWishlistAppIds();
      if (embedded.length) {
        merge(embedded);
        if (typeof onProgress === "function") onProgress(appids.length, "頁面");
        finish(true, "");
        return;
      }
      finish(false, error || importError(kind));
    }

    function requestJson(url, onSuccess, onFailure) {
      try {
        GM_xmlhttpRequest({
          method: "GET",
          url: url,
          timeout: 45000,
          withCredentials: true,
          headers: { Accept: "application/json, text/plain, */*" },
          onload: function (response) {
            if (settled) return;
            if (response.status < 200 || response.status >= 300) {
              onFailure("Steam 回應 HTTP " + response.status);
              return;
            }
            var parsed;
            try {
              parsed = JSON.parse(String(response.responseText || "").replace(/^\uFEFF/, ""));
            } catch (error) {
              onFailure("Steam 回傳的資料格式無法讀取");
              return;
            }
            onSuccess(parsed);
          },
          onerror: function () { onFailure("無法連線到 Steam"); },
          ontimeout: function () { onFailure("Steam 請求逾時"); },
          onabort: function () { onFailure("Steam 請求被中止"); }
        });
      } catch (error) {
        onFailure("油猴腳本無法建立 Steam 請求");
      }
    }

    function readWishlistDataPage(baseUrl) {
      if (settled) return;
      if (page >= WISHLIST_DATA_MAX_PAGES) {
        finishFromEmbedded("願望清單頁數超過安全上限，未更新原有清單");
        return;
      }
      var url = wishlistDataUrl(baseUrl, page);
      if (!url) {
        finishFromEmbedded(importError(kind));
        return;
      }
      requestJson(url, function (raw) {
        var parsed = parseWishlistDataObject(raw);
        if (!parsed.ok) {
          finishFromEmbedded(parsed.error || importError(kind));
          return;
        }
        var changed = merge(parsed.appids);
        if (typeof onProgress === "function") onProgress(appids.length, page + 1);
        if (!parsed.appids.length || (!changed && page > 0)) {
          if (!parsed.appids.length && !appids.length && !pageLooksLoggedIn()) {
            finishFromEmbedded("Steam 願望清單沒有回傳登入資料");
            return;
          }
          finish(true, "");
          return;
        }
        page += 1;
        window.setTimeout(function () { readWishlistDataPage(baseUrl); }, WISHLIST_DATA_DELAY_MS);
      }, function (error) {
        finishFromEmbedded("Steam 願望清單資料無法讀取：" + error);
      });
    }

    function readDetailedWishlistData(error) {
      var baseUrl = wishlistDataBaseUrl();
      if (!baseUrl) {
        finishFromEmbedded(error || importError(kind));
        return;
      }
      page = 0;
      readWishlistDataPage(baseUrl);
    }

    requestJson(STEAM_USERDATA_URL, function (raw) {
      var parsed = parseSteamUserDataObject(raw);
      if (!parsed.ok) {
        readDetailedWishlistData(parsed.error);
        return;
      }
      var values = parsed.appids;
      if (!values.length) {
        var embedded = embeddedWishlistAppIds();
        if (embedded.length) values = embedded;
      }
      merge(values);
      if (typeof onProgress === "function") onProgress(appids.length, 1);
      if (!values.length && !pageLooksLoggedIn()) {
        readDetailedWishlistData("Steam 使用者資料沒有確認登入狀態");
        return;
      }
      finish(true, "");
    }, function (error) {
      readDetailedWishlistData("Steam 使用者資料無法讀取：" + error);
    }
    );
  }

  function scrollImportPage(kind) {
    var selector = kind === "wishlist" ? "#wishlist_ctn, .wishlist_page, .wishlist_container" : "#games_list_rows, .games_list, #library";
    var container = null;
    try { container = document.querySelector(selector); } catch (error) {}
    if (container && container.scrollHeight > container.clientHeight + 8) {
      container.scrollTop = container.scrollHeight;
    }
    try {
      var documentHeight = Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
      window.scrollTo(0, documentHeight);
    } catch (error) {}
  }

  function scanImportPage(request, onProgress, onComplete) {
    var kind = normalizeImportKind(request.kind);
    var requestId = String(request.requestId || "");
    if (!claimImportRequest(request)) return;
    var appids = [];
    var seen = Object.create(null);
    var stableRounds = 0;
    var rounds = 0;

    function merge(values) {
      var before = appids.length;
      normalizeAppIds(values).forEach(function (appid) {
        var key = String(appid);
        if (seen[key]) return;
        seen[key] = true;
        appids.push(appid);
      });
      return appids.length !== before;
    }

    function finish() {
      var normalized = normalizeAppIds(appids);
      publishImportResult(kind, requestId, !!normalized.length, normalized, normalized.length ? "" : importError(kind), true);
      if (typeof onComplete === "function") onComplete(normalized);
    }

    function scan() {
      var changed = merge(collectImportAppIds(kind));
      rounds += 1;
      stableRounds = changed ? 0 : stableRounds + 1;
      if (!request.silent) scrollImportPage(kind);
      if (typeof onProgress === "function") onProgress(appids.length, rounds);
      if (rounds >= IMPORT_SCAN_MAX_ROUNDS || (appids.length && stableRounds >= IMPORT_SCAN_STABLE_ROUNDS)) {
        finish();
        return;
      }
      window.setTimeout(scan, IMPORT_SCAN_INTERVAL_MS);
    }
    scan();
  }

  function runImportRequest(request, onProgress, onComplete) {
    var kind = normalizeImportKind(request && request.kind);
    if (kind === "wishlist") {
      if (!claimImportRequest(request)) return;
      fetchWishlistSnapshot(request, onProgress, onComplete);
      return;
    }
    scanImportPage(request, onProgress, function (appids) {
      if (typeof onComplete === "function") onComplete({ ok: !!appids.length, appids: appids, error: appids.length ? "" : importError(kind) });
    });
  }

  function importFromCurrentPage(request) {
    runImportRequest(request, function () {}, null);
  }

  function handleImportRequest(value) {
    var request = parseStoredValue(value);
    if (!request || !normalizeImportKind(request.kind) || !request.requestId) return;
    if (Date.now() - Number(request.requestedAt || 0) > IMPORT_REQUEST_MAX_AGE_MS) return;
    importFromCurrentPage(request);
  }

  function injectImportButton(kind) {
    if (!document.body || !kind || document.getElementById("steam-portal-import-panel")) return;
    var panel = document.createElement("div");
    panel.id = "steam-portal-import-panel";
    panel.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:9px 10px;color:#d6e8f7;background:rgba(20,31,45,.96);border:1px solid rgba(102,192,244,.7);border-radius:7px;box-shadow:0 5px 18px rgba(0,0,0,.45);font:12px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = kind === "wishlist" ? "匯入願望清單" : "匯入已擁有遊戲";
    button.style.cssText = "min-height:30px;padding:5px 10px;color:#fff;background:#1a9fff;border:1px solid #66c0f4;border-radius:5px;font:inherit;cursor:pointer";
    var note = document.createElement("span");
    note.textContent = "傳回入口";
    note.style.cssText = "color:#a8b9c8;white-space:nowrap";
    button.addEventListener("click", function () {
      button.disabled = true;
      button.textContent = "讀取中…";
      note.textContent = "正在讀取清單";
      runImportRequest({
        kind: kind,
        requestId: "manual-" + Date.now() + "-" + Math.random().toString(36).slice(2),
        silent: false
      }, function (count, round) {
        note.textContent = "正在讀取清單 " + count + " 款";
      }, function (result) {
        button.disabled = false;
        button.textContent = kind === "wishlist" ? "匯入願望清單" : "匯入已擁有遊戲";
        note.textContent = result.ok ? "已傳回 " + result.appids.length + " 款" : String(result.error || "沒有讀到 App ID");
      });
    });
    panel.appendChild(button);
    panel.appendChild(note);
    document.body.appendChild(panel);
  }

  function initImportPage() {
    var kind = pageKind();
    if (!kind) return;
    injectImportButton(kind);
    try { handleImportRequest(GM_getValue(IMPORT_REQUEST_KEY, "")); } catch (error) {}
  }

  function buildItems(appids, responseBody) {
    return appids.map(function (appid) {
      var entry = responseBody && responseBody[String(appid)];
      if (!entry || typeof entry !== "object" || !entry.success) {
        return { appid: appid, success: false, error: "Steam 未回傳此 App ID 的資料" };
      }
      return { appid: appid, success: true, data: entry.data || {} };
    });
  }

  function requestSteamBatch(requestId, appids) {
    var encodedAppIds = encodeURIComponent(appids.join(","));
    var url = STEAM_URL + "?appids=" + encodedAppIds + "&cc=tw&l=tchinese&filters=price_overview";
    var settled = false;

    function fail(message) {
      if (settled) return;
      settled = true;
      sendResponse(requestId, false, [], message);
    }

    try {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        timeout: 45000,
        headers: { Accept: "application/json" },
        onload: function (response) {
          if (settled) return;
          if (response.status < 200 || response.status >= 300) {
            fail("Steam 回應 HTTP " + response.status);
            return;
          }
          var parsed;
          try {
            parsed = JSON.parse(response.responseText || "{}");
          } catch (error) {
            fail("Steam 回傳的資料格式無法讀取");
            return;
          }
          settled = true;
          sendResponse(requestId, true, buildItems(appids, parsed), "");
        },
        onerror: function () { fail("無法連線到 Steam"); },
        ontimeout: function () { fail("Steam 請求逾時"); },
        onabort: function () { fail("Steam 請求被中止"); }
      });
    } catch (error) {
      fail("油猴腳本無法建立 Steam 請求");
    }
  }

  function requestPriceSnapshot(requestId) {
    var separator = PRICE_SNAPSHOT_URL.indexOf("?") >= 0 ? "&" : "?";
    var url = PRICE_SNAPSHOT_URL + separator + "v=" + encodeURIComponent(String(Date.now()));
    var settled = false;

    function fail(message) {
      if (settled) return;
      settled = true;
      sendPageMessage({ type: PRICE_RESPONSE_TYPE, requestId: requestId, ok: false, payload: null, error: message });
    }

    try {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        timeout: 30000,
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        onload: function (response) {
          if (settled) return;
          if (response.status < 200 || response.status >= 300) {
            fail("GitHub price.json HTTP " + response.status);
            return;
          }
          var parsed;
          try {
            parsed = JSON.parse(response.responseText || "{}");
          } catch (error) {
            fail("GitHub price.json 格式無法讀取");
            return;
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            fail("GitHub price.json 不是有效物件");
            return;
          }
          settled = true;
          sendPageMessage({ type: PRICE_RESPONSE_TYPE, requestId: requestId, ok: true, payload: parsed, error: "" });
        },
        onerror: function () { fail("無法連線到 GitHub price.json"); },
        ontimeout: function () { fail("GitHub price.json 請求逾時"); },
        onabort: function () { fail("GitHub price.json 請求被中止"); }
      });
    } catch (error) {
      fail("油猴腳本無法建立 price.json 請求");
    }
  }

  function sendResponse(requestId, ok, items, error) {
    window.postMessage({
      source: USERSCRIPT_SOURCE,
      type: RESPONSE_TYPE,
      requestId: requestId,
      ok: !!ok,
      items: Array.isArray(items) ? items : [],
      error: error ? String(error) : ""
    }, "*");
  }

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message) return;
    if (isPortalPage() && message.source === PAGE_SOURCE && message.type === PRICE_REQUEST_TYPE) {
      var priceRequestId = String(message.requestId || "");
      if (!priceRequestId) return;
      requestPriceSnapshot(priceRequestId);
      return;
    }
    if (message.source === PAGE_SOURCE && message.type === REQUEST_TYPE) {
      var requestId = String(message.requestId || "");
      var appids = normalizeAppIds(message.appids);
      if (!requestId) return;
      if (!appids.length) {
        sendResponse(requestId, false, [], "批次沒有有效的 App ID");
        return;
      }
      if (appids.length > MAX_BATCH_SIZE) {
        sendResponse(requestId, false, [], "單批最多 500 個 App ID");
        return;
      }
      requestSteamBatch(requestId, appids);
      return;
    }
    if (isPortalPage() && message.source === PAGE_SOURCE && message.type === IMPORT_REQUEST_TYPE) {
      sendImportRequestToOtherTabs(message);
    }
  });

  try {
    GM_addValueChangeListener(IMPORT_REQUEST_KEY, function (key, oldValue, newValue) {
      handleImportRequest(newValue);
    });
    GM_addValueChangeListener(IMPORT_RESULT_KEY, function (key, oldValue, newValue) {
      if (!isPortalPage()) return;
      var result = parseStoredValue(newValue);
      if (!result || !normalizeImportKind(result.kind)) return;
      sendPageMessage({ type: IMPORT_RESULT_TYPE, requestId: String(result.requestId || ""), kind: normalizeImportKind(result.kind), ok: !!result.ok, complete: result.complete !== false, appids: normalizeAppIds(result.appids), error: String(result.error || ""), sentAt: Number(result.sentAt || 0) });
    });
  } catch (error) {}

  if (!isPortalPage()) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initImportPage, { once: true });
    else initImportPage();
  }
}());
