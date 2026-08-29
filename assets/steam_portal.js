  (function () {
    "use strict";

    var SALE_SYNC_INTERVAL_MS = 8 * 60 * 60 * 1000;
    var SALE_BATCH_SIZE = 500;
    var SALE_BATCH_DELAY_MS = 1000;
    var SALE_RETRY_DELAYS_MS = [1000, 3000, 5000, 7000, 9000];
    var SALE_REQUEST_TIMEOUT_MS = 45000;
    var SALE_DAILY_SYNC_HOUR_PT = 10;
    var PRICE_SNAPSHOT_URL = "https://raw.githubusercontent.com/gesen2egee/steam_portal/main/data/price.json";
    var PRICE_SNAPSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
    var PRICE_SNAPSHOT_REQUEST_TIMEOUT_MS = 30000;
    var PRICE_STEPS = [0, 50, 100, 200, 300, 500, 800, 1200, 2000, 3000, 5000];
    var DISCOUNT_STEPS = [0, 10, 20, 30, 50, 75, 90];
    var RATING_STEPS = [0, 80, 85, 90, 95];
    var SALE_CHECKS_KEY = "steam_portal_live_prices_v1";
    var SALE_SYNC_STATE_KEY = "steam_portal_price_sync_v1";
    var SALE_PAGE_MESSAGE_SOURCE = "steam-portal-page";
    var SALE_USERSCRIPT_MESSAGE_SOURCE = "steam-portal-userscript";
    var SALE_BATCH_REQUEST_TYPE = "steam-portal-sale-batch-request";
    var SALE_BATCH_RESPONSE_TYPE = "steam-portal-sale-batch-response";
    var PRICE_SNAPSHOT_REQUEST_TYPE = "steam-portal-price-snapshot-request";
    var PRICE_SNAPSHOT_RESPONSE_TYPE = "steam-portal-price-snapshot-response";
    var IMPORT_USERSCRIPT_MESSAGE_SOURCE = "steam-portal-userscript";
    var IMPORT_REQUEST_TYPE = "steam-portal-import-request";
    var IMPORT_RESULT_TYPE = "steam-portal-import-result";
    var IMPORT_REQUEST_TIMEOUT_MS = 90000;
    var STATE_EXPORT_FORMAT = "steam-portal-state";
    var STATE_EXPORT_VERSION = 4;
    var STATE_EXPORT_SOURCE = "steam";
    var READ_GAMES_KEY = "steam_portal_read_games_v1";
    var RIVER_READ_FILTER_KEY = "steam_portal_river_read_filter_v1";
    var RIVERS_COLLAPSED_KEY = "steam_portal_rivers_collapsed_v2";
    var SPOILER_REVEALS_KEY = "steam_portal_spoiler_reveals_v1";
    var EXPORT_LAST_AT_KEY = "steam_portal_export_last_at_v1";
    var EXPORT_DUE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
    var EXPLORE_COMMON_TAGS = new Set([
      "單人", "獨立", "冒險", "休閒", "動作", "模擬", "角色扮演", "多人", "策略", "免費遊玩", "合作",
      "玩家對戰", "線上合作", "裸露", "搶先體驗", "暴力", "運動", "競速", "教育學習", "工具", "遊戲開發", "音訊製作"
    ].map(normalizeText));

    var dataElement = document.getElementById("gameData");
    var payload = window.__STEAM_PORTAL_DATA__ || { items: [] };
    if (!window.__STEAM_PORTAL_DATA__) {
      try {
        payload = JSON.parse(dataElement ? dataElement.textContent : "{}");
      } catch (error) {
        payload = { items: [] };
      }
    }

    var games = Array.isArray(payload.items) ? payload.items.map(normalizeGame) : [];
    var gameMap = Object.create(null);
    games.forEach(function (game) { gameMap[game.appid] = game; });
    var storageWorks = true;
    var storageReadyPromise = openPortalDatabase();
    var storageWriteQueue = Promise.resolve();
    var portalReady = false;
    var favorites = new Set();
    var readGames = new Set();
    var spoilerReveals = new Set();
    var lastExportAt = 0;
    var displayTraditionalNames = false;
    var saleChecks = Object.create(null);
    var saleSync = { lastRunAt: 0, lastResult: null, lastError: "", busy: false, progress: null };
    var priceSnapshot = { status: "loading", generatedAt: 0, itemCount: 0, lastError: "" };
    var saleSyncInitialPass = true;
    var saleSyncRetryBlockedUntil = 0;
    var importPending = null;
    var importTimeoutId = 0;
    var rivers = [];
    var fixedReadIdsCache = null;
    var riversCollapsed = true;
    var riverReadMode = "all";
    var pendingRiverSourceIds = null;
    var lastResults = [];
    var state = readUrlState();
    var pageSize = 48;
    var riverVisibleCount = pageSize;
    var riverLoadObserver = null;
    var portalToastTimer = null;
    var topicCounts = countTopicValues();

    var el = {
      browse: document.getElementById("browseView"),
      detail: document.getElementById("detailView"),
      searchForm: document.getElementById("searchForm"),
      searchInput: document.getElementById("searchInput"),
      resultCount: document.getElementById("resultCount"),
      gameList: document.getElementById("gameList"),
      pagination: document.getElementById("pagination"),
      activeFilters: document.getElementById("activeFilters"),
      sort: document.getElementById("sortSelect"),
      priceChoices: document.getElementById("priceChoices"),
      nameToggle: document.getElementById("nameToggleButton"),
      demoFilter: document.getElementById("demoFilter"),
      rating: document.getElementById("ratingFilter"),
      ratingValue: document.getElementById("ratingValue"),
      maxPrice: document.getElementById("maxPriceInput"),
      maxPriceValue: document.getElementById("maxPriceValue"),
      saleOnlyFilter: document.getElementById("saleOnlyFilter"),
      minDiscount: document.getElementById("minDiscountInput"),
      saleDiscountValue: document.getElementById("saleDiscountValue"),
      minYear: document.getElementById("minYearInput"),
      maxYear: document.getElementById("maxYearInput"),
      language: document.getElementById("languageFilter"),
      topicSearch: document.getElementById("topicSearchInput"),
      topicOptions: document.getElementById("topicOptions"),
      riverCount: document.getElementById("riverCount"),
      riverShortcuts: document.getElementById("riverShortcuts"),
      riverList: document.getElementById("riverList"),
      riverPanel: document.querySelector(".river-panel"),
      riverToggle: document.getElementById("riverToggle"),
      riverReadFilter: document.getElementById("riverReadFilter"),
      storageNote: document.getElementById("storageNote"),
      manualSaleSyncButton: document.getElementById("manualSaleSyncButton"),
      saleSyncAge: document.getElementById("saleSyncAge"),
      saleSyncOverlay: document.getElementById("saleSyncOverlay"),
      saleSyncLabel: document.getElementById("saleSyncLabel"),
      saleSyncProgressText: document.getElementById("saleSyncProgressText"),
      saleSyncProgressFill: document.getElementById("saleSyncProgressFill"),
      importWishlistButton: document.getElementById("importWishlistButton"),
      importOwnedButton: document.getElementById("importOwnedButton"),
      importStatus: document.getElementById("importStatus"),
      exportStateButton: document.getElementById("exportStateButton"),
      importStateButton: document.getElementById("importStateButton"),
      importStateFile: document.getElementById("importStateFile"),
      backupStatus: document.getElementById("backupStatus"),
      filters: document.getElementById("filtersPanel"),
      backdrop: document.getElementById("filtersBackdrop"),
      mobileFilter: document.getElementById("mobileFilterButton")
    };

    function finishPortalInitialization() {
      ensureDefaultRiver();
      resetFixedRiverPositions();
      prepareExploreRiver();
      var initialDefaultRiver = rivers.find(function (river) { return river.id === "default"; });
      if (!state.riverId && initialDefaultRiver && (state.q || state.topics.size)) pendingRiverSourceIds = initialDefaultRiver.ids.slice();
      reconcileDynamicRivers();
      portalReady = true;
      render();
      updateManualSaleSyncButton();
      updateSaleSyncAge();
      updateExportButton();
      window.setInterval(function () {
        updateSaleSyncAge();
        updateExportButton();
      }, 1000);
      startSaleSyncOnOpen();
    }

    function initializePortalState() {
      Promise.all([
        loadFavorites(),
        loadReadGames(),
        loadDisplayTraditionalNames(),
        loadSaleChecks(),
        loadSaleSyncState(),
        loadRivers(),
        loadRiversCollapsed(),
        loadRiverReadMode(),
        loadPriceSnapshot(),
        loadSpoilerReveals(),
        loadLastExportAt()
      ]).then(function (values) {
        favorites = values[0];
        readGames = values[1];
        displayTraditionalNames = values[2];
        saleChecks = values[3];
        saleSync = values[4];
        rivers = values[5];
        riversCollapsed = values[6];
        riverReadMode = values[7];
        applyPriceSnapshot(values[8]);
        spoilerReveals = values[9];
        lastExportAt = values[10];
        finishPortalInitialization();
      }).catch(function () {
        markStorageFailure();
        priceSnapshot = { status: "unavailable", generatedAt: 0, itemCount: 0, lastError: "無法初始化價格快照" };
        finishPortalInitialization();
      });
    }

    function normalizeGame(game) {
      var normalized = Object.assign({}, game);
      normalized.appid = String(game.appid || "");
      normalized.name = String(game.name || "");
      normalized.translated_name = String(game.translated_name || "");
      normalized.subtitle = String(game.subtitle || "");
      normalized.tags = Array.isArray(game.tags) ? game.tags.map(String) : [];
      normalized.genres = Array.isArray(game.genres) ? game.genres.map(String) : [];
      normalized.categories = Array.isArray(game.categories) ? game.categories.map(String) : [];
      normalized.developers = Array.isArray(game.developers) ? game.developers.map(String) : [];
      normalized.publishers = Array.isArray(game.publishers) ? game.publishers.map(String) : [];
      normalized.authors = Array.isArray(game.authors) ? game.authors.map(String) : normalized.developers.concat(normalized.publishers);
      normalized.topicGroups = buildTopicGroups(normalized);
      normalized.topics = normalized.topicGroups.reduce(function (all, group) { return all.concat(group.values); }, []);
      normalized.topicSet = new Set(normalized.topics.map(normalizeText));
      normalized.authorSet = new Set(normalized.authors);
      normalized.searchText = normalizeText([
        normalized.appid, normalized.name, normalized.translated_name,
        normalized.subtitle, normalized.topics.join(" "), normalized.authors.join(" ")
      ].join(" "));
      normalized.releaseYear = Number.isFinite(Number(game.release_year)) ? Number(game.release_year) : null;
      normalized.hasDemo = game.has_demo === true;
      normalized.priceValue = game.price_value === null || game.price_value === undefined ? null : Number(game.price_value);
      normalized.review = game.review && typeof game.review === "object" ? game.review : {};
      normalized.reviewPercent = Number(normalized.review.percent_positive || 0);
      normalized.reviewCount = Number(normalized.review.total_reviews || 0);
      normalized.languages = Array.isArray(game.chinese_languages) ? game.chinese_languages : [];
      var historicalLow = game.historical_low && typeof game.historical_low === "object" ? game.historical_low : null;
      var historicalLowValue = historicalLow && historicalLow.price_value !== null && historicalLow.price_value !== undefined ? Number(historicalLow.price_value) : null;
      normalized.historicalLow = historicalLow && Number.isFinite(historicalLowValue) ? {
        priceLabel: String(historicalLow.price_label || ""),
        priceValue: historicalLowValue
      } : null;
      normalized.updatedNs = Number(game.updated_ns || 0);
      return normalized;
    }

    function normalizeText(value) {
      return String(value || "").trim().toLocaleLowerCase();
    }

    function normalizeRatingValue(value) {
      var number = Number(value);
      if (!Number.isFinite(number) || number <= 0) return "0";
      var nearest = RATING_STEPS[1];
      RATING_STEPS.slice(1).forEach(function (step) {
        if (Math.abs(step - number) < Math.abs(nearest - number)) nearest = step;
      });
      return String(nearest);
    }

    function uniqueTopicValues(values) {
      var seen = new Set();
      var result = [];
      (Array.isArray(values) ? values : []).forEach(function (value) {
        var text = String(value || "").trim();
        var key = normalizeText(text);
        if (!key || seen.has(key)) return;
        seen.add(key);
        result.push(text);
      });
      return result;
    }

    function buildTopicGroups(game) {
      var seen = new Set();
      return [
        topicGroup("genre", game.genres, seen),
        topicGroup("tag", game.tags, seen),
        topicGroup("category", game.categories, seen)
      ].filter(function (group) { return group.values.length; });
    }

    function topicGroup(kind, values, seen) {
      var unique = uniqueTopicValues(values).filter(function (value) {
        var key = normalizeText(value);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { kind: kind, values: unique };
    }

    function escapeHtml(value) {
      return String(value === null || value === undefined ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function showPortalToast(message) {
      var toast = document.getElementById("portalToast");
      if (!toast) return;
      if (portalToastTimer) clearTimeout(portalToastTimer);
      toast.textContent = String(message || "");
      toast.classList.add("show");
      portalToastTimer = setTimeout(function () { toast.classList.remove("show"); }, 3200);
    }

    function safeUrl(value) {
      var url = String(value || "");
      return /^https?:\/\//i.test(url) ? url : "";
    }

    function openPortalDatabase() {
      return new Promise(function (resolve, reject) {
        if (!window.indexedDB) {
          reject(new Error("此瀏覽器不支援 IndexedDB"));
          return;
        }
        var request;
        try {
          request = window.indexedDB.open("steam_portal_state", 1);
        } catch (error) {
          reject(error);
          return;
        }
        request.onupgradeneeded = function (event) {
          var database = event.target.result;
          if (!database.objectStoreNames.contains("key_value")) database.createObjectStore("key_value");
        };
        request.onsuccess = function (event) { resolve(event.target.result); };
        request.onerror = function () { reject(request.error || new Error("IndexedDB 開啟失敗")); };
        request.onblocked = function () { reject(new Error("IndexedDB 被其他分頁鎖定")); };
      });
    }

    function markStorageFailure() {
      storageWorks = false;
      updateStorageNote();
    }

    function safeStorageGet(key) {
      return storageReadyPromise.then(function (database) {
        return new Promise(function (resolve, reject) {
          var transaction = database.transaction(["key_value"], "readonly");
          var request = transaction.objectStore("key_value").get(String(key));
          request.onsuccess = function () {
            resolve(request.result === undefined ? null : String(request.result));
          };
          request.onerror = function () { reject(request.error || new Error("IndexedDB 讀取失敗")); };
        });
      }).catch(function () {
        markStorageFailure();
        return null;
      });
    }

    function safeStorageSet(key, value) {
      storageWriteQueue = storageWriteQueue.catch(function () {}).then(function () {
        return storageReadyPromise.then(function (database) {
          return new Promise(function (resolve, reject) {
            var transaction = database.transaction(["key_value"], "readwrite");
            var request = transaction.objectStore("key_value").put(String(value), String(key));
            request.onsuccess = function () { resolve(); };
            request.onerror = function () { reject(request.error || new Error("IndexedDB 寫入失敗")); };
          });
        });
      }).catch(function () {
        markStorageFailure();
      });
      return storageWriteQueue;
    }

    function toEpochSeconds(value) {
      var number = Number(value);
      if (!Number.isFinite(number) || number <= 0) return null;
      return number > 100000000000 ? Math.floor(number / 1000) : Math.floor(number);
    }

    function parsePriceText(value) {
      var match = String(value || "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : null;
    }

    function normalizeSaleCheck(record) {
      if (!record || typeof record !== "object") return null;
      var priceValue = record.priceValue === null || record.priceValue === undefined ? null : Number(record.priceValue);
      var originalValue = record.originalValue === null || record.originalValue === undefined ? null : Number(record.originalValue);
      return {
        status: String(record.status || "unknown"),
        saleEnd: toEpochSeconds(record.saleEnd),
        priceCurrent: String(record.priceCurrent || ""),
        priceOriginal: String(record.priceOriginal || ""),
        priceValue: Number.isFinite(priceValue) ? priceValue : null,
        originalValue: Number.isFinite(originalValue) ? originalValue : null,
        discountPercent: Number(record.discountPercent || 0),
        syncedAt: Number(record.syncedAt || 0)
      };
    }

    function priceSnapshotRequestUrl() {
      var separator = PRICE_SNAPSHOT_URL.indexOf("?") >= 0 ? "&" : "?";
      return PRICE_SNAPSHOT_URL + separator + "v=" + encodeURIComponent(String(Date.now()));
    }

    function parsePriceSnapshotPayload(payload) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return { ok: false, status: "unavailable", generatedAt: 0, itemCount: 0, items: Object.create(null), error: "price.json 格式不是物件" };
      }
      var generatedAt = Date.parse(String(payload.generated_at || ""));
      if (!Number.isFinite(generatedAt)) {
        return { ok: false, status: "unavailable", generatedAt: 0, itemCount: 0, items: Object.create(null), error: "price.json 缺少有效更新時間" };
      }
      var age = Date.now() - generatedAt;
      if (age > PRICE_SNAPSHOT_MAX_AGE_MS) {
        return { ok: false, status: "stale", generatedAt: generatedAt, itemCount: 0, items: Object.create(null), error: "price.json 已超過 12 小時" };
      }
      if (age < -5 * 60 * 1000) {
        return { ok: false, status: "unavailable", generatedAt: generatedAt, itemCount: 0, items: Object.create(null), error: "price.json 更新時間在未來" };
      }
      var sourceItems = payload.items;
      if (!sourceItems || typeof sourceItems !== "object" || Array.isArray(sourceItems)) {
        return { ok: false, status: "unavailable", generatedAt: generatedAt, itemCount: 0, items: Object.create(null), error: "price.json 缺少 items" };
      }
      var items = Object.create(null);
      Object.keys(sourceItems).forEach(function (appid) {
        var normalized = normalizeSaleCheck(sourceItems[appid]);
        if (normalized) items[String(appid)] = normalized;
      });
      var itemCount = Object.keys(items).length;
      if (!itemCount) {
        return { ok: false, status: "unavailable", generatedAt: generatedAt, itemCount: 0, items: Object.create(null), error: "price.json 沒有有效價格資料" };
      }
      return { ok: true, status: "fresh", generatedAt: generatedAt, itemCount: itemCount, items: items, error: "" };
    }

    function fetchPriceSnapshotFromNetwork() {
      if (typeof fetch !== "function") return Promise.reject(new Error("瀏覽器不支援 fetch"));
      return fetch(priceSnapshotRequestUrl(), {
        cache: "no-store",
        headers: { Accept: "application/json" }
      }).then(function (response) {
        if (!response.ok) throw new Error("GitHub price.json HTTP " + response.status);
        return response.json();
      });
    }

    function fetchPriceSnapshotViaUserscript() {
      return new Promise(function (resolve, reject) {
        var requestId = "price-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        var settled = false;
        var timeoutId = window.setTimeout(function () {
          if (settled) return;
          settled = true;
          window.removeEventListener("message", receiveResponse);
          reject(new Error("油猴沒有回傳 price.json"));
        }, PRICE_SNAPSHOT_REQUEST_TIMEOUT_MS);
        function receiveResponse(event) {
          var message = event.data;
          if (!message || message.source !== SALE_USERSCRIPT_MESSAGE_SOURCE || message.type !== PRICE_SNAPSHOT_RESPONSE_TYPE || message.requestId !== requestId) return;
          window.clearTimeout(timeoutId);
          window.removeEventListener("message", receiveResponse);
          if (!message.ok) {
            settled = true;
            reject(new Error(String(message.error || "油猴無法下載 price.json")));
            return;
          }
          if (!message.payload || typeof message.payload !== "object") {
            settled = true;
            reject(new Error("油猴回傳的 price.json 格式錯誤"));
            return;
          }
          settled = true;
          resolve(message.payload);
        }
        window.addEventListener("message", receiveResponse);
        window.postMessage({
          source: SALE_PAGE_MESSAGE_SOURCE,
          type: PRICE_SNAPSHOT_REQUEST_TYPE,
          requestId: requestId
        }, "*");
      });
    }

    function loadPriceSnapshot() {
      return fetchPriceSnapshotFromNetwork().then(parsePriceSnapshotPayload).catch(function (networkError) {
        return fetchPriceSnapshotViaUserscript().then(parsePriceSnapshotPayload).catch(function (userscriptError) {
          var first = networkError && networkError.message ? String(networkError.message) : "網路請求失敗";
          var second = userscriptError && userscriptError.message ? String(userscriptError.message) : "油猴請求失敗";
          return {
            ok: false,
            status: "unavailable",
            generatedAt: 0,
            itemCount: 0,
            items: Object.create(null),
            error: first + "；" + second
          };
        });
      });
    }

    function applyPriceSnapshot(result) {
      if (!result || !result.ok) {
        priceSnapshot = {
          status: result && result.status ? result.status : "unavailable",
          generatedAt: result && Number(result.generatedAt) ? Number(result.generatedAt) : 0,
          itemCount: result && Number(result.itemCount) ? Number(result.itemCount) : 0,
          lastError: result && result.error ? String(result.error) : "無法讀取 price.json"
        };
        return;
      }
      var nextSaleChecks = Object.create(null);
      Object.keys(result.items || {}).forEach(function (appid) {
        var normalized = normalizeSaleCheck(result.items[appid]);
        if (normalized) nextSaleChecks[String(appid)] = normalized;
      });
      var itemCount = Object.keys(nextSaleChecks).length;
      if (!itemCount) {
        priceSnapshot = { status: "unavailable", generatedAt: 0, itemCount: 0, lastError: "price.json 沒有有效價格資料" };
        return;
      }
      saleChecks = nextSaleChecks;
      priceSnapshot = { status: "fresh", generatedAt: Number(result.generatedAt || 0), itemCount: itemCount, lastError: "" };
      saleSync.lastRunAt = priceSnapshot.generatedAt;
      saleSync.lastError = "";
      saleSync.lastResult = { source: "price.json", success: itemCount, failed: 0, total: itemCount };
      saleSyncInitialPass = false;
      saleSyncRetryBlockedUntil = 0;
      saveSaleChecks();
      saveSaleSyncState();
    }

    function loadSaleChecks() {
      return safeStorageGet(SALE_CHECKS_KEY).then(function (raw) {
        var result = Object.create(null);
        if (!raw) return result;
        try {
          var values = JSON.parse(raw);
          if (!values || typeof values !== "object" || Array.isArray(values)) return result;
          Object.keys(values).forEach(function (appid) {
            var normalized = normalizeSaleCheck(values[appid]);
            if (normalized) result[String(appid)] = normalized;
          });
        } catch (error) {}
        return result;
      });
    }

    function saveSaleChecks() {
      safeStorageSet(SALE_CHECKS_KEY, JSON.stringify(saleChecks));
      updateStorageNote();
    }

    function loadSaleSyncState() {
      return safeStorageGet(SALE_SYNC_STATE_KEY).then(function (raw) {
        if (!raw) return { lastRunAt: 0, lastResult: null, lastError: "", busy: false, progress: null };
        try {
          var value = JSON.parse(raw);
          return {
            lastRunAt: Number(value.lastRunAt || 0),
            lastResult: value.lastResult && typeof value.lastResult === "object" ? value.lastResult : null,
            lastError: String(value.lastError || ""),
            busy: false,
            progress: null
          };
        } catch (error) {
          return { lastRunAt: 0, lastResult: null, lastError: "", busy: false, progress: null };
        }
      });
    }

    function saveSaleSyncState() {
      safeStorageSet(SALE_SYNC_STATE_KEY, JSON.stringify({
        lastRunAt: saleSync.lastRunAt,
        lastResult: saleSync.lastResult,
        lastError: saleSync.lastError
      }));
      updateStorageNote();
    }

    function loadFavorites() {
      return safeStorageGet("steam_portal_favorites_v1").then(function (raw) {
        if (!raw) return new Set();
        try {
          var values = JSON.parse(raw);
          return new Set(Array.isArray(values) ? values.map(String) : []);
        } catch (error) { return new Set(); }
      });
    }

    function saveFavorites() {
      safeStorageSet("steam_portal_favorites_v1", JSON.stringify(Array.from(favorites)));
      updateStorageNote();
    }

    function loadReadGames() {
      return safeStorageGet(READ_GAMES_KEY).then(function (raw) {
        if (!raw) return new Set();
        try {
          var values = JSON.parse(raw);
          return new Set(Array.isArray(values) ? values.map(String) : []);
        } catch (error) { return new Set(); }
      });
    }

    function saveReadGames() {
      safeStorageSet(READ_GAMES_KEY, JSON.stringify(Array.from(readGames)));
      updateStorageNote();
    }

    function loadSpoilerReveals() {
      return safeStorageGet(SPOILER_REVEALS_KEY).then(function (raw) {
        if (!raw) return new Set();
        try {
          var values = JSON.parse(raw);
          return new Set(normalizeImportedIds(values).filter(function (id) { return !!gameMap[id]; }));
        } catch (error) { return new Set(); }
      });
    }

    function saveSpoilerReveals() {
      safeStorageSet(SPOILER_REVEALS_KEY, JSON.stringify(Array.from(spoilerReveals)));
      updateStorageNote();
    }

    function loadLastExportAt() {
      return safeStorageGet(EXPORT_LAST_AT_KEY).then(function (raw) {
        var value = Number(raw || 0);
        return Number.isFinite(value) && value > 0 ? value : 0;
      });
    }

    function saveLastExportAt() {
      safeStorageSet(EXPORT_LAST_AT_KEY, String(lastExportAt || 0));
      updateStorageNote();
    }

    function updateExportButton() {
      if (!el || !el.exportStateButton) return;
      var due = !lastExportAt || Date.now() - lastExportAt >= EXPORT_DUE_INTERVAL_MS;
      el.exportStateButton.classList.toggle("export-due", due);
      el.exportStateButton.title = due ? (lastExportAt ? "距上次匯出已超過 7 天" : "尚未匯出同步資料") : "下載收藏、河道與閱讀狀態";
    }

    function markGameRead(id) {
      var appid = String(id || "");
      if (!appid || readGames.has(appid)) return;
      readGames.add(appid);
      saveReadGames();
    }

    function normalizeRiverReadMode(value) {
      return value === "unread" || value === "read" ? value : "all";
    }

    function loadRiverReadMode() {
      return safeStorageGet(RIVER_READ_FILTER_KEY).then(normalizeRiverReadMode);
    }

    function saveRiverReadMode() {
      safeStorageSet(RIVER_READ_FILTER_KEY, riverReadMode);
      updateStorageNote();
    }

    function loadDisplayTraditionalNames() {
      return safeStorageGet("steam_portal_display_names_v1").then(function (value) {
        return value === "traditional";
      });
    }

    function saveDisplayTraditionalNames() {
      safeStorageSet("steam_portal_display_names_v1", displayTraditionalNames ? "traditional" : "original");
      updateStorageNote();
    }

    function setBackupStatus(message, isError) {
      if (!el || !el.backupStatus) return;
      el.backupStatus.textContent = String(message || "");
      el.backupStatus.style.color = isError ? "var(--danger)" : "";
    }

    function exportStatePayload() {
      return {
        format: STATE_EXPORT_FORMAT,
        version: STATE_EXPORT_VERSION,
        source: STATE_EXPORT_SOURCE,
        exportedAt: new Date().toISOString(),
        state: {
          favorites: Array.from(favorites).map(String).filter(function (id) { return /^\d+$/.test(id); }),
          readGames: Array.from(readGames).map(String).filter(function (id) { return /^\d+$/.test(id); }),
          rivers: rivers.map(function (river) { return normalizeRiver(river); }).filter(Boolean),
          riversCollapsed: !!riversCollapsed,
          riverReadMode: riverReadMode,
          displayTraditionalNames: !!displayTraditionalNames,
          spoilerReveals: Array.from(spoilerReveals).map(String).filter(function (id) { return !!gameMap[id]; })
        }
      };
    }

    function exportPortalState() {
      try {
        var payload = exportStatePayload();
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var link = document.createElement("a");
        link.href = url;
        var now = new Date();
        var stamp = [now.getDate(), now.getMonth() + 1].map(function (value) {
          return String(value).padStart(2, "0");
        }).join("") + "_" + [now.getHours(), now.getMinutes()].map(function (value) {
          return String(value).padStart(2, "0");
        }).join("");
        link.download = "steam_portal_" + stamp + ".json";
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 0);
        lastExportAt = Date.now();
        saveLastExportAt();
        updateExportButton();
        setBackupStatus("已匯出；匯入時會與本機資料合併");
      } catch (error) {
        setBackupStatus("匯出失敗，請確認瀏覽器允許下載檔案", true);
      }
    }

    function normalizeImportedIds(values) {
      var seen = new Set();
      return (Array.isArray(values) ? values : []).map(String).filter(function (id) {
        if (!/^\d+$/.test(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }

    function parseStateImport(rawText) {
      var payload;
      try { payload = JSON.parse(String(rawText || "")); }
      catch (error) { throw new Error("檔案不是有效的 JSON"); }
      if (!payload || payload.format !== STATE_EXPORT_FORMAT || Number(payload.version) !== STATE_EXPORT_VERSION || payload.source !== STATE_EXPORT_SOURCE || !payload.state || typeof payload.state !== "object") {
        throw new Error("不是本入口匯出的同步資料");
      }
      return {
        favorites: normalizeImportedIds(payload.state.favorites),
        readGames: normalizeImportedIds(payload.state.readGames),
        rivers: (Array.isArray(payload.state.rivers) ? payload.state.rivers : []).map(function (river) { return normalizeRiver(river); }).filter(Boolean),
        riversCollapsed: typeof payload.state.riversCollapsed === "boolean" ? payload.state.riversCollapsed : riversCollapsed,
        riverReadMode: normalizeRiverReadMode(payload.state.riverReadMode),
        displayTraditionalNames: typeof payload.state.displayTraditionalNames === "boolean" ? payload.state.displayTraditionalNames : displayTraditionalNames,
        spoilerReveals: normalizeImportedIds(payload.state.spoilerReveals).filter(function (id) { return !!gameMap[id]; })
      };
    }

    function mergeRiverState(localRiver, importedRiver) {
      var newer = Number(importedRiver.updatedAt || 0) >= Number(localRiver.updatedAt || 0) ? importedRiver : localRiver;
      var merged = Object.assign({}, newer);
      return normalizeRiver(merged);
    }

    function mergeImportedRivers(importedRivers) {
      var byId = new Map();
      rivers.forEach(function (river) { byId.set(river.id, river); });
      importedRivers.forEach(function (importedRiver) {
        var localRiver = byId.get(importedRiver.id);
        byId.set(importedRiver.id, localRiver ? mergeRiverState(localRiver, importedRiver) : importedRiver);
      });
      return Array.from(byId.values()).map(function (river) { return normalizeRiver(river); }).filter(Boolean).sort(riverOrder);
    }

    function importPortalState(rawText) {
      var imported = parseStateImport(rawText);
      var mergedFavorites = new Set(Array.from(favorites));
      imported.favorites.forEach(function (id) { mergedFavorites.add(id); });
      favorites = mergedFavorites;
      var mergedReadGames = new Set(Array.from(readGames));
      imported.readGames.forEach(function (id) { mergedReadGames.add(id); });
      readGames = mergedReadGames;
      var mergedSpoilerReveals = new Set(Array.from(spoilerReveals));
      imported.spoilerReveals.forEach(function (id) { mergedSpoilerReveals.add(id); });
      spoilerReveals = mergedSpoilerReveals;
      rivers = mergeImportedRivers(imported.rivers);
      invalidateFixedReadIds();
      pendingRiverSourceIds = null;
      riversCollapsed = imported.riversCollapsed;
      riverReadMode = imported.riverReadMode;
      displayTraditionalNames = imported.displayTraditionalNames;
      saveFavorites();
      saveReadGames();
      saveSpoilerReveals();
      saveRiversCollapsed();
      saveRiverReadMode();
      saveDisplayTraditionalNames();
      ensureDefaultRiver();
      reconcileDynamicRivers();
      saveRivers();
      state = readUrlState();
      render();
      setBackupStatus("已匯入並合併；收藏 " + formatNumber(imported.favorites.length) + " 款、河道 " + formatNumber(imported.rivers.length) + " 條");
    }

    function importStateFile(file) {
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (event) {
        try { importPortalState(event.target.result); }
        catch (error) { setBackupStatus(String(error.message || "匯入失敗"), true); }
        el.importStateFile.value = "";
      };
      reader.onerror = function () {
        setBackupStatus("匯入失敗；無法讀取檔案", true);
        el.importStateFile.value = "";
      };
      reader.readAsText(file);
    }

    function displayName(game) {
      if (displayTraditionalNames && game.translated_name && normalizeText(game.translated_name) !== normalizeText(game.name)) return game.translated_name;
      return game.name;
    }

    function liveSaleInfo(game) {
      var record = saleChecks[game.appid] || null;
      var now = Math.floor(Date.now() / 1000);
      var saleEnd = record ? toEpochSeconds(record.saleEnd) : null;
      var expired = !!(record && record.status === "sale" && saleEnd !== null && saleEnd <= now);
      return {
        record: record,
        saleEnd: saleEnd,
        status: record ? (expired ? "expired" : record.status) : "unseen",
        isSale: !!(record && record.status === "sale" && !expired),
        discountPercent: record && !expired ? Number(record.discountPercent || 0) : 0
      };
    }

    function basePrice(game) {
      return game.is_free ? "免費" : (game.price_original || game.price_label || "無報價");
    }

    function pacificTimeParts(timestamp) {
      var parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        hourCycle: "h23"
      }).formatToParts(new Date(timestamp));
      var values = {};
      parts.forEach(function (part) { if (part.type !== "literal") values[part.type] = part.value; });
      return {
        dayKey: values.year + "-" + values.month + "-" + values.day,
        hour: Number(values.hour),
        minute: Number(values.minute)
      };
    }

    function isPacificDailySyncDue(now) {
      var current = pacificTimeParts(now);
      if (current.hour < SALE_DAILY_SYNC_HOUR_PT) return false;
      if (!saleSync.lastRunAt) return true;
      var previous = pacificTimeParts(saleSync.lastRunAt);
      return previous.dayKey !== current.dayKey || previous.hour < SALE_DAILY_SYNC_HOUR_PT;
    }

    function automaticSyncDue(now) {
      return !saleSync.lastRunAt || now - saleSync.lastRunAt >= SALE_SYNC_INTERVAL_MS || isPacificDailySyncDue(now);
    }

    function getSyncTargets(force) {
      if (!force && priceSnapshot.status === "loading") return [];
      if (!force && priceSnapshot.status === "fresh") return [];
      if (!force && saleSyncRetryBlockedUntil && Date.now() < saleSyncRetryBlockedUntil) return [];
      var now = Date.now();
      var unseen = games.filter(function (game) { return !saleChecks[game.appid]; });
      if (!force && (priceSnapshot.status === "stale" || priceSnapshot.status === "unavailable")) return games.slice();
      if (force || automaticSyncDue(now)) return games.slice();
      if (saleSyncInitialPass || unseen.length) return unseen;
      return [];
    }

    function loadRivers() {
      return safeStorageGet("steam_portal_rivers_v1").then(function (raw) {
        if (!raw) return [];
        try {
          var values = JSON.parse(raw);
          if (!Array.isArray(values)) return [];
          return values.map(normalizeRiver).filter(function (river) {
            return river && (river.id === "favorites" || river.id === "wishlist" || river.id === "owned" || !river.filters.favoritesOnly);
          });
        } catch (error) { return []; }
      });
    }

    function loadRiversCollapsed() {
      return safeStorageGet(RIVERS_COLLAPSED_KEY).then(function (value) {
        return value !== "0";
      });
    }

    function saveRiversCollapsed() {
      safeStorageSet(RIVERS_COLLAPSED_KEY, riversCollapsed ? "1" : "0");
      updateStorageNote();
    }

    function normalizeRiver(river) {
      if (!river || !river.id) return null;
      var ids = [];
      var seenIds = new Set();
      (Array.isArray(river.ids) ? river.ids : []).forEach(function (value) {
        var id = String(value || "");
        if (!id || seenIds.has(id) || !gameMap[id]) return;
        seenIds.add(id);
        ids.push(id);
      });
      var position = Number.isInteger(river.position) && river.position >= 0 && river.position < ids.length ? river.position : null;
      var filters = normalizeRiverFilters(river.filters || {});
      var riverId = String(river.id);
      var defaultTitle = riverId === "default" ? "探索河道" : riverId === "favorites" ? "收藏河道" : riverId === "wishlist" ? "Steam 願望清單" : riverId === "owned" ? "Steam 已擁有遊戲" : "搜尋河道";
      return {
        id: riverId,
        title: String(riverId === "default" ? defaultTitle : river.title || defaultTitle),
        filters: filters,
        ids: ids,
        position: position,
        createdAt: Number(river.createdAt || 0),
        updatedAt: Number(river.updatedAt || river.createdAt || 0),
        isDefault: String(river.id) === "default"
      };
    }

    function normalizeRiverFilters(filters) {
      var topicValues = [];
      if (Array.isArray(filters.topics)) topicValues = topicValues.concat(filters.topics);
      if (Array.isArray(filters.genres)) topicValues = topicValues.concat(filters.genres);
      if (Array.isArray(filters.tags)) topicValues = topicValues.concat(filters.tags);
      var price = String(filters.price || "all");
      var saleOnly = !!filters.saleOnly || price === "sale";
      if (price === "sale") price = "all";
      return {
        q: String(filters.q || ""),
        topics: uniqueTopicValues(topicValues),
        authors: Array.isArray(filters.authors) ? filters.authors.map(String) : [],
        price: price,
        maxPrice: String(filters.maxPrice || ""),
        saleOnly: saleOnly,
        minDiscount: String(filters.minDiscount || ""),
        rating: normalizeRatingValue(filters.rating),
        minYear: String(filters.minYear || ""),
        maxYear: String(filters.maxYear || ""),
        language: String(filters.language || "all"),
        favoritesOnly: !!filters.favoritesOnly,
        demoOnly: !!filters.demoOnly,
        sort: String(filters.sort || "relevance")
      };
    }

    function saveRivers() {
      safeStorageSet("steam_portal_rivers_v1", JSON.stringify(rivers));
      updateStorageNote();
    }

    function invalidateFixedReadIds() {
      fixedReadIdsCache = null;
    }

    function fixedReadIds() {
      if (fixedReadIdsCache) return fixedReadIdsCache;
      fixedReadIdsCache = new Set();
      rivers.forEach(function (river) {
        if (["favorites", "wishlist", "owned"].indexOf(river.id) < 0) return;
        river.ids.forEach(function (id) { fixedReadIdsCache.add(String(id)); });
      });
      return fixedReadIdsCache;
    }

    function isGameRead(id) {
      var appid = String(id || "");
      return !!appid && (readGames.has(appid) || fixedReadIds().has(appid));
    }

    function syncFavoriteRiver() {
      var existing = rivers.find(function (river) { return river.id === "favorites"; });
      var favoriteIds = Array.from(favorites).map(String).filter(function (appid) { return !!gameMap[appid]; });
      if (!favoriteIds.length) {
        if (!existing) return false;
        rivers = rivers.filter(function (river) { return river.id !== "favorites"; });
        invalidateFixedReadIds();
        if (state && state.riverId === "favorites") {
          var defaultRiver = rivers.find(function (river) { return river.id === "default"; });
          state = restoreRiverFilters(defaultRiver ? defaultRiver.filters : { sort: "river" });
          state.riverId = "default";
        }
        return true;
      }

      var oldIds = existing ? existing.ids.slice() : [];
      var oldPosition = existing ? existing.position : null;
      var currentId = existing && oldPosition !== null ? (oldIds[oldPosition] || "") : "";
      var nextIds = favoriteIds.slice();
      var nextPosition = null;
      if (currentId && nextIds.indexOf(currentId) >= 0) nextPosition = nextIds.indexOf(currentId);
      else if (oldPosition !== null && nextIds.length) nextPosition = Math.min(oldPosition, nextIds.length - 1);
      var nextFilters = existing ? normalizeRiverFilters(existing.filters) : normalizeRiverFilters({ favoritesOnly: true, sort: "relevance" });
      var changed = !existing || existing.title !== "收藏河道" || oldIds.join("\u0000") !== nextIds.join("\u0000") || oldPosition !== nextPosition;
      if (!existing) {
        existing = {
          id: "favorites",
          title: "收藏河道",
          filters: nextFilters,
          ids: nextIds,
          position: nextPosition,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          isDefault: false
        };
        rivers.push(existing);
        invalidateFixedReadIds();
        return true;
      }
      existing.title = "收藏河道";
      existing.filters = nextFilters;
      existing.ids = nextIds;
      existing.position = nextPosition;
      if (changed) existing.updatedAt = Date.now();
      invalidateFixedReadIds();
      return changed;
    }

    function importedRiverDefinition(kind) {
      if (kind === "wishlist") return { id: "wishlist", title: "Steam 願望清單" };
      if (kind === "owned") return { id: "owned", title: "Steam 已擁有遊戲" };
      return null;
    }

    function syncImportedRiver(kind, appids) {
      var definition = importedRiverDefinition(kind);
      if (!definition) return { added: 0, removed: 0, total: 0, ignored: 0 };
      var incoming = [];
      var incomingSeen = new Set();
      var ignored = 0;
      (Array.isArray(appids) ? appids : []).forEach(function (value) {
        var appid = String(value || "").trim();
        if (!/^\d+$/.test(appid) || !gameMap[appid] || incomingSeen.has(appid)) {
          if (!incomingSeen.has(appid)) ignored++;
          return;
        }
        incomingSeen.add(appid);
        incoming.push(appid);
      });

      var existing = rivers.find(function (river) { return river.id === definition.id; });
      var oldIds = existing ? existing.ids.slice() : [];
      var incomingSet = new Set(incoming);
      var oldSet = new Set(oldIds);
      var added = incoming.filter(function (appid) { return !oldSet.has(appid); }).length;
      var removed = oldIds.filter(function (appid) { return !incomingSet.has(appid); }).length;
      var nextIds = incoming.slice();
      if (!existing && !nextIds.length) return { added: 0, removed: 0, total: 0, ignored: ignored };

      var oldPosition = existing ? existing.position : null;
      var currentId = existing && oldPosition !== null ? (oldIds[oldPosition] || "") : "";
      var nextPosition = currentId && nextIds.indexOf(currentId) >= 0 ? nextIds.indexOf(currentId) : (nextIds.length ? Math.min(oldPosition === null ? 0 : oldPosition, nextIds.length - 1) : null);
      var changed = !existing || added > 0 || removed > 0 || oldIds.join("\u0000") !== nextIds.join("\u0000") || oldPosition !== nextPosition;
      if (!existing) {
        existing = {
          id: definition.id,
          title: definition.title,
          filters: normalizeRiverFilters({ sort: "relevance" }),
          ids: nextIds,
          position: nextPosition,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          isDefault: false
        };
        rivers.push(existing);
      } else {
        existing.title = definition.title;
        existing.filters = normalizeRiverFilters(existing.filters);
        existing.ids = nextIds;
        existing.position = nextPosition;
        if (changed) existing.updatedAt = Date.now();
      }
      invalidateFixedReadIds();
      rivers.sort(riverOrder);
      if (changed) saveRivers();
      return { added: added, removed: removed, total: nextIds.length, ignored: ignored };
    }

    function resetFixedRiverPositions() {
      var changed = false;
      rivers.forEach(function (river) {
        if (["favorites", "wishlist", "owned"].indexOf(river.id) < 0 || !river.ids.length || river.position === 0) return;
        river.position = 0;
        river.updatedAt = Date.now();
        changed = true;
      });
      if (changed) saveRivers();
    }

    function ensureDefaultRiver() {
      var existing = rivers.find(function (river) { return river.id === "default"; });
      if (existing && existing.ids.length) {
        var known = new Set(existing.ids);
        var changed = false;
        games.forEach(function (game) { if (!known.has(game.appid)) { existing.ids.push(game.appid); changed = true; } });
        existing.title = "探索河道";
        if (changed) saveRivers();
      } else {
        var ids = games.map(function (game) { return game.appid; });
        for (var index = ids.length - 1; index > 0; index--) {
          var swap = Math.floor(Math.random() * (index + 1));
          var current = ids[index];
          ids[index] = ids[swap];
          ids[swap] = current;
        }
        var created = {
          id: "default",
          title: "探索河道",
          filters: normalizeRiverFilters({ sort: "river" }),
          ids: ids,
          position: null,
          createdAt: 0,
          updatedAt: 0,
          isDefault: true
        };
        rivers = [created].concat(rivers.filter(function (river) { return river.id !== "default"; }));
        saveRivers();
      }
      if (syncFavoriteRiver()) saveRivers();
      rivers.sort(riverOrder);
    }

    function shuffleIds(ids) {
      for (var index = ids.length - 1; index > 0; index--) {
        var swap = Math.floor(Math.random() * (index + 1));
        var current = ids[index];
        ids[index] = ids[swap];
        ids[swap] = current;
      }
      return ids;
    }

    function exploreReferenceIds() {
      var ids = new Set();
      favorites.forEach(function (id) {
        var appid = String(id || "");
        if (gameMap[appid]) ids.add(appid);
      });
      var wishlist = rivers.find(function (river) { return river.id === "wishlist"; });
      if (wishlist) wishlist.ids.forEach(function (id) { if (gameMap[id]) ids.add(String(id)); });
      return Array.from(ids);
    }

    function exploreTagHeat() {
      var referenceIds = exploreReferenceIds();
      if (!referenceIds.length) return null;
      var heat = Object.create(null);
      referenceIds.forEach(function (id) {
        var game = gameMap[id];
        var seenTags = new Set();
        (game && Array.isArray(game.tags) ? game.tags : []).forEach(function (value) {
          var key = normalizeText(value);
          if (!key || EXPLORE_COMMON_TAGS.has(key) || seenTags.has(key)) return;
          seenTags.add(key);
          heat[key] = (heat[key] || 0) + 1;
        });
      });
      return Object.keys(heat).length ? heat : null;
    }

    function exploreGameWeight(id, heat) {
      var game = gameMap[id];
      if (!game || !heat) return 0;
      var seenTags = new Set();
      return (Array.isArray(game.tags) ? game.tags : []).reduce(function (total, value) {
        var key = normalizeText(value);
        if (!key || EXPLORE_COMMON_TAGS.has(key) || seenTags.has(key)) return total;
        seenTags.add(key);
        return total + Number(heat[key] || 0);
      }, 0);
    }

    function buildExploreBucketOrder(ids, heat) {
      var source = shuffleIds(ids.slice());
      if (!heat || source.length < 2) return source;
      var target = Math.floor(source.length / 2);
      var weighted = source.map(function (id) {
        var weight = Math.max(0, exploreGameWeight(id, heat));
        var random = Math.random();
        return { id: id, weight: weight, key: weight > 0 && random > 0 ? -Math.log(random) / weight : Number.POSITIVE_INFINITY };
      }).filter(function (item) { return item.weight > 0; });
      weighted.sort(function (a, b) {
        if (a.key !== b.key) return a.key - b.key;
        return b.weight - a.weight || String(a.id).localeCompare(String(b.id));
      });
      var priority = weighted.slice(0, target).map(function (item) { return item.id; });
      var prioritySet = new Set(priority);
      var available = shuffleIds(source.filter(function (id) { return !prioritySet.has(id); }));
      var result = [];
      var priorityIndex = 0;
      var baseIndex = 0;
      while (priorityIndex < priority.length || baseIndex < available.length) {
        if (priorityIndex < priority.length) result.push(priority[priorityIndex++]);
        if (baseIndex < available.length) result.push(available[baseIndex++]);
      }
      return result;
    }

    function prepareExploreRiver() {
      var river = rivers.find(function (item) { return item.id === "default"; });
      if (!river) return;
      var previousIds = river.ids.slice();
      var sourceIds = games.map(function (game) { return game.appid; });
      var unread = [];
      var read = [];
      sourceIds.forEach(function (id) {
        (isGameRead(id) ? read : unread).push(id);
      });
      var heat = exploreTagHeat();
      var unreadOrder = buildExploreBucketOrder(unread, heat);
      var readOrder = buildExploreBucketOrder(read, heat);
      river.ids = unreadOrder.concat(readOrder);
      river.position = river.ids.length ? 0 : null;
      var changed = previousIds.join("\u0000") !== river.ids.join("\u0000");
      river.updatedAt = Date.now();
      if (changed || river.position !== null) saveRivers();
    }

    function riverOrder(a, b) {
      var specialOrder = { default: 0, favorites: 1, wishlist: 2, owned: 3 };
      var aSpecial = Object.prototype.hasOwnProperty.call(specialOrder, a.id);
      var bSpecial = Object.prototype.hasOwnProperty.call(specialOrder, b.id);
      if (aSpecial && bSpecial) return specialOrder[a.id] - specialOrder[b.id];
      if (aSpecial) return -1;
      if (bSpecial) return 1;
      return Number(b.createdAt || 0) - Number(a.createdAt || 0) || String(a.title).localeCompare(String(b.title), "zh-Hant");
    }

    function isProtectedRiver(id) {
      return ["default", "favorites", "wishlist", "owned"].indexOf(String(id)) >= 0;
    }

    function activeRiver() {
      return rivers.find(function (river) { return river.id === state.riverId; }) || null;
    }

    function riverItemMatchesReadFilter(id) {
      var isRead = isGameRead(id);
      return riverReadMode === "read" ? isRead : riverReadMode === "unread" ? !isRead : true;
    }

    function riverIdsForReadFilter(river, includeId) {
      if (!river) return [];
      var forcedId = includeId ? String(includeId) : "";
      return river.ids.filter(function (id) {
        var game = gameMap[id];
        if (!game || (river.filters && !gameMatchesFilters(game, river.filters))) return false;
        return id === forcedId || riverItemMatchesReadFilter(id);
      });
    }

    function riverIdsForCurrentView(river, includeId) {
      var ids = riverIdsForReadFilter(river, includeId);
      if (!river || activeRiver() !== river) return ids;
      return ids.filter(function (id) {
        var game = gameMap[id];
        return !!game && gameMatchesFilters(game, state);
      });
    }

    function riverProgress(river) {
      if (!river) return "0 / 0";
      if (river.id === "default") {
        var exploreIds = riverIdsForCurrentView(river);
        var explored = exploreIds.filter(function (id) { return isGameRead(id); }).length;
        return explored + " / " + exploreIds.length;
      }
      var ids = riverIdsForCurrentView(river);
      var currentId = river.position === null ? "" : (river.ids[river.position] || "");
      var currentIndex = ids.indexOf(currentId);
      return (currentIndex < 0 ? 0 : currentIndex + 1) + " / " + ids.length;
    }

    function riverProgressPercent(river) {
      if (!river) return 0;
      if (river.id === "default") {
        var exploreIds = riverIdsForCurrentView(river);
        var exploreTotal = exploreIds.length;
        if (!exploreTotal) return 0;
        var exploreRead = exploreIds.filter(function (id) { return isGameRead(id); }).length;
        return Math.min(100, exploreRead / exploreTotal * 100);
      }
      var ids = riverIdsForCurrentView(river);
      if (!ids.length || river.position === null) return 0;
      var currentId = river.ids[river.position] || "";
      var currentIndex = ids.indexOf(currentId);
      if (currentIndex < 0) return 0;
      return Math.min(100, (currentIndex + 1) / ids.length * 100);
    }

    function riverPosition(river, id) {
      return river ? river.ids.indexOf(String(id)) : -1;
    }

    function snapshotFilters() {
      return normalizeRiverFilters({
        q: state.q,
        topics: Array.from(state.topics),
        authors: Array.from(state.authors),
        price: state.price,
        maxPrice: state.maxPrice,
        saleOnly: state.saleOnly,
        minDiscount: state.minDiscount,
        rating: state.rating,
        minYear: state.minYear,
        maxYear: state.maxYear,
        language: state.language,
        demoOnly: state.demoOnly,
        sort: state.sort
      });
    }

    function restoreRiverFilters(filters) {
      var normalized = normalizeRiverFilters(filters);
      return {
        q: normalized.q,
        topics: new Set(normalized.topics),
        authors: new Set(normalized.authors),
        price: normalized.price,
        maxPrice: normalized.maxPrice,
        saleOnly: normalized.saleOnly,
        minDiscount: normalized.minDiscount,
        rating: normalized.rating,
        minYear: normalized.minYear,
        maxYear: normalized.maxYear,
        language: normalized.language,
        demoOnly: normalized.demoOnly,
        sort: normalized.sort || "relevance",
        page: 1,
        riverId: "",
        detailId: ""
      };
    }

    function riverTitle(filters) {
      var normalized = normalizeRiverFilters(filters);
      var parts = normalized.topics.slice();
      parts = parts.concat(normalized.authors);
      if (normalized.q) parts.push(normalized.q);
      if (!parts.length) return "搜尋河道";
      return parts.join(" ");
    }

    function hasSearchRiverCondition() {
      return !!(state.q || state.topics.size || state.authors.size);
    }

    function searchScopeFilters(filters) {
      var normalized = normalizeRiverFilters(filters);
      return normalizeRiverFilters({
        q: normalized.q,
        topics: normalized.topics,
        authors: normalized.authors,
        sort: "river"
      });
    }

    function pendingSearchRiver() {
      if (activeRiver() || !hasSearchRiverCondition()) return null;
      var filters = snapshotFilters();
      var scopeFilters = searchScopeFilters(filters);
      var defaultRiver = rivers.find(function (river) { return river.id === "default"; });
      var sourceIds = Array.isArray(pendingRiverSourceIds) ? pendingRiverSourceIds : (defaultRiver ? defaultRiver.ids : []);
      var ids = sourceIds.filter(function (id) {
        return !!gameMap[id] && gameMatchesFilters(gameMap[id], scopeFilters);
      });
      return {
        id: "pending-search",
        title: riverTitle(filters),
        filters: filters,
        ids: ids,
        position: null,
        createdAt: 0,
        updatedAt: 0,
        isDefault: false,
        pending: true
      };
    }

    function ensureRiverForState(results, id) {
      var current = activeRiver();
      var currentIndex = riverPosition(current, id);
      if (current && currentIndex >= 0) {
        current.position = currentIndex;
        current.updatedAt = Date.now();
        saveRivers();
        return current;
      }
      var filters = snapshotFilters();
      var scopeFilters = searchScopeFilters(filters);
      var ids = [];
      var seenIds = new Set();
      var defaultRiver = rivers.find(function (river) { return river.id === "default"; });
      var sourceIds = Array.isArray(pendingRiverSourceIds) ? pendingRiverSourceIds : (defaultRiver ? defaultRiver.ids : results.map(function (game) { return game && game.appid; }));
      sourceIds.forEach(function (value) {
        var appid = String(value || "");
        if (!appid || seenIds.has(appid) || !gameMap[appid]) return;
        if (!gameMatchesFilters(gameMap[appid], scopeFilters)) return;
        seenIds.add(appid);
        ids.push(appid);
      });
      var requestedId = String(id);
      if (!seenIds.has(requestedId) && gameMap[requestedId]) ids.push(requestedId);
      if (ids.length <= 1) return null;
      var now = Date.now();
      var river = {
        id: "river-" + now + "-" + Math.floor(Math.random() * 1000000),
        title: riverTitle(filters),
        filters: filters,
        ids: ids,
        position: Math.max(0, ids.indexOf(String(id))),
        createdAt: now,
        updatedAt: now,
        isDefault: false
      };
      rivers = rivers.filter(function (item) { return item.id !== river.id; });
      rivers.push(river);
      rivers.sort(riverOrder);
      state.riverId = river.id;
      pendingRiverSourceIds = null;
      saveRivers();
      showPortalToast("你建立了新搜尋河道「" + displayRiverTitle(river) + "」");
      return river;
    }

    function jumpToTop() {
      var root = document.documentElement;
      var body = document.body;
      var previousRootBehavior = root.style.scrollBehavior;
      var previousBodyBehavior = body.style.scrollBehavior;
      root.style.scrollBehavior = "auto";
      body.style.scrollBehavior = "auto";
      window.scrollTo(0, 0);
      root.scrollTop = 0;
      body.scrollTop = 0;
      root.style.scrollBehavior = previousRootBehavior;
      body.style.scrollBehavior = previousBodyBehavior;
    }

    function centerRiverGame(id) {
      var target = el.gameList.querySelector('[data-open-game="' + String(id) + '"]');
      if (!target) return;
      var root = document.documentElement;
      var body = document.body;
      var previousRootBehavior = root.style.scrollBehavior;
      var previousBodyBehavior = body.style.scrollBehavior;
      root.style.scrollBehavior = "auto";
      body.style.scrollBehavior = "auto";
      target.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
      root.style.scrollBehavior = previousRootBehavior;
      body.style.scrollBehavior = previousBodyBehavior;
    }

    function openRiver(id, stayInRiver) {
      var river = rivers.find(function (item) { return item.id === String(id); });
      if (!river) return;
      pendingRiverSourceIds = null;
      var restored = restoreRiverFilters(river.filters);
      var savedId = river.position === null ? "" : (river.ids[river.position] || "");
      restored.riverId = river.id;
      restored.detailId = "";
      state = restored;
      var visibleIds = riverIdsForCurrentView(river);
      var focusId = visibleIds.indexOf(savedId) >= 0 ? savedId : (visibleIds[0] || "");
      restored.detailId = stayInRiver ? "" : focusId;
      state = restored;
      if (stayInRiver && focusId) {
        var focusIndex = visibleIds.indexOf(focusId);
        riverVisibleCount = Math.max(pageSize, Math.min(visibleIds.length, Math.ceil((focusIndex + 1) / pageSize) * pageSize));
      } else {
        riverVisibleCount = pageSize;
      }
      syncUrl(false);
      closeFilters();
      render();
      if (stayInRiver && focusId) centerRiverGame(focusId); else jumpToTop();
    }

    function deleteRiver(id) {
      id = String(id);
      if (isProtectedRiver(id)) return;
      rivers = rivers.filter(function (river) { return river.id !== id; });
      if (state.riverId === id) {
        var defaultRiver = rivers.find(function (river) { return river.id === "default"; });
        state = restoreRiverFilters(defaultRiver ? defaultRiver.filters : { sort: "river" });
        state.riverId = "default";
        riverVisibleCount = pageSize;
      }
      saveRivers();
      syncUrl(true);
      render();
    }

    function updateRiverPosition(id) {
      var river = activeRiver();
      var index = riverPosition(river, id);
      if (!river || index < 0) return;
      river.position = index;
      river.updatedAt = Date.now();
      saveRivers();
    }

    function riverHasDynamicFilter(river) {
      return !!(river && river.id !== "default" && (river.id === "favorites" || river.filters.price === "sale" || river.filters.saleOnly || river.filters.minDiscount || river.filters.favoritesOnly));
    }

    function riverGameMatches(game, filters, keepUnresolvedSale) {
      var saleFilter = filters.price === "sale" || filters.saleOnly || Number(filters.minDiscount || 0) > 0;
      if (saleFilter && keepUnresolvedSale) {
        var saleInfo = liveSaleInfo(game);
        var unresolved = !saleInfo.record || saleInfo.status === "unseen" || saleInfo.record.status === "error";
        if (unresolved) return gameMatchesFilters(game, Object.assign({}, filters, { price: "all", saleOnly: false, minDiscount: "" }));
      }
      return gameMatchesFilters(game, filters);
    }

    function reconcileDynamicRivers() {
      var changed = syncFavoriteRiver();
      rivers.forEach(function (river) {
        if (!riverHasDynamicFilter(river)) return;
        var oldIds = river.ids.slice();
        var oldPosition = river.position;
        var currentId = oldPosition === null ? "" : (oldIds[oldPosition] || "");
        var knownIds = new Set(oldIds);
        var nextIds = oldIds.filter(function (id) {
          var game = gameMap[id];
          return !!game && riverGameMatches(game, river.filters, true);
        });
        games.forEach(function (game) {
          if (knownIds.has(game.appid)) return;
          if (riverGameMatches(game, river.filters, false)) nextIds.push(game.appid);
        });
        var nextPosition = null;
        if (currentId && nextIds.indexOf(currentId) >= 0) nextPosition = nextIds.indexOf(currentId);
        else if (oldPosition !== null && nextIds.length) nextPosition = Math.min(oldPosition, nextIds.length - 1);
        if (nextIds.join("\u0000") !== oldIds.join("\u0000") || nextPosition !== oldPosition) {
          river.ids = nextIds;
          river.position = nextPosition;
          river.updatedAt = Date.now();
          changed = true;
        }
      });
      if (changed) {
        rivers.sort(riverOrder);
        saveRivers();
      }
      var current = activeRiver();
      if (state.detailId && current && current.id !== "default" && riverPosition(current, state.detailId) < 0) {
        state.detailId = "";
        syncUrl(true);
      }
    }

    function updateStorageNote() {
      if (!el || !el.storageNote) return;
      if (!storageWorks) {
        el.storageNote.hidden = false;
        el.storageNote.textContent = "目前瀏覽器不允許使用 IndexedDB 保存收藏、河道、閱讀狀態與名稱顯示偏好；本次工作階段仍可正常瀏覽。";
      } else {
        el.storageNote.hidden = true;
      }
    }

    function countTopicValues() {
      var counts = Object.create(null);
      games.forEach(function (game) {
        game.topics.forEach(function (value) {
          counts[value] = (counts[value] || 0) + 1;
        });
      });
      return counts;
    }

    function sortedOptions(counts) {
      return Object.keys(counts).sort(function (a, b) {
        return counts[b] - counts[a] || a.localeCompare(b, "zh-Hant");
      });
    }

    function readUrlState() {
      var params = new URLSearchParams(window.location.search);
      var topicValues = params.getAll("topic").concat(params.getAll("genre"), params.getAll("tag"));
      var hasSearchConditions = ["q", "price", "max_price", "sale", "discount", "rating", "year_from", "year_to", "language", "demo", "sort"].some(function (key) { return params.has(key); }) || topicValues.length > 0 || params.has("author");
      var riverId = params.get("river") || (!hasSearchConditions ? "default" : "");
      var price = params.get("price") || "all";
      return {
        q: params.get("q") || "",
        topics: new Set(uniqueTopicValues(topicValues)),
        authors: new Set(params.getAll("author")),
        price: price === "sale" ? "all" : price,
        maxPrice: params.get("max_price") || "",
        saleOnly: params.get("sale") === "1" || price === "sale",
        minDiscount: params.get("discount") || "",
        rating: normalizeRatingValue(params.get("rating") || "0"),
        minYear: params.get("year_from") || "",
        maxYear: params.get("year_to") || "",
        language: params.get("language") || "all",
        demoOnly: params.get("demo") === "1",
        sort: params.get("sort") || (riverId === "default" ? "river" : "relevance"),
        page: Math.max(1, Number(params.get("page") || 1) || 1),
        riverId: riverId,
        detailId: params.get("game") || ""
      };
    }

    function syncUrl(replace) {
      try {
        var url = new URL(window.location.href);
        var params = url.searchParams;
        ["q", "price", "max_price", "sale", "discount", "rating", "year_from", "year_to", "language", "favorites", "demo", "sort", "page", "game", "river", "topic", "tag", "genre", "author"].forEach(function (key) { params.delete(key); });
        if (state.q) params.set("q", state.q);
        state.topics.forEach(function (topic) { params.append("topic", topic); });
        state.authors.forEach(function (author) { params.append("author", author); });
        if (state.price !== "all") params.set("price", state.price);
        if (state.maxPrice) params.set("max_price", state.maxPrice);
        if (state.saleOnly) params.set("sale", "1");
        if (state.minDiscount) params.set("discount", state.minDiscount);
        if (state.rating !== "0") params.set("rating", state.rating);
        if (state.minYear) params.set("year_from", state.minYear);
        if (state.maxYear) params.set("year_to", state.maxYear);
        if (state.language !== "all") params.set("language", state.language);
        if (state.demoOnly) params.set("demo", "1");
        if (state.sort !== "relevance") params.set("sort", state.sort);
        if (state.page > 1) params.set("page", String(state.page));
        if (state.riverId) params.set("river", state.riverId);
        if (state.detailId) params.set("game", state.detailId);
        var query = params.toString();
        var target = url.pathname + (query ? "?" + query : "") + url.hash;
        if (replace) window.history.replaceState({}, "", target);
        else window.history.pushState({}, "", target);
      } catch (error) {}
    }

    function gameMatches(game) {
      return gameMatchesFilters(game, state);
    }

    function gameMatchesFilters(game, filters) {
      var query = normalizeText(filters.q);
      var topics = Array.isArray(filters.topics) ? filters.topics : Array.from(filters.topics || []);
      var authors = Array.isArray(filters.authors) ? filters.authors : Array.from(filters.authors || []);
      if (query && game.searchText.indexOf(query) === -1) return false;
      if (topics.length && !topics.some(function (topic) { return game.topicSet.has(normalizeText(topic)); })) return false;
      if (authors.length && !authors.every(function (author) { return game.authorSet.has(author); })) return false;
      if (filters.price === "free" && !game.is_free) return false;
      if (filters.price === "paid" && game.is_free) return false;
      var saleInfo = liveSaleInfo(game);
      if ((filters.price === "sale" || filters.saleOnly) && !saleInfo.isSale) return false;
      if (Number(filters.minDiscount || 0) > 0 && (!saleInfo.isSale || saleInfo.discountPercent < Number(filters.minDiscount))) return false;
      if (filters.maxPrice && (priceValueFor(game) === null || priceValueFor(game) > Number(filters.maxPrice))) return false;
      if (Number(filters.rating) > 0 && game.reviewPercent < Number(filters.rating)) return false;
      if (filters.minYear && (game.releaseYear === null || game.releaseYear < Number(filters.minYear))) return false;
      if (filters.maxYear && (game.releaseYear === null || game.releaseYear > Number(filters.maxYear))) return false;
      if (filters.language !== "all" && !hasLanguage(game, filters.language)) return false;
      if (filters.favoritesOnly && !favorites.has(game.appid)) return false;
      if (filters.demoOnly && !game.hasDemo) return false;
      return true;
    }

    function languageTier(game) {
      var hasTraditional = game.languages.some(function (row) { return row.name === "繁體中文" && hasLanguageFeature(row); });
      if (hasTraditional) return "traditional";
      if (game.languages.some(function (row) { return (row.name === "繁體中文" || row.name === "簡體中文") && hasLanguageFeature(row); })) return "chinese";
      return "none";
    }

    function hasLanguage(game, requirement) {
      var hasTraditional = game.languages.some(function (row) { return row.name === "繁體中文" && hasLanguageFeature(row); });
      var hasChinese = game.languages.some(function (row) { return (row.name === "繁體中文" || row.name === "簡體中文") && hasLanguageFeature(row); });
      if (requirement === "traditional") return hasTraditional;
      if (requirement === "chinese") return hasChinese;
      if (requirement === "none") return !hasChinese;
      return false;
    }

    function relevanceScore(game, query) {
      if (!query) return 0;
      var original = normalizeText(game.name);
      var translated = normalizeText(game.translated_name);
      var subtitle = normalizeText(game.subtitle);
      if (original === query || translated === query) return 1000;
      if (original.indexOf(query) === 0 || translated.indexOf(query) === 0) return 850;
      if (original.indexOf(query) >= 0 || translated.indexOf(query) >= 0) return 700;
      if (subtitle.indexOf(query) >= 0) return 600;
      if (game.topics.some(function (topic) { return normalizeText(topic).indexOf(query) >= 0; })) return 450;
      return 100;
    }

    function getResults() {
      var query = normalizeText(state.q);
      var river = activeRiver();
      if (river) {
        return riverIdsForCurrentView(river).map(function (id) { return gameMap[id]; }).filter(Boolean);
      }
      if (Array.isArray(pendingRiverSourceIds)) {
        var snapshot = snapshotFilters();
        return pendingRiverSourceIds.map(function (id) { return gameMap[id]; }).filter(function (game) {
          return !!game && gameMatchesFilters(game, snapshot);
        });
      }
      var result = games.filter(gameMatches);
      result.sort(function (a, b) {
        var diff = 0;
        if (state.sort === "relevance") diff = relevanceScore(b, query) - relevanceScore(a, query) || b.updatedNs - a.updatedNs;
        else if (state.sort === "updated") diff = b.updatedNs - a.updatedNs;
        else if (state.sort === "release") diff = (b.releaseYear || 0) - (a.releaseYear || 0);
        else if (state.sort === "name") diff = a.name.localeCompare(b.name, "zh-Hant");
        else if (state.sort === "price_asc") diff = compareNullable(priceValueFor(a), priceValueFor(b), false);
        else if (state.sort === "price_desc") diff = compareNullable(priceValueFor(a), priceValueFor(b), true);
        else if (state.sort === "review") diff = b.reviewPercent - a.reviewPercent || b.reviewCount - a.reviewCount;
        else if (state.sort === "review_count") diff = b.reviewCount - a.reviewCount || b.reviewPercent - a.reviewPercent;
        return diff || a.name.localeCompare(b.name, "zh-Hant") || a.appid.localeCompare(b.appid);
      });
      return result;
    }

    function compareNullable(a, b, descending) {
      var aNull = a === null || a === undefined || Number.isNaN(a);
      var bNull = b === null || b === undefined || Number.isNaN(b);
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      return descending ? b - a : a - b;
    }

    function livePriceInfo(game) {
      var saleInfo = liveSaleInfo(game);
      var record = saleInfo.record;
      if (!record || record.status === "error") {
        return { current: basePrice(game), original: game.price_original || basePrice(game), value: game.is_free ? 0 : parsePriceText(basePrice(game)), isSale: false, saleEnd: null, discountPercent: 0, syncedAt: 0 };
      }
      var current = record.priceCurrent || basePrice(game);
      var original = record.priceOriginal || game.price_original || current;
      var value = record.priceValue;
      if (saleInfo.status === "expired") {
        current = original;
        value = record.originalValue;
      }
      return {
        current: current,
        original: original,
        value: Number.isFinite(value) ? value : parsePriceText(current),
        isSale: saleInfo.isSale,
        saleEnd: saleInfo.saleEnd,
        discountPercent: saleInfo.isSale ? saleInfo.discountPercent : 0,
        syncedAt: record.syncedAt
      };
    }

    function displayPrice(game) { return livePriceInfo(game).current; }

    function displayOriginalPrice(game) { return livePriceInfo(game).original; }

    function priceValueFor(game) {
      var value = livePriceInfo(game).value;
      return value === null || value === undefined || Number.isNaN(value) ? null : value;
    }

    function salePriceHtml(game) {
      var info = livePriceInfo(game);
      var historical = historicalLowBadgeHtml(game);
      if (info.isSale) {
        var original = info.original && info.original !== info.current ? '<span class="price-original">' + escapeHtml(info.original) + '</span>' : "";
        var discount = info.discountPercent > 0 ? '<span class="sale-discount">-' + escapeHtml(info.discountPercent) + '% OFF</span>' : "";
        return '<div class="price"><span class="sale-price">' + escapeHtml(info.current) + '</span>' + original + discount + historical + '</div>';
      }
      return '<div class="price">' + escapeHtml(info.current) + historical + '</div>';
    }

    function historicalLowInfo(game) {
      var low = game && game.historicalLow;
      if (!low || !Number.isFinite(Number(low.priceValue))) return null;
      return {
        label: String(low.priceLabel || ("NT$ " + formatNumber(low.priceValue))),
        value: Number(low.priceValue)
      };
    }

    function isHistoricalLow(game) {
      var low = historicalLowInfo(game);
      var current = priceValueFor(game);
      return !!(low && current !== null && Number.isFinite(current) && Math.abs(current - low.value) < 0.01);
    }

    function historicalLowBadgeHtml(game) {
      return isHistoricalLow(game) ? '<span class="historical-low-badge">史低</span>' : "";
    }

    function historicalLowNoteHtml(game) {
      var low = historicalLowInfo(game);
      return low && !isHistoricalLow(game) ? '<span class="historical-low-note">（史低 ' + escapeHtml(low.label) + '）</span>' : "";
    }

    function scoreHtml(game) {
      if (!game.reviewCount) return '<div class="score no-score">尚無評價</div>';
      return '<div class="score">' + escapeHtml(game.reviewPercent) + '% 好評<small>' + escapeHtml(formatNumber(game.reviewCount)) + ' 則評論</small></div>';
    }

    function formatNumber(value) {
      return Number(value || 0).toLocaleString("zh-TW");
    }

    function imageHtml(url, className, alt, loading) {
      var safe = safeUrl(url);
      if (!safe) return '<div class="game-cover missing">暫無圖片</div>';
      return '<img class="' + className + '" src="' + escapeHtml(safe) + '" alt="' + escapeHtml(alt) + '" loading="' + (loading || "lazy") + '" referrerpolicy="no-referrer">';
    }

    function renderOptionLists() {
      var topicQuery = normalizeText(el.topicSearch.value);
      var allTopics = sortedOptions(topicCounts);
      var visibleTopics = allTopics.filter(function (topic) {
        return !topicQuery || normalizeText(topic).indexOf(topicQuery) >= 0 || state.topics.has(topic);
      });
      Array.from(state.topics).forEach(function (topic) {
        if (allTopics.indexOf(topic) >= 0 && visibleTopics.indexOf(topic) < 0) visibleTopics.push(topic);
      });
      el.topicOptions.innerHTML = visibleTopics.length ? visibleTopics.map(function (topic) {
        return checkboxHtml("topic", topic, topicCounts[topic] || 0, state.topics.has(topic));
      }).join("") : '<span class="meta-line">找不到類型、標籤或目錄</span>';
    }

    function checkboxHtml(type, value, count, checked) {
      return '<label class="checkbox-row"><input type="checkbox" data-filter-type="' + type + '" data-filter-value="' + escapeHtml(value) + '"' + (checked ? ' checked' : '') + '><span>' + escapeHtml(value) + '</span><em>' + escapeHtml(count) + '</em></label>';
    }

    function renderActiveFilters() {
      var chips = [];
      if (state.q) chips.push(chipHtml("搜尋：「" + state.q + "」", "query", "0"));
      state.topics.forEach(function (topic) { chips.push(chipHtml("標籤：" + topic, "topic", topic)); });
      state.authors.forEach(function (author) { chips.push(chipHtml("作者：" + author, "author", author)); });
      if (state.price !== "all") chips.push(chipHtml(state.price === "free" ? "免費" : "付費", "price", "all"));
      if (state.saleOnly || state.minDiscount) chips.push(chipHtml(state.minDiscount ? "特價至少 -" + state.minDiscount + "% OFF" : "特價中", "sale", "0"));
      if (state.rating !== "0") chips.push(chipHtml("好評 ≥ " + state.rating + "%", "rating", "0"));
      if (state.language !== "all") chips.push(chipHtml(languageLabel(state.language), "language", "all"));
      if (state.demoOnly) chips.push(chipHtml("有試玩版", "demo", "0"));
      if (state.maxPrice) chips.push(chipHtml("最高價格 ≤ NT$ " + formatNumber(state.maxPrice), "priceRange", "0"));
      if (state.minYear || state.maxYear) chips.push(chipHtml("年份範圍", "yearRange", "0"));
      el.activeFilters.innerHTML = chips.join("");
    }

    function chipHtml(label, type, value) {
      return '<span class="active-chip">' + escapeHtml(label) + '<button type="button" data-remove-type="' + type + '" data-remove-value="' + escapeHtml(value) + '" aria-label="移除' + escapeHtml(label) + '">×</button></span>';
    }

    function languageLabel(value) {
      var labels = { traditional: "繁體中文", chinese: "中文", none: "無中文" };
      return labels[value] || value;
    }

    function displayRiverTitle(river) {
      if (river && river.title) return river.title;
      if (!river) return "";
      if (river.id === "default") return "探索河道";
      if (river.id === "favorites") return "收藏河道";
      if (river.id === "wishlist") return "Steam 願望清單";
      if (river.id === "owned") return "Steam 已擁有遊戲";
      return "搜尋河道";
    }

    function renderRivers() {
      var current = activeRiver() || pendingSearchRiver();
      el.riverReadFilter.value = riverReadMode;
      el.riverCount.textContent = current ? riverProgress(current) : "";
      el.riverToggle.setAttribute("aria-expanded", String(!riversCollapsed));
      el.riverToggle.textContent = riversCollapsed ? "展開" : "收起";
      var fixedRivers = rivers.filter(function (river) { return ["favorites", "wishlist", "owned"].indexOf(river.id) >= 0 && river.ids.length > 0; });
      var shortcutHtml = fixedRivers.map(function (river) {
        var title = displayRiverTitle(river);
        var active = current && current.id === river.id;
        return '<button type="button" class="river-shortcut ' + escapeHtml(river.id) + (active ? ' active' : '') + '" data-open-river="' + escapeHtml(river.id) + '" title="' + escapeHtml(title + "　" + riverProgress(river)) + '" aria-label="開啟' + escapeHtml(title) + '">' + escapeHtml(title) + '</button>';
      }).join("");
      if (!current || current.id !== "default") {
        shortcutHtml += '<button type="button" class="river-shortcut explore" data-open-river="default" title="回到探索河道" aria-label="回到探索河道">回到探索河道</button>';
      }
      el.riverShortcuts.innerHTML = shortcutHtml;
      var defaultRiver = rivers.find(function (river) { return river.id === "default"; });
      var customRivers = rivers.filter(function (river) { return !isProtectedRiver(river.id); });
      var visibleRivers;
      if (riversCollapsed) {
        visibleRivers = current ? [current] : [];
      } else if (current && current.pending) {
        visibleRivers = [current].concat(customRivers);
      } else {
        visibleRivers = current && current.id === "default" && defaultRiver ? [defaultRiver].concat(customRivers) : customRivers;
      }
      el.riverList.innerHTML = visibleRivers.map(function (river) {
        var active = current && current.id === river.id;
        var title = displayRiverTitle(river);
        var deleteButton = isProtectedRiver(river.id) || river.pending ? "" : '<button type="button" class="river-delete" data-delete-river="' + escapeHtml(river.id) + '" aria-label="刪除' + escapeHtml(title) + '">×</button>';
        var openAttribute = river.pending ? ' aria-label="尚未保存的搜尋河道"' : ' data-open-river="' + escapeHtml(river.id) + '" aria-label="開啟' + escapeHtml(title) + '"';
        return '<div class="river-item"><button type="button" class="river-main' + (active ? ' active' : '') + '"' + openAttribute + (river.pending ? ' disabled' : '') + '><span class="river-copy"><span class="river-title">' + escapeHtml(title) + '</span><span class="river-progress" aria-hidden="true"><i style="width:' + riverProgressPercent(river) + '%"></i></span></span><span class="river-meta">' + escapeHtml(riverProgress(river)) + '</span></button>' + deleteButton + '</div>';
      }).join("");
    }

    function renderResults() {
      lastResults = getResults();
      var current = activeRiver();
      var totalPages = Math.max(1, Math.ceil(lastResults.length / pageSize));
      var start = 0;
      var visible;
      if (current) {
        state.page = 1;
        riverVisibleCount = Math.max(pageSize, Math.min(riverVisibleCount, lastResults.length || pageSize));
        visible = lastResults.slice(0, riverVisibleCount);
      } else {
        state.page = Math.min(state.page, totalPages);
        start = (state.page - 1) * pageSize;
        visible = lastResults.slice(start, start + pageSize);
      }
      var shownStart = visible.length ? start + 1 : 0;
      var shownEnd = visible.length ? Math.min(start + visible.length, lastResults.length) : 0;
      var riverText = current ? ' <span>／河道進度 ' + escapeHtml(riverProgress(current)) + '</span>' : '';
      el.resultCount.innerHTML = '找到 ' + escapeHtml(formatNumber(lastResults.length)) + ' 款 <span>／目前顯示第 ' + escapeHtml(shownStart) + '–' + escapeHtml(shownEnd) + ' 款</span>' + riverText;
      if (!visible.length) {
        el.gameList.innerHTML = '<div class="empty-state"><strong>沒有符合條件的遊戲</strong>請清除部分標籤或放寬價格、年份與評價篩選。</div>';
      } else {
        el.gameList.innerHTML = visible.map(gameRowHtml).join("");
      }
      renderPagination(totalPages, !!current);
      renderActiveFilters();
      renderRivers();
    }

    function gameRowHtml(game) {
      var topicEntries = game.topicGroups.reduce(function (all, group) {
        return all.concat(group.values.map(function (value) { return { value: value, kind: group.kind }; }));
      }, []);
      var topics = topicEntries.slice(0, 7).map(function (entry) { return topicPillHtml(entry.value, entry.kind); }).join("");
      var title = displayName(game);
      var favorite = favorites.has(game.appid);
      return '<a class="game-row" href="?game=' + encodeURIComponent(game.appid) + '" data-open-game="' + escapeHtml(game.appid) + '">' +
        imageHtml(game.header_image, "game-cover", title, "lazy") +
        '<div class="game-main"><h3>' + escapeHtml(title) + '</h3>' +
        '<div class="game-summary">' + escapeHtml(game.summary || "暫無摘要。") + '</div><div class="tag-line">' + topics + '</div><div class="language-line">' + languageHtml(game.languages) + '</div></div>' +
        '<div class="game-side"><button type="button" class="favorite-button' + (favorite ? ' active' : '') + '" data-favorite-id="' + escapeHtml(game.appid) + '" aria-label="' + (favorite ? '取消收藏' : '加入收藏') + '" aria-pressed="' + String(favorite) + '">' + (favorite ? '★' : '☆') + '</button>' + scoreHtml(game) + salePriceHtml(game) + '<div class="meta-line">' + escapeHtml(game.release_year || "年份未知") + '</div></div></a>';
    }

    function topicPillHtml(value, kind) {
      var source = kind === "genre" || kind === "category" ? kind : "tag";
      return '<button type="button" class="tag link topic-pill ' + source + '" data-topic-source="' + source + '" data-quick-filter-type="topic" data-quick-filter-value="' + escapeHtml(value) + '">' + escapeHtml(value) + '</button>';
    }

    function companyLinks(values) {
      if (!values.length) return '<span>未知</span>';
      return values.map(function (value) {
        return '<button type="button" class="company-link" data-quick-filter-type="author" data-quick-filter-value="' + escapeHtml(value) + '">' + escapeHtml(value) + '</button>';
      }).join("、");
    }

    function loadMoreRiverResults() {
      if (!activeRiver() || riverVisibleCount >= lastResults.length) return;
      riverVisibleCount = Math.min(lastResults.length, riverVisibleCount + pageSize);
      renderResults();
    }

    function observeRiverLoadMore() {
      if (riverLoadObserver) riverLoadObserver.disconnect();
      if (!activeRiver() || riverVisibleCount >= lastResults.length || typeof window.IntersectionObserver !== "function") return;
      var sentinel = document.getElementById("riverLoadSentinel");
      if (!sentinel) return;
      riverLoadObserver = riverLoadObserver || new IntersectionObserver(function (entries) {
        if (entries.some(function (entry) { return entry.isIntersecting; })) loadMoreRiverResults();
      }, { rootMargin: "0px 0px 600px 0px" });
      riverLoadObserver.observe(sentinel);
    }

    function renderPagination(totalPages, isRiverView) {
      if (isRiverView) {
        if (riverVisibleCount < lastResults.length) {
          el.pagination.innerHTML = '<button type="button" class="button river-load-more" id="riverLoadSentinel" data-river-load-more>繼續載入</button>';
          observeRiverLoadMore();
        } else {
          el.pagination.innerHTML = "";
          if (riverLoadObserver) riverLoadObserver.disconnect();
        }
        return;
      }
      if (riverLoadObserver) riverLoadObserver.disconnect();
      if (totalPages <= 1) { el.pagination.innerHTML = ""; return; }
      var parts = [];
      parts.push('<button type="button" class="button" data-page="' + Math.max(1, state.page - 1) + '"' + (state.page === 1 ? ' disabled' : '') + '>上一頁</button>');
      var first = Math.max(1, state.page - 2);
      var last = Math.min(totalPages, first + 4);
      for (var index = first; index <= last; index++) {
        parts.push('<button type="button" class="button' + (index === state.page ? ' current' : '') + '" data-page="' + index + '">' + index + '</button>');
      }
      parts.push('<span class="page-status">共 ' + totalPages + ' 頁</span>');
      parts.push('<button type="button" class="button" data-page="' + Math.min(totalPages, state.page + 1) + '"' + (state.page === totalPages ? ' disabled' : '') + '>下一頁</button>');
      el.pagination.innerHTML = parts.join("");
    }

    function renderDetail(game) {
      if (!game) {
        state.detailId = "";
        syncUrl(true);
        render();
        return;
      }
      var sourceResults = lastResults.length ? lastResults : getResults();
      var river = activeRiver();
      if (river && riverPosition(river, game.appid) >= 0) updateRiverPosition(game.appid);
      var navigationIds = river ? riverIdsForCurrentView(river, game.appid) : sourceResults.map(function (item) { return item.appid; });
      if (navigationIds.indexOf(game.appid) < 0) navigationIds = [game.appid];
      markGameRead(game.appid);
      var currentPosition = navigationIds.indexOf(game.appid);
      var previous = currentPosition > 0 ? gameMap[navigationIds[currentPosition - 1]] : null;
      var next = currentPosition >= 0 && currentPosition < navigationIds.length - 1 ? gameMap[navigationIds[currentPosition + 1]] : null;
      var title = displayName(game);
      var subtitleParts = [];
      var alternateTitle = displayTraditionalNames ? game.name : game.translated_name;
      [alternateTitle, game.subtitle].forEach(function (value) {
        var text = String(value || "").trim();
        if (!text || normalizeText(text) === normalizeText(title) || subtitleParts.some(function (part) { return normalizeText(part) === normalizeText(text); })) return;
        subtitleParts.push(text);
      });
      var subtitle = subtitleParts.length ? '<div class="detail-subtitle">' + escapeHtml(subtitleParts.join("｜")) + '</div>' : '';
      var classification = game.topicGroups.reduce(function (all, group) {
        return all.concat(group.values.map(function (value) { return topicPillHtml(value, group.kind); }));
      }, []).join("");
      var developers = companyLinks(game.developers);
      var publishers = companyLinks(game.publishers);
      var review = game.reviewCount ? escapeHtml(game.review.description || "社群評價") + "　" + escapeHtml(game.reviewPercent) + "% 好評（" + escapeHtml(formatNumber(game.reviewCount)) + " 則）" : "尚無評價";
      var language = languageHtml(game.languages);
      var favorite = favorites.has(game.appid);
      var steamAction = '<span class="steam-action">' + (game.hasDemo ? '<small class="demo-note">有試玩版</small>' : '') + '<a class="button steam-link" href="https://store.steampowered.com/app/' + encodeURIComponent(game.appid) + '/" target="_blank" rel="noopener">前往 Steam</a></span>';
      var screenshotUrls = game.screenshots.slice(0, 12).map(safeUrl).filter(Boolean);
      var screenshotFigures = screenshotUrls.map(function (safe, index) {
        return '<figure class="shot"><a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener"><img class="thumb" src="' + escapeHtml(safe) + '" alt="' + escapeHtml(game.name + " 截圖 " + (index + 1)) + '" loading="eager" decoding="async" referrerpolicy="no-referrer"></a><img class="big" src="' + escapeHtml(safe) + '" alt="" loading="eager" decoding="async" referrerpolicy="no-referrer"></figure>';
      });
      var screenshotSlides = [];
      for (var screenshotStart = 0; screenshotStart < screenshotFigures.length; screenshotStart += 3) {
        screenshotSlides.push('<div class="screenshot-slide">' + screenshotFigures.slice(screenshotStart, screenshotStart + 3).join("") + '</div>');
      }
      var screenshots = screenshotSlides.join("");
      var screenshotPager = screenshotUrls.length > 3 ? '<div class="shot-nav-compact"><button type="button" class="shot-btn-sm" id="shotPrev">◀ 上一組</button><span class="shot-page-status" id="shotPageStatus"></span><button type="button" class="shot-btn-sm" id="shotNext">下一組 ▶</button></div>' : '';
      var points = game.core_points.map(function (point) { return pointHtml(point, game.appid); }).join("");
      var hasSpoilerContent = game.core_points.some(function (point) { return String(point || "").includes("||"); }) || String(game.player_essay || "").includes("||");
      var spoilerResetButton = hasSpoilerContent && spoilerReveals.has(String(game.appid)) ? '<button type="button" class="spoiler-reset-button" data-reset-spoilers="' + escapeHtml(game.appid) + '">重新遮住劇透</button>' : '';
      var progressParts = (currentPosition + 1) + " / " + navigationIds.length;
      var homeLabel = river ? "回到河道" : "回到搜尋";
      var sideHome = '<button type="button" class="detail-side-home" id="detailHome" title="' + homeLabel + '（Esc）" aria-label="' + homeLabel + '，快捷鍵 Esc">' + homeLabel + '</button>';
      var sidePrevious = '<button type="button" class="detail-side-nav side-prev"' + (previous ? ' data-open-game="' + escapeHtml(previous.appid) + '"' : ' disabled') + ' aria-label="上一款遊戲">上一頁</button>';
      var sideProgress = river ? '<div class="detail-side-progress" aria-label="閱讀進度 ' + escapeHtml(progressParts) + '"><span class="progress-number">' + escapeHtml(String(currentPosition + 1)) + '</span><i class="progress-slash">/</i><span class="progress-number">' + escapeHtml(String(navigationIds.length)) + '</span></div>' : '';
      var sideNext = '<button type="button" class="detail-side-nav side-next"' + (next ? ' data-open-game="' + escapeHtml(next.appid) + '"' : ' disabled') + ' aria-label="下一款遊戲">下一頁</button>';
      var sideFavoriteNext = '<button type="button" class="detail-side-favorite-next" data-favorite-next="' + escapeHtml(game.appid) + '"' + (next ? '' : ' disabled') + ' aria-label="收藏並下一頁">收藏並下一頁</button>';
      el.detail.innerHTML = '<div class="detail-side-stack detail-side-left">' + sideHome + sidePrevious + '</div><div class="detail-side-stack detail-side-right">' + sideProgress + sideNext + sideFavoriteNext + '</div>' +
        '<article class="detail-card">' + imageHtml(game.header_image, "detail-banner", title + " 封面", "eager") + '<div class="detail-content"><div class="detail-title-row"><div><h1>《' + escapeHtml(title) + '》</h1>' + subtitle + '</div><div class="detail-actions">' + steamAction + '<a class="button db-link" href="https://steamdb.info/app/' + encodeURIComponent(game.appid) + '/" target="_blank" rel="noopener">前往 SteamDB</a><button type="button" class="button star' + (favorite ? ' active' : '') + '" id="detailFavorite" aria-label="' + (favorite ? '取消收藏' : '加入收藏') + '" aria-pressed="' + String(favorite) + '" title="' + (favorite ? '取消收藏' : '加入收藏') + '">' + (favorite ? '★' : '☆') + '</button></div></div>' +
        '<div class="about-box"><p>' + escapeHtml(game.summary || "暫無摘要。") + '</p></div>' +
        (classification ? '<div class="classification" aria-label="標籤">' + classification + '</div>' : '') +
        '<div class="meta-grid"><div class="meta-item"><span class="meta-label">開發商</span><div class="company-links">' + developers + '</div></div><div class="meta-item"><span class="meta-label">發行商</span><div class="company-links">' + publishers + '</div></div><div class="meta-item"><span class="meta-label">發行日期</span><span class="meta-value">' + escapeHtml(game.release_date || "未知") + '</span></div><div class="meta-item"><span class="meta-label">目前價格／原價</span><div class="meta-value price-detail">' + salePriceHtml(game) + historicalLowNoteHtml(game) + '</div></div><div class="meta-item"><span class="meta-label">Steam 評價</span><span class="meta-value">' + review + '</span></div><div class="meta-item"><span class="meta-label">語言支援</span><span class="meta-value">' + language + '</span></div></div>' +
        (screenshots ? '<section class="detail-section"><div class="detail-section-head"><h2>遊戲截圖</h2>' + screenshotPager + '</div><div class="screenshots-gallery-wrap"><div class="screenshots-gallery" id="shotGallery"><div class="screenshots-track" id="shotTrack">' + screenshots + '</div></div>' + (screenshotUrls.length > 3 ? '<button type="button" class="gallery-hover-next" id="galleryHoverNext" aria-label="滑鼠停留自動翻到下一組"><span class="gallery-hover-icon" aria-hidden="true">›</span><span class="gallery-hover-label">下一組</span></button>' : '') + '</div></section>' : '') +
        (points ? '<section class="detail-section"><h2>三大核心要點</h2><div class="selling-box"><ul>' + points + '</ul></div></section>' : '') +
        '<section class="detail-section"><div class="detail-section-head"><h2>✍ 玩家心得</h2>' + spoilerResetButton + '</div><div class="player-essay">' + essayHtml(game.player_essay, game.appid) + '</div></section></div></article>';
      var home = document.getElementById("detailHome");
      if (home) home.addEventListener("click", closeDetail);
      var detailFavorite = document.getElementById("detailFavorite");
      if (detailFavorite) detailFavorite.addEventListener("click", function () { toggleFavorite(game.appid); });
      setupScreenshotPager();
    }

    function setupScreenshotPager() {
      var gallery = document.getElementById("shotGallery");
      var track = document.getElementById("shotTrack");
      if (!gallery || !track) return;
      var slides = Array.prototype.slice.call(track.children);
      var maxPage = Math.max(0, slides.length - 1);
      var page = 0;
      var position = 0;
      var frameId = null;
      var hovering = false;
      var lastFrame = 0;
      var status = document.getElementById("shotPageStatus");
      var previous = document.getElementById("shotPrev");
      var next = document.getElementById("shotNext");
      var hoverZone = document.getElementById("galleryHoverNext");
      if (maxPage > 0) {
        var loopSlide = slides[0].cloneNode(true);
        loopSlide.setAttribute("aria-hidden", "true");
        track.appendChild(loopSlide);
      }
      function slideGap() {
        var value = parseFloat(window.getComputedStyle(track).columnGap || window.getComputedStyle(track).gap);
        return Number.isFinite(value) ? value : 10;
      }
      function stepSize() {
        return gallery.clientWidth + slideGap();
      }
      function updateStatus() {
        if (status) status.textContent = "第 " + (page + 1) + " / " + (maxPage + 1) + " 組";
      }
      function applyPosition() {
        track.style.transform = "translate3d(" + (-position) + "px, 0, 0)";
      }
      function stopHover() {
        hovering = false;
        if (frameId !== null) window.cancelAnimationFrame(frameId);
        frameId = null;
        lastFrame = 0;
        if (maxPage > 0 && position >= (maxPage + 1) * stepSize() - 1) {
          page = 0;
          position = 0;
          applyPosition();
        } else if (maxPage > 0) {
          page = Math.min(maxPage, Math.floor(position / stepSize()));
          updateStatus();
        }
        if (hoverZone) hoverZone.classList.remove("is-running");
      }
      function goToPage(target) {
        stopHover();
        page = Math.max(0, Math.min(maxPage, target));
        position = page * stepSize();
        track.style.transition = "transform .36s ease";
        applyPosition();
        updateStatus();
        window.setTimeout(function () { track.style.transition = "none"; }, 380);
      }
      function animateHover(now) {
        if (!hovering) return;
        var elapsed = Math.min(64, Math.max(0, now - lastFrame));
        lastFrame = now;
        var step = stepSize();
        var end = (maxPage + 1) * step;
        position += elapsed * step / 3000;
        if (position >= end) {
          position = end;
          page = maxPage;
          applyPosition();
          updateStatus();
          position = 0;
          page = 0;
        } else {
          page = Math.min(maxPage, Math.floor(position / step));
        }
        track.style.transition = "none";
        applyPosition();
        updateStatus();
        frameId = window.requestAnimationFrame(animateHover);
      }
      function startHover() {
        if (maxPage <= 0 || hovering) return;
        hovering = true;
        if (hoverZone) hoverZone.classList.add("is-running");
        track.style.transition = "none";
        lastFrame = window.performance.now();
        frameId = window.requestAnimationFrame(animateHover);
      }
      page = 0;
      position = 0;
      track.style.transition = "none";
      applyPosition();
      updateStatus();
      if (previous) previous.addEventListener("click", function () { goToPage(page <= 0 ? maxPage : page - 1); });
      if (next) next.addEventListener("click", function () { goToPage(page >= maxPage ? 0 : page + 1); });
      if (hoverZone) {
        hoverZone.addEventListener("mouseenter", startHover);
        hoverZone.addEventListener("mouseleave", stopHover);
        hoverZone.addEventListener("focus", startHover);
        hoverZone.addEventListener("blur", stopHover);
        hoverZone.addEventListener("click", function () { goToPage(page >= maxPage ? 0 : page + 1); });
      }
    }

    function revealSpoilers(appid) {
      var id = String(appid || "");
      if (!id || !gameMap[id] || spoilerReveals.has(id)) return;
      spoilerReveals.add(id);
      saveSpoilerReveals();
      if (state.detailId !== id) return;
      document.querySelectorAll('[data-reveal-spoiler="' + id + '"]').forEach(function (mask) {
        mask.classList.remove("spoiler-mask");
        mask.classList.add("spoiler-revealed");
        mask.removeAttribute("data-reveal-spoiler");
        mask.removeAttribute("role");
        mask.removeAttribute("tabindex");
        mask.removeAttribute("aria-label");
      });
      if (!document.querySelector('[data-reset-spoilers="' + id + '"]')) {
        var essay = document.querySelector(".player-essay");
        var sectionHead = essay && essay.closest(".detail-section") ? essay.closest(".detail-section").querySelector(".detail-section-head") : null;
        if (sectionHead) {
          var resetButton = document.createElement("button");
          resetButton.type = "button";
          resetButton.className = "spoiler-reset-button";
          resetButton.setAttribute("data-reset-spoilers", id);
          resetButton.textContent = "重新遮住劇透";
          sectionHead.appendChild(resetButton);
        }
      }
    }

    function concealSpoilers(appid) {
      var id = String(appid || "");
      if (!id || !gameMap[id] || !spoilerReveals.has(id)) return;
      spoilerReveals.delete(id);
      saveSpoilerReveals();
      if (state.detailId !== id) return;
      document.querySelectorAll(".spoiler-revealed").forEach(function (revealed) {
        revealed.classList.remove("spoiler-revealed");
        revealed.classList.add("spoiler-mask");
        revealed.setAttribute("role", "button");
        revealed.setAttribute("tabindex", "0");
        revealed.setAttribute("data-reveal-spoiler", id);
        revealed.setAttribute("aria-label", "點擊顯示劇透");
      });
      var resetButton = document.querySelector('[data-reset-spoilers="' + id + '"]');
      if (resetButton) resetButton.remove();
    }

    function spoilerTextHtml(text, appid) {
      var value = String(text || "");
      if (!value.includes("||")) return escapeHtml(value);
      var output = "";
      var lastIndex = 0;
      var pattern = /\|\|([\s\S]*?)\|\|/g;
      var revealed = spoilerReveals.has(String(appid));
      var match;
      while ((match = pattern.exec(value))) {
        output += escapeHtml(value.slice(lastIndex, match.index));
        if (revealed) {
          output += '<span class="spoiler-revealed">' + escapeHtml(match[1]) + '</span>';
        } else {
          output += '<span class="spoiler-mask" role="button" tabindex="0" data-reveal-spoiler="' + escapeHtml(String(appid)) + '" aria-label="點擊顯示劇透">' + escapeHtml(match[1]) + '</span>';
        }
        lastIndex = pattern.lastIndex;
      }
      return output + escapeHtml(value.slice(lastIndex));
    }

    function pointHtml(point, appid) {
      var text = String(point || "");
      var split = text.indexOf("：");
      if (split < 0) split = text.indexOf(":");
      if (split < 0) return '<li>' + spoilerTextHtml(text, appid) + '</li>';
      var label = text.slice(0, split + 1);
      var body = text.slice(split + 1);
      if (label.includes("||")) return '<li>' + spoilerTextHtml(text, appid) + '</li>';
      return '<li><strong>' + escapeHtml(label) + '</strong>' + spoilerTextHtml(body, appid) + '</li>';
    }

    function essayHtml(text, appid) {
      var lines = String(text || "").split(/\r?\n/);
      var output = [];
      var paragraph = [];
      function flush() { if (paragraph.length) { output.push('<p>' + spoilerTextHtml(paragraph.join(" "), appid) + '</p>'); paragraph = []; } }
      lines.forEach(function (line) {
        var trimmed = line.trim();
        if (!trimmed) { flush(); return; }
        if (trimmed.indexOf("## ") === 0) { flush(); output.push('<h3>' + spoilerTextHtml(trimmed.slice(3), appid) + '</h3>'); return; }
        paragraph.push(trimmed);
      });
      flush();
      return output.join("") || '<p>暫無玩家心得。</p>';
    }

    function languageFeatureNames(row) {
      var features = [];
      if (row.interface) features.push("介面");
      if (row.subtitles) features.push("字幕");
      if (row.full_audio) features.push("語音");
      return features;
    }

    function hasLanguageFeature(row) {
      return languageFeatureNames(row).length > 0;
    }

    function languageText(languages) {
      var supported = (Array.isArray(languages) ? languages : []).filter(function (row) {
        return (row.name === "繁體中文" || row.name === "簡體中文") && hasLanguageFeature(row);
      });
      if (!supported.length) return "無中文";
      var preferred = supported.find(function (row) { return row.name === "繁體中文"; }) || supported[0];
      return [preferred.name].concat(languageFeatureNames(preferred)).join(" ");
    }

    function languageHtml(languages) {
      var text = languageText(languages);
      return '<span class="' + (text === "無中文" ? "language-none" : "") + '">' + escapeHtml(text) + '</span>';
    }

    function saleCheckFromAppDetails(game, entry) {
      var data = entry && entry.data && typeof entry.data === "object" ? entry.data : {};
      var price = data.price_overview && typeof data.price_overview === "object" ? data.price_overview : {};
      var isFree = !!game.is_free || !!data.is_free;
      var discountPercent = Number(price.discount_percent || 0);
      var saleEnd = discountPercent > 0 ? toEpochSeconds(price.discount_expiration) : null;
      var isSale = !isFree && discountPercent > 0;
      var current = isFree ? "免費" : String(price.final_formatted || basePrice(game));
      var original = isFree ? "免費" : String(price.initial_formatted || price.final_formatted || game.price_original || current);
      var currentValue = isFree ? 0 : parsePriceText(current);
      var originalValue = isFree ? 0 : parsePriceText(original);
      return {
        status: isSale ? "sale" : "not_sale",
        saleEnd: saleEnd,
        priceCurrent: current,
        priceOriginal: original,
        priceValue: currentValue,
        originalValue: originalValue,
        discountPercent: discountPercent,
        syncedAt: Date.now()
      };
    }

    function saleCheckForError(game) {
      var original = basePrice(game);
      var value = game.is_free ? 0 : parsePriceText(original);
      return {
        status: "error",
        saleEnd: null,
        priceCurrent: original,
        priceOriginal: original,
        priceValue: value,
        originalValue: value,
        discountPercent: 0,
        syncedAt: Date.now()
      };
    }

    async function fetchSaleBatch(batch) {
      return new Promise(function (resolve, reject) {
        var requestId = "sale-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        var timeoutId = window.setTimeout(function () {
          window.removeEventListener("message", receiveResponse);
          reject(new Error("油猴腳本沒有回應；請確認腳本已安裝並允許存取檔案網址。"));
        }, SALE_REQUEST_TIMEOUT_MS);
        function receiveResponse(event) {
          var message = event.data;
          if (!message || message.source !== SALE_USERSCRIPT_MESSAGE_SOURCE || message.type !== SALE_BATCH_RESPONSE_TYPE || message.requestId !== requestId) return;
          window.clearTimeout(timeoutId);
          window.removeEventListener("message", receiveResponse);
          if (!message.ok) { reject(new Error(String(message.error || "油猴腳本無法取得 Steam 資料。"))); return; }
          if (!Array.isArray(message.items)) { reject(new Error("油猴腳本回傳的批次資料格式錯誤。")); return; }
          resolve(message.items);
        }
        window.addEventListener("message", receiveResponse);
        window.postMessage({
          source: SALE_PAGE_MESSAGE_SOURCE,
          type: SALE_BATCH_REQUEST_TYPE,
          requestId: requestId,
          appids: batch.map(function (game) { return Number(game.appid); })
        }, "*");
      });
    }

    function setImportButtonsBusy(busy) {
      [el.importWishlistButton, el.importOwnedButton].forEach(function (button) {
        if (button) button.disabled = !!busy;
      });
    }

    function setImportStatus(message) {
      if (el.importStatus) el.importStatus.textContent = String(message || "");
    }

    function steamImportUrl(kind) {
      return kind === "wishlist" ? "https://store.steampowered.com/wishlist/" : "https://steamcommunity.com/my/games/?tab=all";
    }

    function requestSteamImport(kind) {
      if (kind !== "wishlist" && kind !== "owned") return;
      if (importPending) return;
      var requestId = "import-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      importPending = { requestId: requestId, kind: kind };
      setImportButtonsBusy(true);
      window.postMessage({
        source: SALE_PAGE_MESSAGE_SOURCE,
        type: IMPORT_REQUEST_TYPE,
        requestId: requestId,
        kind: kind,
        silent: false
      }, "*");
      var opened = false;
      try { opened = !!window.open(steamImportUrl(kind), "_blank"); } catch (error) {}
      setImportStatus(opened ? "已開啟 Steam，正在讀取完整清單…" : "瀏覽器阻擋新分頁；請手動開啟 Steam 清單頁…");
      window.clearTimeout(importTimeoutId);
      importTimeoutId = window.setTimeout(function () {
        if (!importPending || importPending.requestId !== requestId) return;
        importPending = null;
        setImportButtonsBusy(false);
        setImportStatus(kind === "wishlist" ? "沒有回應；請開啟已登入的 Steam 願望清單頁" : "沒有回應；請開啟已登入的 Steam 遊戲清單頁");
      }, IMPORT_REQUEST_TIMEOUT_MS);
    }

    function requestSilentSteamImport(kind) {
      if (kind !== "wishlist" && kind !== "owned") return;
      window.postMessage({
        source: SALE_PAGE_MESSAGE_SOURCE,
        type: IMPORT_REQUEST_TYPE,
        requestId: "sync-import-" + kind + "-" + Date.now() + "-" + Math.random().toString(36).slice(2),
        kind: kind,
        silent: true
      }, "*");
    }

    function receiveImportResult(event) {
      var message = event.data;
      if (!message || message.source !== IMPORT_USERSCRIPT_MESSAGE_SOURCE || message.type !== IMPORT_RESULT_TYPE) return;
      var kind = message.kind === "wishlist" || message.kind === "owned" ? message.kind : "";
      if (!kind) return;
      if (importPending && importPending.kind !== kind) return;
      if (importPending) {
        window.clearTimeout(importTimeoutId);
        importTimeoutId = 0;
        importPending = null;
        setImportButtonsBusy(false);
      }
      if (!message.ok || message.complete === false) {
        var incompleteMessage = message.complete === false && message.ok ? "匯入資料不完整，已保留上次成功清單" : String(message.error || "Steam 清單沒有回傳資料");
        setImportStatus(incompleteMessage);
        return;
      }
      var result = syncImportedRiver(kind, message.appids);
      var label = kind === "wishlist" ? "願望清單" : "已擁有遊戲";
      setImportStatus(label + "同步完成：新增 " + formatNumber(result.added) + " 款、移除 " + formatNumber(result.removed) + " 款，目前 " + formatNumber(result.total) + " 款" + (result.ignored ? "；略過 " + formatNumber(result.ignored) + " 款" : ""));
      render();
      maybeRunSaleSync();
    }

    function delay(milliseconds) {
      return new Promise(function (resolve) { window.setTimeout(resolve, milliseconds); });
    }

    function updateSaleSyncOverlay(label, done, total, visible) {
      if (!el || !el.saleSyncOverlay) return;
      el.saleSyncOverlay.hidden = !visible;
      if (!visible) return;
      el.saleSyncLabel.textContent = label;
      el.saleSyncProgressText.textContent = formatNumber(done) + " / " + formatNumber(total);
      el.saleSyncProgressFill.style.width = (total ? done / total * 100 : 0) + "%";
    }

    async function fetchSaleBatchWithRetry(batch, done, total, batchNumber, totalBatches) {
      var lastError = null;
      for (var attempt = 0; attempt <= SALE_RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) {
          var waitMilliseconds = SALE_RETRY_DELAYS_MS[attempt - 1];
          updateSaleSyncOverlay("第 " + batchNumber + " / " + totalBatches + " 批失敗，" + (waitMilliseconds / 1000) + " 秒後重試", done, total, true);
          await delay(waitMilliseconds);
          updateSaleSyncOverlay("重新讀取第 " + batchNumber + " / " + totalBatches + " 批", done, total, true);
        }
        try {
          return await fetchSaleBatch(batch);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error || "批次回傳失敗"));
        }
      }
      throw lastError || new Error("批次回傳失敗");
    }

    function updateManualSaleSyncButton() {
      if (!el || !el.manualSaleSyncButton) return;
      el.manualSaleSyncButton.disabled = !!saleSync.busy;
      el.manualSaleSyncButton.textContent = saleSync.busy ? "同步中…" : "手動同步";
    }

    function updateSaleSyncAge() {
      if (!el || !el.saleSyncAge) return;
      if (priceSnapshot.status === "loading") {
        el.saleSyncAge.textContent = "正在讀取中央價格";
        return;
      }
      if (priceSnapshot.status === "stale") {
        el.saleSyncAge.textContent = "price.json 已超過 12 小時，將直接同步 Steam";
        return;
      }
      if (priceSnapshot.status === "unavailable") {
        el.saleSyncAge.textContent = "price.json 無法使用，將直接同步 Steam";
        return;
      }
      if (priceSnapshot.status === "fresh" && priceSnapshot.generatedAt) {
        var snapshotSeconds = Math.max(0, Math.floor((Date.now() - priceSnapshot.generatedAt) / 1000));
        var snapshotHours = Math.floor(snapshotSeconds / 3600);
        var snapshotMinutes = Math.floor(snapshotSeconds % 3600 / 60);
        var snapshotRemainder = snapshotSeconds % 60;
        el.saleSyncAge.textContent = "中央價格 " + snapshotHours + "小時 " + snapshotMinutes + "分 " + snapshotRemainder + "秒前";
        return;
      }
      if (priceSnapshot.status === "local_fallback" && saleSync.lastRunAt) {
        var localSeconds = Math.max(0, Math.floor((Date.now() - saleSync.lastRunAt) / 1000));
        var localHours = Math.floor(localSeconds / 3600);
        var localMinutes = Math.floor(localSeconds % 3600 / 60);
        var localRemainder = localSeconds % 60;
        el.saleSyncAge.textContent = "本機 Steam 同步 " + localHours + "小時 " + localMinutes + "分 " + localRemainder + "秒前";
        return;
      }
      if (!saleSync.lastRunAt) {
        el.saleSyncAge.textContent = "尚未同步";
        return;
      }
      var seconds = Math.max(0, Math.floor((Date.now() - saleSync.lastRunAt) / 1000));
      var hours = Math.floor(seconds / 3600);
      var minutes = Math.floor(seconds % 3600 / 60);
      var remainder = seconds % 60;
      el.saleSyncAge.textContent = "上次同步 " + hours + "小時 " + minutes + "分 " + remainder + "秒前";
    }

    async function runSaleSync(force) {
      if (saleSync.busy) return;
      var targets = getSyncTargets(!!force);
      saleSyncInitialPass = false;
      if (!targets.length) return;
      saleSync.busy = true;
      updateManualSaleSyncButton();
      saleSync.progress = { done: 0, total: targets.length };
      saleSync.lastError = "";
      saleSync.lastResult = null;
      requestSilentSteamImport("wishlist");
      requestSilentSteamImport("owned");
      updateSaleSyncOverlay("正在讀取特價資訊中", 0, targets.length, true);
      var success = 0;
      var failed = 0;
      var interrupted = false;
      var totalBatches = Math.ceil(targets.length / SALE_BATCH_SIZE);
      for (var start = 0; start < targets.length; start += SALE_BATCH_SIZE) {
        var batch = targets.slice(start, start + SALE_BATCH_SIZE);
        var batchNumber = Math.floor(start / SALE_BATCH_SIZE) + 1;
        try {
          var items = await fetchSaleBatchWithRetry(batch, start, targets.length, batchNumber, totalBatches);
          var itemMap = Object.create(null);
          items.forEach(function (item) {
            if (item && item.appid !== undefined) itemMap[String(item.appid)] = item;
          });
          batch.forEach(function (game) {
            var entry = itemMap[game.appid];
            if (entry && entry.success) {
              saleChecks[game.appid] = saleCheckFromAppDetails(game, entry);
              success++;
            } else {
              saleChecks[game.appid] = saleCheckForError(game);
              failed++;
            }
          });
          saleSync.progress.done = Math.min(start + batch.length, targets.length);
          saveSaleChecks();
          reconcileDynamicRivers();
          updateSaleSyncOverlay("正在讀取特價資訊中", saleSync.progress.done, targets.length, true);
          render();
        } catch (error) {
          failed += batch.length;
          interrupted = true;
          var errorMessage = error && error.message ? String(error.message) : "批次回傳失敗";
          saleSync.lastError = "第 " + batchNumber + " / " + totalBatches + " 批同步失敗：" + errorMessage + "；已重試 " + SALE_RETRY_DELAYS_MS.length + " 次，未完成項目下次開啟時會重試。";
          saleSyncRetryBlockedUntil = Date.now() + SALE_SYNC_INTERVAL_MS;
          updateSaleSyncOverlay("同步中斷：第 " + batchNumber + " / " + totalBatches + " 批失敗", start, targets.length, true);
          break;
        }
        if (start + SALE_BATCH_SIZE < targets.length) await delay(SALE_BATCH_DELAY_MS);
      }
      saleSync.busy = false;
      saleSync.progress = null;
      if (!interrupted) {
        saleSync.lastRunAt = Date.now();
        priceSnapshot.status = "local_fallback";
        priceSnapshot.generatedAt = saleSync.lastRunAt;
        priceSnapshot.itemCount = Object.keys(saleChecks).length;
        priceSnapshot.lastError = "";
      }
      saleSync.lastResult = { success: success, failed: failed, total: targets.length };
      saveSaleSyncState();
      updateManualSaleSyncButton();
      render();
      if (!interrupted) {
        saleSyncRetryBlockedUntil = 0;
        updateSaleSyncOverlay("特價資訊同步完成", targets.length, targets.length, true);
      }
      window.setTimeout(function () { updateSaleSyncOverlay("", 0, 0, false); }, interrupted ? 4000 : 1200);
    }

    function maybeRunSaleSync() {
      if (saleSync.busy) return;
      if (getSyncTargets(false).length) runSaleSync(false);
    }

    function startSaleSyncOnOpen() {
      window.setTimeout(maybeRunSaleSync, 0);
    }

    async function runManualSaleSync() {
      if (saleSync.busy) return;
      saleSync.busy = true;
      updateManualSaleSyncButton();
      priceSnapshot = { status: "loading", generatedAt: 0, itemCount: 0, lastError: "" };
      updateSaleSyncAge();
      var result = await loadPriceSnapshot();
      applyPriceSnapshot(result);
      saleSync.busy = false;
      updateManualSaleSyncButton();
      updateSaleSyncAge();
      if (result && result.ok) {
        render();
        return;
      }
      runSaleSync(true);
    }

    function updateNameToggle() {
      if (!el.nameToggle) return;
      el.nameToggle.textContent = displayTraditionalNames ? "原名" : "繁中名";
      el.nameToggle.setAttribute("aria-pressed", String(displayTraditionalNames));
      el.nameToggle.title = displayTraditionalNames ? "目前顯示繁體中文名，切換回原名" : "目前顯示原名，切換成繁體中文名";
    }

    function toggleFavorite(id) {
      id = String(id);
      if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
      saveFavorites();
      reconcileDynamicRivers();
      render();
    }

    function favoriteAndNext(id) {
      id = String(id || "");
      if (!id || !gameMap[id]) return;
      var river = activeRiver();
      var navigationIds = river ? riverIdsForCurrentView(river, id) : lastResults.map(function (game) { return game.appid; });
      var position = navigationIds.indexOf(id);
      var nextId = position >= 0 ? navigationIds[position + 1] : "";
      if (!nextId || !gameMap[nextId]) return;
      if (!favorites.has(id)) {
        favorites.add(id);
        saveFavorites();
        reconcileDynamicRivers();
      }
      openDetail(nextId);
    }

    function openDetail(id) {
      id = String(id);
      if (!gameMap[id]) return;
      if (!lastResults.length || !lastResults.some(function (game) { return game.appid === id; })) lastResults = getResults();
      var previousDetailId = state.detailId;
      var river = activeRiver();
      if (river && riverPosition(river, id) >= 0) updateRiverPosition(id);
      else if (!river && previousDetailId && previousDetailId !== id && hasSearchRiverCondition()) ensureRiverForState(lastResults, id);
      state.detailId = id;
      syncUrl(false);
      render();
      jumpToTop();
    }

    function closeDetail() {
      var currentRiver = activeRiver();
      var leavingId = state.detailId;
      if (currentRiver && leavingId) {
        var currentIds = riverIdsForCurrentView(currentRiver, leavingId);
        var currentIndex = currentIds.indexOf(leavingId);
        if (currentIndex >= 0) {
          riverVisibleCount = Math.max(riverVisibleCount, Math.min(currentIds.length, Math.ceil((currentIndex + 1) / pageSize) * pageSize));
        }
      }
      state.detailId = "";
      syncUrl(false);
      render();
      if (currentRiver && leavingId) centerRiverGame(leavingId); else window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function render() {
      document.body.classList.toggle("detail-mode", !!(state.detailId && gameMap[state.detailId]));
      if (state.detailId && gameMap[state.detailId]) {
        el.browse.hidden = true;
        el.detail.hidden = false;
        lastResults = getResults();
        renderDetail(gameMap[state.detailId]);
      } else {
        if (state.detailId) {
          state.detailId = "";
          syncUrl(true);
        }
        el.browse.hidden = false;
        el.detail.hidden = true;
        renderResults();
      }
      syncFormControls();
      updateStorageNote();
    }

    function syncFormControls() {
      el.searchInput.value = state.q;
      updateSortOptionLabel();
      el.sort.value = state.sort;
      el.rating.value = String(sliderIndexForValue(state.rating, RATING_STEPS));
      el.maxPrice.value = String(sliderIndexForValue(state.maxPrice, PRICE_STEPS));
      el.saleOnlyFilter.checked = !!state.saleOnly;
      el.minDiscount.value = String(sliderIndexForValue(state.minDiscount, DISCOUNT_STEPS));
      el.minYear.value = state.minYear;
      el.maxYear.value = state.maxYear;
      el.language.value = state.language;
      el.demoFilter.checked = state.demoOnly;
      Array.from(el.priceChoices.querySelectorAll("[data-price]")).forEach(function (button) { button.classList.toggle("active", button.getAttribute("data-price") === state.price); });
      updateRangeLabels();
      updateNameToggle();
      renderOptionLists();
    }

    function updateSortOptionLabel() {
      if (!el || !el.sort) return;
      var riverOption = el.sort.querySelector('option[value="river"]');
      if (!riverOption) return;
      var current = activeRiver();
      riverOption.textContent = current && current.id === "default" ? "探索河道順序" : "河道記錄順序";
    }

    function sliderIndexForValue(value, steps) {
      var numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric <= 0) return 0;
      var nearest = 0;
      steps.forEach(function (step, index) {
        if (Math.abs(step - numeric) < Math.abs(steps[nearest] - numeric)) nearest = index;
      });
      return nearest;
    }

    function priceRangeText(value) {
      return value ? "NT$ " + formatNumber(value) + " 以下" : "不限";
    }

    function discountRangeText(value) {
      return value ? value + "% OFF 以上" : "不限";
    }

    function updateRangeLabels() {
      var priceIndex = Math.max(0, Math.min(PRICE_STEPS.length - 1, Number(el.maxPrice.value) || 0));
      var discountIndex = Math.max(0, Math.min(DISCOUNT_STEPS.length - 1, Number(el.minDiscount.value) || 0));
      var ratingIndex = Math.max(0, Math.min(RATING_STEPS.length - 1, Number(el.rating.value) || 0));
      el.maxPriceValue.textContent = priceRangeText(PRICE_STEPS[priceIndex]);
      el.saleDiscountValue.textContent = discountRangeText(DISCOUNT_STEPS[discountIndex]);
      el.ratingValue.textContent = RATING_STEPS[ratingIndex] ? RATING_STEPS[ratingIndex] + "% 以上" : "不限";
    }

    function applyRangeFilters() {
      updateRangeLabels();
      var maximum = PRICE_STEPS[Math.max(0, Math.min(PRICE_STEPS.length - 1, Number(el.maxPrice.value) || 0))] || 0;
      var discount = DISCOUNT_STEPS[Math.max(0, Math.min(DISCOUNT_STEPS.length - 1, Number(el.minDiscount.value) || 0))] || 0;
      var rating = RATING_STEPS[Math.max(0, Math.min(RATING_STEPS.length - 1, Number(el.rating.value) || 0))] || 0;
      state.maxPrice = maximum ? String(maximum) : "";
      state.saleOnly = !!el.saleOnlyFilter.checked;
      state.minDiscount = discount ? String(discount) : "";
      state.rating = rating ? String(rating) : "0";
      refreshSearch();
    }

    function rememberActiveRiverFilters() {
      var current = activeRiver();
      if (!current || (isProtectedRiver(current.id) && current.id !== "default")) return;
      var nextFilters = snapshotFilters();
      if (JSON.stringify(current.filters) === JSON.stringify(nextFilters)) return;
      if (current.id !== "default") {
        var currentId = current.position === null ? "" : (current.ids[current.position] || "");
        var oldFilters = normalizeRiverFilters(current.filters || {});
        var oldVisible = current.ids.filter(function (id) {
          return !!gameMap[id] && gameMatchesFilters(gameMap[id], oldFilters);
        });
        var oldVisibleSet = new Set(oldVisible);
        var added = current.ids.filter(function (id) {
          return !oldVisibleSet.has(id) && !!gameMap[id] && gameMatchesFilters(gameMap[id], nextFilters);
        });
        if (added.length) {
          var leading = oldVisible.concat(added);
          var leadingSet = new Set(leading);
          current.ids = leading.concat(current.ids.filter(function (id) { return !leadingSet.has(id); }));
        }
        if (currentId) current.position = Math.max(0, current.ids.indexOf(currentId));
        current.title = riverTitle(nextFilters);
      }
      current.filters = nextFilters;
      current.updatedAt = Date.now();
      saveRivers();
    }

    function beginFilterChange(searchLike) {
      var current = activeRiver();
      if (searchLike && current && isProtectedRiver(current.id)) {
        pendingRiverSourceIds = current.ids.slice();
        state.riverId = "";
        if (state.sort === "river") state.sort = "relevance";
      } else if (searchLike && current) {
        pendingRiverSourceIds = null;
      } else if (searchLike) {
        pendingRiverSourceIds = Array.isArray(pendingRiverSourceIds) ? pendingRiverSourceIds.slice() : null;
      } else if (!current && state.sort === "river") {
        state.sort = "relevance";
      } else if (current) {
        pendingRiverSourceIds = null;
      }
      state.detailId = "";
      riverVisibleCount = pageSize;
    }

    function clearFilters() {
      state.q = "";
      state.topics.clear();
      state.authors.clear();
      state.price = "all";
      state.maxPrice = "";
      state.saleOnly = false;
      state.minDiscount = "";
      state.rating = "0";
      state.minYear = "";
      state.maxYear = "";
      state.language = "all";
      state.demoOnly = false;
      state.sort = "river";
      state.page = 1;
      el.topicSearch.value = "";
      state.riverId = "default";
      state.detailId = "";
      pendingRiverSourceIds = null;
      riverVisibleCount = pageSize;
      rememberActiveRiverFilters();
      syncUrl(true);
      render();
    }

    function closeFilters() {
      el.filters.classList.remove("open");
      el.backdrop.hidden = true;
    }

    function debounce(callback, delay) {
      var timer;
      return function () {
        var args = arguments;
        clearTimeout(timer);
        timer = setTimeout(function () { callback.apply(null, args); }, delay);
      };
    }

    function refreshSearch(searchLike) {
      beginFilterChange(!!searchLike);
      if (searchLike && !hasSearchRiverCondition() && !activeRiver()) {
        state.riverId = "default";
        state.sort = "river";
        pendingRiverSourceIds = null;
      }
      rememberActiveRiverFilters();
      state.page = 1;
      syncUrl(true);
      render();
    }

    function refreshSearchQuery() {
      refreshSearch(true);
    }

    function hasSearchFilters() {
      return !!(state.q || state.topics.size || state.authors.size || state.price !== "all" || state.maxPrice || state.saleOnly || state.minDiscount || state.rating !== "0" || state.minYear || state.maxYear || state.language !== "all" || state.demoOnly);
    }

    function removeActiveFilter(type, value) {
      if (type === "query") state.q = "";
      else if (type === "topic") state.topics.delete(value);
      else if (type === "author") state.authors.delete(value);
      else if (type === "price") state.price = "all";
      else if (type === "sale") { state.saleOnly = false; state.minDiscount = ""; }
      else if (type === "rating") state.rating = "0";
      else if (type === "language") state.language = "all";
      else if (type === "demo") state.demoOnly = false;
      else if (type === "priceRange") state.maxPrice = "";
      else if (type === "yearRange") { state.minYear = ""; state.maxYear = ""; }
      refreshSearch(type === "query" || type === "topic" || type === "author");
    }

    function applyQuickFilter(type, value) {
      if (type === "topic") state.topics.add(value);
      else if (type === "author") state.authors.add(value);
      refreshSearch(type === "topic" || type === "author");
    }

    el.searchForm.addEventListener("submit", function (event) { event.preventDefault(); state.q = el.searchInput.value.trim(); refreshSearchQuery(); });
    el.searchInput.addEventListener("input", debounce(function () { state.q = el.searchInput.value.trim(); refreshSearchQuery(); }, 120));
    el.sort.addEventListener("change", function () {
      beginFilterChange(false);
      state.sort = el.sort.value;
      if (state.sort === "river") {
        if (hasSearchFilters()) state.sort = "relevance";
        else state.riverId = "default";
      }
      rememberActiveRiverFilters();
      state.page = 1;
      syncUrl(true);
      render();
    });
    el.manualSaleSyncButton.addEventListener("click", runManualSaleSync);
    el.importWishlistButton.addEventListener("click", function () { requestSteamImport("wishlist"); });
    el.importOwnedButton.addEventListener("click", function () { requestSteamImport("owned"); });
    el.exportStateButton.addEventListener("click", exportPortalState);
    el.importStateButton.addEventListener("click", function () { el.importStateFile.click(); });
    el.importStateFile.addEventListener("change", function () { importStateFile(el.importStateFile.files && el.importStateFile.files[0]); });
    window.addEventListener("message", receiveImportResult);
    el.language.addEventListener("change", function () { state.language = el.language.value; refreshSearch(); });
    [el.minYear, el.maxYear].forEach(function (input) {
      input.addEventListener("change", function () {
        state.minYear = el.minYear.value;
        state.maxYear = el.maxYear.value;
        refreshSearch();
      });
    });
    [el.maxPrice, el.minDiscount, el.rating].forEach(function (input) {
      input.addEventListener("input", updateRangeLabels);
      input.addEventListener("change", applyRangeFilters);
    });
    el.saleOnlyFilter.addEventListener("change", applyRangeFilters);
    el.priceChoices.addEventListener("click", function (event) {
      var button = event.target.closest("[data-price]");
      if (!button) return;
      state.price = button.getAttribute("data-price");
      refreshSearch();
    });
    el.topicSearch.addEventListener("input", renderOptionLists);
    el.topicOptions.addEventListener("change", filterCheckboxChanged);
    function filterCheckboxChanged(event) {
      var input = event.target;
      if (!input.matches("[data-filter-type]")) return;
      var set = state.topics;
      var value = input.getAttribute("data-filter-value");
      if (input.checked) set.add(value); else set.delete(value);
      refreshSearch(true);
    }
    el.nameToggle.addEventListener("click", function () { displayTraditionalNames = !displayTraditionalNames; saveDisplayTraditionalNames(); render(); });
    el.demoFilter.addEventListener("change", function () { state.demoOnly = el.demoFilter.checked; refreshSearch(); });
    el.activeFilters.addEventListener("click", function (event) {
      var button = event.target.closest("[data-remove-type]");
      if (!button) return;
      event.preventDefault();
      removeActiveFilter(button.getAttribute("data-remove-type"), button.getAttribute("data-remove-value") || "");
    });
    document.getElementById("clearFiltersButton").addEventListener("click", clearFilters);
    document.getElementById("brandLink").addEventListener("click", function (event) { event.preventDefault(); if (state.detailId) closeDetail(); else { clearFilters(); } });
    el.pagination.addEventListener("click", function (event) {
      var loadMore = event.target.closest("[data-river-load-more]");
      if (loadMore) {
        event.preventDefault();
        loadMoreRiverResults();
        return;
      }
      var button = event.target.closest("[data-page]");
      if (!button || button.disabled) return;
      state.page = Number(button.getAttribute("data-page")) || 1;
      syncUrl(true);
      renderResults();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    el.riverList.addEventListener("click", function (event) {
      var deleteButton = event.target.closest("[data-delete-river]");
      if (deleteButton) {
        event.preventDefault();
        event.stopPropagation();
        deleteRiver(deleteButton.getAttribute("data-delete-river"));
        return;
      }
      var openButton = event.target.closest("[data-open-river]");
      if (openButton) {
        event.preventDefault();
        var riverId = openButton.getAttribute("data-open-river");
        openRiver(riverId, isProtectedRiver(riverId));
      }
    });
    el.riverShortcuts.addEventListener("click", function (event) {
      var openButton = event.target.closest("[data-open-river]");
      if (!openButton) return;
      event.preventDefault();
      openRiver(openButton.getAttribute("data-open-river"), true);
    });
    el.riverToggle.addEventListener("click", function () {
      riversCollapsed = !riversCollapsed;
      saveRiversCollapsed();
      renderRivers();
    });
    el.riverReadFilter.addEventListener("change", function () {
      riverReadMode = normalizeRiverReadMode(el.riverReadFilter.value);
      saveRiverReadMode();
      riverVisibleCount = pageSize;
      var current = activeRiver();
      if (state.detailId && current && !riverItemMatchesReadFilter(state.detailId)) {
        state.detailId = "";
        syncUrl(true);
      }
      render();
    });
    el.gameList.addEventListener("click", delegatedClick);
    el.detail.addEventListener("click", delegatedClick);
    function delegatedClick(event) {
      var spoilerReset = event.target.closest("[data-reset-spoilers]");
      if (spoilerReset) {
        event.preventDefault();
        event.stopPropagation();
        concealSpoilers(spoilerReset.getAttribute("data-reset-spoilers"));
        return;
      }
      var spoiler = event.target.closest("[data-reveal-spoiler]");
      if (spoiler) {
        event.preventDefault();
        event.stopPropagation();
        revealSpoilers(spoiler.getAttribute("data-reveal-spoiler"));
        return;
      }
      var favoriteNext = event.target.closest("[data-favorite-next]");
      if (favoriteNext && !favoriteNext.disabled) {
        event.preventDefault();
        event.stopPropagation();
        favoriteAndNext(favoriteNext.getAttribute("data-favorite-next"));
        return;
      }
      var quickFilter = event.target.closest("[data-quick-filter-type]");
      if (quickFilter) {
        event.preventDefault();
        event.stopPropagation();
        applyQuickFilter(quickFilter.getAttribute("data-quick-filter-type"), quickFilter.getAttribute("data-quick-filter-value") || "");
        return;
      }
      var favoriteButton = event.target.closest("[data-favorite-id]");
      if (favoriteButton) { event.preventDefault(); event.stopPropagation(); toggleFavorite(favoriteButton.getAttribute("data-favorite-id")); return; }
      var openButton = event.target.closest("[data-open-game]");
      if (openButton && !openButton.disabled) { event.preventDefault(); openDetail(openButton.getAttribute("data-open-game")); }
    }
    el.mobileFilter.addEventListener("click", function () { el.filters.classList.add("open"); el.backdrop.hidden = false; });
    el.backdrop.addEventListener("click", closeFilters);
    window.addEventListener("popstate", function () {
      state = readUrlState();
      pendingRiverSourceIds = null;
      render();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        if (state.detailId) {
          event.preventDefault();
          closeDetail();
          return;
        }
        var currentRiver = activeRiver();
        var currentIds = riverIdsForCurrentView(currentRiver);
        var currentBook = currentRiver && currentRiver.position !== null ? currentRiver.ids[currentRiver.position] : "";
        if (currentIds.indexOf(currentBook) < 0) currentBook = currentIds[0] || "";
        if (currentBook && gameMap[currentBook]) {
          event.preventDefault();
          openDetail(currentBook);
        }
        return;
      }
      var spoiler = event.target && event.target.closest ? event.target.closest("[data-reveal-spoiler]") : null;
      if (spoiler && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        revealSpoilers(spoiler.getAttribute("data-reveal-spoiler"));
        return;
      }
      if (event.target && ["INPUT", "TEXTAREA", "SELECT"].indexOf(event.target.tagName) >= 0) return;
      if (event.key === "/") { event.preventDefault(); el.searchInput.focus(); }
      if (state.detailId && (event.key === "f" || event.key === "F" || event.code === "ControlRight")) {
        event.preventDefault();
        toggleFavorite(state.detailId);
      }
      if (state.detailId && (event.key === "1" || event.key === "2")) {
        var screenshotButton = document.getElementById(event.key === "1" ? "shotPrev" : "shotNext");
        if (screenshotButton) {
          event.preventDefault();
          screenshotButton.click();
        }
        return;
      }
      if (state.detailId && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        var river = activeRiver();
        var navigationIds = river ? riverIdsForCurrentView(river, state.detailId) : lastResults.map(function (game) { return game.appid; });
        var position = navigationIds.indexOf(state.detailId);
        var targetPosition = event.key === "ArrowLeft" ? position - 1 : position + 1;
        if (targetPosition >= 0 && targetPosition < navigationIds.length) {
          event.preventDefault();
          openDetail(navigationIds[targetPosition]);
        }
      }
    });

    initializePortalState();
  }());
