(function () {
    "use strict";

    var PRICE_SNAPSHOT_URL = window.__STEAM_PORTAL_PRICE_URL__ || "https://raw.githubusercontent.com/gesen2egee/steam_portal/main/data/price.json";
    var PRICE_SNAPSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
    var PRICE_SNAPSHOT_REQUEST_TIMEOUT_MS = 30000;
    var PRICE_STEPS = [0, 50, 100, 200, 300, 500, 800, 1200, 2000, 3000, 5000];
    var DISCOUNT_STEPS = [0, 10, 20, 30, 50, 75, 90];
    var RATING_STEPS = [0, 80, 85, 90, 95];
    var SALE_CHECKS_KEY = "steam_portal_live_prices_v1";
    var SALE_SYNC_STATE_KEY = "steam_portal_price_sync_v1";
    var STATE_EXPORT_FORMAT = "steam-portal-state";
    var STATE_EXPORT_VERSION = 6;
    var STATE_EXPORT_SOURCE = "steam";
    var READ_GAMES_KEY = "steam_portal_read_games_v1";
    var RIVER_READ_FILTER_KEY = "steam_portal_river_read_filter_v1";
    var RIVERS_COLLAPSED_KEY = "steam_portal_rivers_collapsed_v2";
    var PORTAL_SETTINGS_KEY = "steam_portal_settings_v1";
    var EXPORT_LAST_AT_KEY = "steam_portal_export_last_at_v1";
    var EXPORT_DUE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
    var ADULT_TAGS = new Set(["裸露", "色情內容", "Hentai"].map(normalizeText));
    var LIST_COLORS = [
      { key: "orange", label: "橘色" },
      { key: "pink", label: "粉色" },
      { key: "green", label: "綠色" },
      { key: "blue", label: "藍色" },
      { key: "purple", label: "紫色" },
      { key: "cyan", label: "青色" },
      { key: "red", label: "紅色" },
      { key: "yellow", label: "黃色" },
      { key: "teal", label: "藍綠色" },
      { key: "indigo", label: "靛色" },
      { key: "lime", label: "萊姆色" },
      { key: "brown", label: "棕色" },
      { key: "gray", label: "灰色" },
      { key: "magenta", label: "洋紅色" },
      { key: "sky", label: "天藍色" },
      { key: "olive", label: "橄欖色" }
    ];
    var SYSTEM_LIST_DEFAULTS = {
      favorites: { title: "收藏", color: "orange", markRead: true, recommended: true },
      wishlist: { title: "願望清單", color: "pink", markRead: true, recommended: true },
      owned: { title: "已擁有遊戲", color: "green", markRead: true, recommended: false }
    };
    var LIST_EDITOR_PAGE_SIZE = 120;
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

    var embeddedItems = Array.isArray(payload.items) ? payload.items : [];
    var embeddedDetails = Object.create(null);
    embeddedItems.forEach(function (item) {
      embeddedDetails[String(item.appid || "")] = {
        core_points: Array.isArray(item.core_points) ? item.core_points : [],
        player_essay: String(item.player_essay || ""),
        screenshots: Array.isArray(item.screenshots) ? item.screenshots : []
      };
    });
    var dataAdapter = window.__STEAM_PORTAL_DATA_ADAPTER__ || {
      loadCatalog: function () { return Promise.resolve(payload); },
      loadDetail: function (appid) {
        var detail = embeddedDetails[String(appid || "")];
        return detail ? Promise.resolve(detail) : Promise.reject(new Error("找不到遊戲詳情"));
      }
    };
    window.__STEAM_PORTAL_DATA_ADAPTER__ = dataAdapter;

    var games = embeddedItems.map(normalizeGame);
    var gameMap = Object.create(null);
    games.forEach(function (game) { gameMap[game.appid] = game; });
    var storageWorks = true;
    var storageReadyPromise = openPortalDatabase();
    var storageWriteQueue = Promise.resolve();
    var portalReady = false;
    var favorites = new Set();
    var readGames = new Set();
    var lastExportAt = 0;
    var portalSettings = defaultPortalSettings();
    var tagBlacklistKeys = new Set();
    var displayTraditionalNames = false;
    var pageSpoilersHidden = false;
    var mobilePreview = (new URLSearchParams(window.location.search).get("mobile") === "1" || new URLSearchParams(window.location.search).get("m") === "1");
    var saleChecks = Object.create(null);
    var saleSync = { lastRunAt: 0, lastResult: null, lastError: "", busy: false, progress: null };
    var priceSnapshot = { status: "loading", generatedAt: 0, itemCount: 0, lastError: "" };
    var detailRequests = Object.create(null);
    var rivers = [];
    var fixedReadIdsCache = null;
    var settingsSelectedListId = "";
    var settingsListItemQuery = "";
    var settingsListVisibleCount = LIST_EDITOR_PAGE_SIZE;
    var settingsOwnedImportSteamId = "";
    var riversCollapsed = true;
    var riverReadMode = "all";
    var pendingRiverSourceIds = null;
    var lastResults = [];
    var readGamesVersion = 0;
    var settingsVisibilityVersion = 0;
    var priceSnapshotVersion = 0;
    var riverInitializationPending = false;
    var riverViewCache = { key: "", ids: null };
    var state = readUrlState();
    var pageSize = 48;
    var riverVisibleCount = pageSize;
    var riverLoadObserver = null;
    var portalToastTimer = null;
    var topicCounts = Object.create(null);
    var expandedMobileGameIds = new Set();
    var mobileMedia = window.matchMedia("(max-width: 760px)");
    var lastMobileLayout = mobilePreview || mobileMedia.matches;

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
      settingsButton: document.getElementById("settingsButton"),
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
      exportVisibleListButton: document.getElementById("exportVisibleListButton"),
      exportStateButton: document.getElementById("exportStateButton"),
      importStateButton: document.getElementById("settingsImportStateButton"),
      importStateFile: document.getElementById("importStateFile"),
      backupStatus: document.getElementById("backupStatus"),
      filters: document.getElementById("filtersPanel"),
      backdrop: document.getElementById("filtersBackdrop"),
      mobileFilter: document.getElementById("mobileFilterButton"),
      mobileHub: document.getElementById("mobileHubButton"),
      mobileDrawerClose: document.getElementById("mobileDrawerCloseButton"),
      mobileSearchForm: document.getElementById("mobileSearchForm"),
      mobileSearchInput: document.getElementById("mobileSearchInput"),
      mobileRiverList: document.getElementById("mobileRiverList"),
      mobileRiverTitle: document.getElementById("mobileRiverTitle"),
      mobileRiverProgress: document.getElementById("mobileRiverProgress"),
      mobileSettings: document.getElementById("mobileSettingsButton"),
      settingsBackdrop: document.getElementById("settingsBackdrop"),
      settingsClose: document.getElementById("settingsCloseButton"),
      settingsHideSpoilers: document.getElementById("settingsHideSpoilers"),
      settingsAdultEnabled: document.getElementById("settingsAdultEnabled"),
      settingsCaptureExplore: document.getElementById("settingsCaptureExplore"),
      settingsClearExplore: document.getElementById("settingsClearExplore"),
      settingsExploreSummary: document.getElementById("settingsExploreSummary"),
      settingsBlacklistSelect: document.getElementById("settingsBlacklistSelect"),
      settingsBlacklistAdd: document.getElementById("settingsBlacklistAdd"),
      settingsBlacklistList: document.getElementById("settingsBlacklistList"),
      settingsClearRead: document.getElementById("settingsClearRead"),
      settingsClearReadConfirm: document.getElementById("settingsClearReadConfirm"),
      settingsClearReadCancel: document.getElementById("settingsClearReadCancel"),
      settingsClearReadApply: document.getElementById("settingsClearReadApply"),
      settingsListSelect: document.getElementById("settingsListSelect"),
      settingsListName: document.getElementById("settingsListName"),
      settingsListColor: document.getElementById("settingsListColor"),
      settingsListRead: document.getElementById("settingsListRead"),
      settingsListRecommended: document.getElementById("settingsListRecommended"),
      settingsCreateList: document.getElementById("settingsCreateList"),
      settingsSaveList: document.getElementById("settingsSaveList"),
      settingsDeleteList: document.getElementById("settingsDeleteList"),
      settingsListSummary: document.getElementById("settingsListSummary"),
      settingsListItemSearch: document.getElementById("settingsListItemSearch"),
      settingsListItems: document.getElementById("settingsListItems"),
      settingsListActionTarget: document.getElementById("settingsListActionTarget"),
      settingsImportList: document.getElementById("settingsImportList"),
      settingsListImportText: document.getElementById("settingsListImportText"),
      settingsListImportStatus: document.getElementById("settingsListImportStatus"),
      settingsOwnedMhtml: document.getElementById("settingsOwnedMhtml"),
      settingsSteamId64: document.getElementById("settingsSteamId64"),
      settingsBuildWishlistUrl: document.getElementById("settingsBuildWishlistUrl"),
      settingsWishlistApiLink: document.getElementById("settingsWishlistApiLink"),
      settingsWishlistJson: document.getElementById("settingsWishlistJson"),
      settingsImportWishlistJson: document.getElementById("settingsImportWishlistJson"),
      settingsManualImportStatus: document.getElementById("settingsManualImportStatus")
    };

    function initializePortalRivers(initialExploreGameId, renderAfter) {
      ensureDefaultRiver();
      var configuredDefaultRiver = rivers.find(function (river) { return river.id === "default"; });
      if (configuredDefaultRiver) configuredDefaultRiver.filters = normalizeRiverFilters(portalSettings.exploreDefaults);
      prepareExploreRiver(initialExploreGameId);
      var initialDefaultRiver = rivers.find(function (river) { return river.id === "default"; });
      if (!state.riverId && initialDefaultRiver && (state.q || state.topics.size)) pendingRiverSourceIds = initialDefaultRiver.ids.slice();
      reconcileDynamicRivers();
      riverInitializationPending = false;
      initializeRiverPosition();
      topicCounts = countTopicValues();
      if (renderAfter) render();
    }

    function isMobileLayout() {
      return mobilePreview || mobileMedia.matches;
    }

    function syncMobileLayoutClass() {
      lastMobileLayout = isMobileLayout();
      document.body.classList.toggle("mobile-layout", lastMobileLayout);
    }

    function finishPortalInitialization() {
      if (!hasUrlFilterState() && state.riverId === "default") {
        var initialDetailId = state.detailId;
        state = restoreRiverFilters(portalSettings.exploreDefaults);
        state.riverId = "default";
        state.detailId = initialDetailId;
        state.sort = "river";
      }
      if (state.detailId && (!gameMap[state.detailId] || !gameAllowedBySettings(gameMap[state.detailId]))) state.detailId = "";
      var initialExploreGameId = state.riverId === "default" ? state.detailId : "";
      var deferRiverInitialization = !!state.detailId;
      riverInitializationPending = deferRiverInitialization;
      topicCounts = Object.create(null);
      portalReady = true;
      document.body.classList.toggle("mobile-preview", mobilePreview);
      syncMobileLayoutClass();
      if (deferRiverInitialization) {
        lastResults = [gameMap[state.detailId]];
        render();
        window.setTimeout(function () { initializePortalRivers(initialExploreGameId, true); }, 0);
      } else {
        initializePortalRivers(initialExploreGameId, false);
        render();
      }
      updateManualSaleSyncButton();
      updateSaleSyncAge();
      updateExportButton();
      window.setInterval(function () {
        updateSaleSyncAge();
        updateExportButton();
      }, 1000);
    }

    function initializePortalState() {
      var initialPriceResult = null;
      var initialPriceApplied = false;
      function applyInitialPriceResult(result) {
        if (initialPriceApplied) return;
        initialPriceApplied = true;
        applyPriceSnapshot(result);
        if (portalReady) {
          render();
          updateManualSaleSyncButton();
          updateSaleSyncAge();
        }
      }
      loadPriceSnapshot().then(function (result) {
        initialPriceResult = result;
        if (portalReady) applyInitialPriceResult(result);
      });
      Promise.all([
        loadFavorites(),
        loadReadGames(),
        loadPortalSettings(),
        loadSaleChecks(),
        loadSaleSyncState(),
        loadRivers(),
        loadRiversCollapsed(),
        loadRiverReadMode(),
        loadLastExportAt()
      ]).then(function (values) {
        favorites = values[0];
        readGames = values[1];
        readGamesVersion += 1;
        portalSettings = values[2];
        refreshSettingsCaches();
        displayTraditionalNames = portalSettings.displayTraditionalNames;
        pageSpoilersHidden = portalSettings.hideNegative;
        saleChecks = values[3];
        saleSync = values[4];
        rivers = values[5];
        riversCollapsed = values[6];
        riverReadMode = values[7];
        if (initialPriceResult) applyInitialPriceResult(initialPriceResult);
        lastExportAt = values[8];
        finishPortalInitialization();
      }).catch(function () {
        markStorageFailure();
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
      normalized.topicKeys = normalized.topicGroups.reduce(function (all, group) { return all.concat(group.keys); }, []);
      normalized.topicSet = new Set(normalized.topicKeys);
      normalized.tagKeys = normalized.tags.map(normalizeText);
      normalized.authorSet = new Set(normalized.authors);
      normalized.nameKey = normalizeText(normalized.name);
      normalized.translatedNameKey = normalizeText(normalized.translated_name);
      normalized.subtitleKey = normalizeText(normalized.subtitle);
      normalized.searchText = normalizeText([
        normalized.appid, normalized.name, normalized.translated_name,
        normalized.subtitle, normalized.topics.join(" "), normalized.authors.join(" ")
      ].join(" "));
      normalized.releaseYear = Number.isFinite(Number(game.release_year)) ? Number(game.release_year) : null;
      normalized.requiredAge = Number.isFinite(Number(game.required_age)) ? Math.max(0, Number(game.required_age)) : 0;
      normalized.isAdult = normalized.requiredAge > 0 || normalized.topicKeys.some(function (value) { return ADULT_TAGS.has(value); });
      normalized.allowedSettingsVersion = -1;
      normalized.allowedBySettings = false;
      normalized.hasDemo = game.has_demo === true;
      normalized.priceValue = game.price_value === null || game.price_value === undefined ? null : Number(game.price_value);
      normalized.review = game.review && typeof game.review === "object" ? game.review : {};
      normalized.reviewPercent = Number(normalized.review.percent_positive || 0);
      normalized.reviewCount = Number(normalized.review.total_reviews || 0);
      normalized.languages = Array.isArray(game.chinese_languages) ? game.chinese_languages : [];
      normalized.corePointLabels = Array.isArray(game.core_point_labels) ? game.core_point_labels.map(String).slice(0, 3) : [];
      normalized.core_points = Array.isArray(game.core_points) ? game.core_points.map(String) : [];
      normalized.player_essay = String(game.player_essay || "");
      normalized.screenshots = Array.isArray(game.screenshots) ? game.screenshots.map(String) : [];
      normalized.detailStatus = normalized.player_essay || normalized.core_points.length || normalized.screenshots.length ? "ready" : "idle";
      normalized.detailError = "";
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
      return String(value || "").trim().toLowerCase();
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

    function defaultExploreFilters() {
      return normalizeRiverFilters({ sort: "river" });
    }

    function defaultPortalSettings() {
      return {
        displayTraditionalNames: false,
        hideNegative: false,
        detailLayout: "interleaved",
        exploreDefaults: defaultExploreFilters(),
        tagBlacklist: [],
        adultEnabled: false
      };
    }

    function systemListDefaults(id) {
      return SYSTEM_LIST_DEFAULTS[String(id)] || null;
    }

    function normalizeListColor(value) {
      var key = String(value || "").trim().toLowerCase();
      return LIST_COLORS.some(function (color) { return color.key === key; }) ? key : "blue";
    }

    function listColorClass(list) {
      return list && isListRiver(list) ? "list-color-" + normalizeListColor(list.color) : "";
    }

    function isListRiver(river) {
      return !!(river && (river.kind === "list" || systemListDefaults(river.id)));
    }

    function listRivers() {
      return rivers.filter(isListRiver);
    }

    function listColorLabel(value) {
      var found = LIST_COLORS.find(function (color) { return color.key === value; });
      return found ? found.label : "藍色";
    }

    function listDefaultTitle(id) {
      var defaults = systemListDefaults(id);
      return defaults ? defaults.title : "新清單";
    }

    function listDefaultColor(id) {
      var defaults = systemListDefaults(id);
      return defaults ? defaults.color : "blue";
    }

    function listDefaultRead(id) {
      var defaults = systemListDefaults(id);
      return defaults ? defaults.markRead : false;
    }

    function listDefaultRecommended(id) {
      var defaults = systemListDefaults(id);
      return defaults ? defaults.recommended : false;
    }

    function normalizeExploreDefaults(value) {
      var normalized = normalizeRiverFilters(value && typeof value === "object" ? value : {});
      normalized.q = "";
      normalized.topics = [];
      normalized.authors = [];
      normalized.favoritesOnly = false;
      normalized.sort = "river";
      return normalized;
    }

    function normalizePortalSettings(value) {
      var source = value && typeof value === "object" ? value : {};
      return {
        displayTraditionalNames: source.displayTraditionalNames === true,
        hideNegative: source.hideNegative === true,
        detailLayout: source.detailLayout === "separated" ? "separated" : "interleaved",
        exploreDefaults: normalizeExploreDefaults(source.exploreDefaults),
        tagBlacklist: uniqueTopicValues(source.tagBlacklist).sort(function (a, b) { return a.localeCompare(b, "zh-Hant"); }),
        adultEnabled: source.adultEnabled === true
      };
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
      var valuesResult = [];
      var keys = [];
      var local = new Set();
      (Array.isArray(values) ? values : []).forEach(function (value) {
        var text = String(value || "").trim();
        var key = normalizeText(text);
        if (!key || local.has(key) || seen.has(key)) return;
        local.add(key);
        seen.add(key);
        valuesResult.push(text);
        keys.push(key);
      });
      return { kind: kind, values: valuesResult, keys: keys };
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

    function exploreDefaultsSummary(filters) {
      var normalized = normalizeExploreDefaults(filters);
      var parts = [];
      if (normalized.price === "free") parts.push("免費");
      if (normalized.price === "paid") parts.push("付費");
      if (normalized.maxPrice) parts.push("最高 NT$ " + formatNumber(normalized.maxPrice));
      if (normalized.saleOnly) parts.push(normalized.minDiscount ? "特價 " + normalized.minDiscount + "% OFF 以上" : "只看特價");
      else if (normalized.minDiscount) parts.push("折扣 " + normalized.minDiscount + "% OFF 以上");
      if (normalized.rating !== "0") parts.push("好評 " + normalized.rating + "% 以上");
      if (normalized.minYear || normalized.maxYear) parts.push("年份 " + (normalized.minYear || "不限") + "～" + (normalized.maxYear || "不限"));
      if (normalized.language !== "all") parts.push(languageLabel(normalized.language));
      if (normalized.demoOnly) parts.push("有試玩版");
      return parts.length ? parts.join("、") : "無額外限制";
    }

    function renderSettingsPanel() {
      if (!el || !el.settingsBackdrop) return;
      document.querySelectorAll('input[name="settingsNameMode"]').forEach(function (input) {
        input.checked = input.value === (portalSettings.displayTraditionalNames ? "traditional" : "original");
      });
      document.querySelectorAll('input[name="settingsDetailLayout"]').forEach(function (input) {
        input.checked = input.value === portalSettings.detailLayout;
      });
      el.settingsHideSpoilers.checked = portalSettings.hideNegative;
      el.settingsAdultEnabled.checked = portalSettings.adultEnabled;
      el.settingsExploreSummary.textContent = exploreDefaultsSummary(portalSettings.exploreDefaults);
      var available = allTopicNames().filter(function (value) { return !isTagBlacklisted(value); });
      el.settingsBlacklistSelect.innerHTML = available.length ? available.map(function (value) {
        return '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + '</option>';
      }).join("") : '<option value="">沒有可加入的標籤</option>';
      el.settingsBlacklistAdd.disabled = !available.length;
      el.settingsBlacklistList.innerHTML = portalSettings.tagBlacklist.length ? portalSettings.tagBlacklist.map(function (value) {
        return '<span class="blacklist-chip">' + escapeHtml(value) + '<button type="button" data-remove-blacklist="' + escapeHtml(value) + '" aria-label="從黑名單移除 ' + escapeHtml(value) + '">×</button></span>';
      }).join("") : '<span class="meta-line">目前沒有自訂黑名單</span>';
      renderListManager();
    }

    function listById(id) {
      var value = String(id || "");
      return listRivers().find(function (river) { return river.id === value; }) || null;
    }

    function renderListManager() {
      if (!el || !el.settingsListSelect) return;
      var lists = listRivers().slice().sort(riverOrder);
      var selected = listById(settingsSelectedListId);
      if (!selected && lists.length) {
        selected = lists[0];
        settingsSelectedListId = selected.id;
      }
      el.settingsListSelect.innerHTML = lists.length ? lists.map(function (list) {
        return '<option value="' + escapeHtml(list.id) + '">' + escapeHtml(displayRiverTitle(list)) + '（' + formatNumber(list.ids.length) + '）</option>';
      }).join("") : '<option value="">尚未建立清單</option>';
      el.settingsListSelect.value = selected ? selected.id : "";
      el.settingsListColor.innerHTML = LIST_COLORS.map(function (color) {
        return '<option value="' + escapeHtml(color.key) + '">' + escapeHtml(color.label) + '</option>';
      }).join("");
      if (selected) {
        el.settingsListName.value = selected.title;
        el.settingsListColor.value = normalizeListColor(selected.color);
        el.settingsListRead.checked = !!selected.markRead;
        el.settingsListRecommended.checked = !!selected.recommended;
        el.settingsListSummary.textContent = displayRiverTitle(selected) + "　" + formatNumber(selected.ids.length) + " 款遊戲" + (selected.markRead ? "　清單內容算已讀" : "") + (selected.recommended ? "　會影響探索推薦" : "");
      } else {
        el.settingsListName.value = "";
        el.settingsListColor.value = "blue";
        el.settingsListRead.checked = false;
        el.settingsListRecommended.checked = false;
        el.settingsListSummary.textContent = "請先建立清單";
      }
      el.settingsSaveList.disabled = !selected;
      el.settingsDeleteList.disabled = !selected || isProtectedRiver(selected.id);
      var targetOptions = lists.filter(function (list) { return !selected || list.id !== selected.id; });
      el.settingsListActionTarget.innerHTML = targetOptions.length ? targetOptions.map(function (list) {
        return '<option value="' + escapeHtml(list.id) + '">' + escapeHtml(displayRiverTitle(list)) + '</option>';
      }).join("") : '<option value="">沒有其他清單</option>';
      el.settingsListActionTarget.disabled = !targetOptions.length;
      if (!selected) {
        el.settingsListItems.innerHTML = '<div class="list-manager-summary">建立清單後，可在這裡整理遊戲。</div>';
        return;
      }
      var query = normalizeText(settingsListItemQuery);
      var matched = selected.ids.map(function (id, index) {
        return { id: id, index: index, game: gameMap[id] };
      }).filter(function (entry) {
        if (!query) return true;
        return entry.id.indexOf(query) >= 0 || normalizeText(entry.game ? entry.game.name : "").indexOf(query) >= 0;
      });
      var shown = matched.slice(0, settingsListVisibleCount);
      var rows = shown.map(function (entry) {
        var name = entry.game ? entry.game.name : "未知遊戲（" + entry.id + "）";
        return '<div class="list-item"><span class="list-item-number">' + escapeHtml(String(entry.index + 1)) + '</span><span class="list-item-name" title="' + escapeHtml(name + "　App ID " + entry.id) + '">' + escapeHtml(name) + '</span><span class="list-item-actions"><button type="button" class="button" data-list-move-up="' + escapeHtml(String(entry.index)) + '" aria-label="上移">↑</button><button type="button" class="button" data-list-move-down="' + escapeHtml(String(entry.index)) + '" aria-label="下移">↓</button><button type="button" class="button" data-list-copy-item="' + escapeHtml(String(entry.index)) + '"' + (el.settingsListActionTarget.disabled ? ' disabled' : '') + '>複製</button><button type="button" class="button" data-list-move-item="' + escapeHtml(String(entry.index)) + '"' + (el.settingsListActionTarget.disabled ? ' disabled' : '') + '>移動</button><button type="button" class="button list-remove" data-list-remove-item="' + escapeHtml(String(entry.index)) + '">刪除</button></span></div>';
      });
      if (matched.length > shown.length) rows.push('<button type="button" class="button" data-list-load-more>顯示更多（還有 ' + formatNumber(matched.length - shown.length) + ' 款）</button>');
      el.settingsListItems.innerHTML = rows.length ? rows.join("") : '<div class="list-manager-summary">找不到符合條件的遊戲。</div>';
    }

    function createList() {
      var title = String(el.settingsListName.value || "").trim() || "新清單";
      var now = Date.now();
      var id = "list-" + now + "-" + Math.floor(Math.random() * 1000000);
      var list = {
        id: id,
        title: title,
        kind: "list",
        color: normalizeListColor(el.settingsListColor.value),
        markRead: !!el.settingsListRead.checked,
        recommended: !!el.settingsListRecommended.checked,
        listType: "custom",
        filters: normalizeRiverFilters({ sort: "relevance" }),
        ids: [],
        position: null,
        createdAt: now,
        updatedAt: now,
        isDefault: false
      };
      rivers.push(list);
      rivers.sort(riverOrder);
      settingsSelectedListId = id;
      saveRivers();
      prepareExploreRiver();
      renderListManager();
      renderRivers();
      showPortalToast("已建立清單「" + title + "」");
    }

    function saveSelectedListSettings() {
      var list = listById(settingsSelectedListId);
      if (!list) return;
      var title = String(el.settingsListName.value || "").trim();
      if (!title) {
        showPortalToast("清單名稱不能是空白");
        el.settingsListName.focus();
        return;
      }
      list.title = title;
      list.color = normalizeListColor(el.settingsListColor.value);
      list.markRead = !!el.settingsListRead.checked;
      list.recommended = !!el.settingsListRecommended.checked;
      list.updatedAt = Date.now();
      invalidateFixedReadIds();
      saveRivers();
      prepareExploreRiver();
      renderListManager();
      render();
      showPortalToast("已保存清單設定");
    }

    function deleteSelectedList() {
      var list = listById(settingsSelectedListId);
      if (!list || isProtectedRiver(list.id)) return;
      if (!window.confirm("確定刪除清單「" + displayRiverTitle(list) + "」？清單中的遊戲不會從資料庫刪除。")) return;
      rivers = rivers.filter(function (river) { return river.id !== list.id; });
      if (state.riverId === list.id) {
        state = restoreRiverFilters({ sort: "river" });
        state.riverId = "default";
        state.detailId = "";
        syncUrl(true);
      }
      settingsSelectedListId = "";
      saveRivers();
      renderSettingsPanel();
      render();
      showPortalToast("已刪除清單");
    }

    function afterListMutation(message) {
      invalidateFixedReadIds();
      rivers.sort(riverOrder);
      prepareExploreRiver();
      reconcileDynamicRivers();
      saveRivers();
      renderSettingsPanel();
      render();
      if (message) showPortalToast(message);
    }

    function mutateSelectedList(mutator) {
      var list = listById(settingsSelectedListId);
      if (!list) return;
      var currentId = list.position === null ? "" : (list.ids[list.position] || "");
      mutator(list);
      if (currentId && list.ids.indexOf(currentId) >= 0) list.position = list.ids.indexOf(currentId);
      else if (!list.ids.length) list.position = null;
      else if (list.position === null || list.position >= list.ids.length) list.position = list.ids.length - 1;
      list.updatedAt = Date.now();
      afterListMutation();
    }

    function moveSelectedListItem(index, direction) {
      var list = listById(settingsSelectedListId);
      var targetIndex = Number(index) + Number(direction);
      if (!list || !Number.isInteger(Number(index)) || Number(index) < 0 || targetIndex < 0 || targetIndex >= list.ids.length) return;
      mutateSelectedList(function (selected) {
        var item = selected.ids[Number(index)];
        selected.ids[Number(index)] = selected.ids[targetIndex];
        selected.ids[targetIndex] = item;
      });
    }

    function removeSelectedListItem(index) {
      var list = listById(settingsSelectedListId);
      index = Number(index);
      if (!list || !Number.isInteger(index) || index < 0 || index >= list.ids.length) return;
      var removed = list.ids[index];
      mutateSelectedList(function (selected) {
        selected.ids.splice(index, 1);
        if (selected.id === "favorites") favorites.delete(removed);
      });
      if (list.id === "favorites") syncFavoriteRiver();
    }

    function copyOrMoveSelectedListItem(index, move) {
      var source = listById(settingsSelectedListId);
      var target = listById(el.settingsListActionTarget.value);
      index = Number(index);
      if (!source || !target || source.id === target.id || !Number.isInteger(index) || index < 0 || index >= source.ids.length) return;
      var id = source.ids[index];
      if (target.ids.indexOf(id) < 0) target.ids.push(id);
      if (target.id === "favorites") favorites.add(id);
      if (move) {
        source.ids.splice(index, 1);
        if (source.id === "favorites") favorites.delete(id);
      }
      if (!source.ids.length) source.position = null;
      if (source.position !== null && source.position >= source.ids.length) source.position = source.ids.length - 1;
      source.updatedAt = Date.now();
      target.updatedAt = Date.now();
      if (source.id === "favorites" || target.id === "favorites") syncFavoriteRiver();
      afterListMutation(move ? "已移動遊戲到「" + displayRiverTitle(target) + "」" : "已複製遊戲到「" + displayRiverTitle(target) + "」");
    }

    function buildOriginalNameIndex() {
      var index = Object.create(null);
      games.forEach(function (game) {
        var key = game.nameKey;
        if (key && !index[key]) index[key] = game.appid;
      });
      return index;
    }

    function importedAppIdFromLine(line, nameIndex) {
      var value = String(line || "").trim();
      if (!value) return "";
      var urlMatch = value.match(/\/(?:app|games)\/(\d{1,9})(?:\/|[?#]|$)/i);
      if (urlMatch && gameMap[urlMatch[1]]) return urlMatch[1];
      if (/^\d{1,9}$/.test(value) && gameMap[value]) return value;
      return nameIndex[normalizeText(value)] || "";
    }

    function importTextIntoSelectedList() {
      var list = listById(settingsSelectedListId);
      if (!list) {
        el.settingsListImportStatus.textContent = "請先建立或選擇清單";
        return;
      }
      var nameIndex = buildOriginalNameIndex();
      var incoming = [];
      var seen = new Set();
      var unmatched = [];
      String(el.settingsListImportText.value || "").split(/\r?\n/).forEach(function (line) {
        var trimmed = line.trim();
        if (!trimmed) return;
        var appid = importedAppIdFromLine(trimmed, nameIndex);
        if (!appid) { unmatched.push(trimmed); return; }
        if (seen.has(appid)) return;
        seen.add(appid);
        incoming.push(appid);
      });
      var added = 0;
      incoming.forEach(function (appid) {
        if (list.ids.indexOf(appid) >= 0) return;
        list.ids.push(appid);
        if (list.id === "favorites") favorites.add(appid);
        added++;
      });
      if (incoming.length || unmatched.length) {
        list.updatedAt = Date.now();
        if (list.id === "favorites") syncFavoriteRiver();
        afterListMutation();
      }
      el.settingsListImportText.value = "";
      el.settingsListImportStatus.textContent = "已新增 " + formatNumber(added) + " 款；已存在 " + formatNumber(incoming.length - added) + " 款；無法匹配 " + formatNumber(unmatched.length) + " 行";
    }

    function decodeMhtmlQuotedPrintable(value) {
      return String(value || "").replace(/=\r?\n/g, "").replace(/=([0-9a-f]{2})/gi, function (_, hex) {
        return String.fromCharCode(parseInt(hex, 16));
      });
    }

    function parseOwnedMhtml(value) {
      var source = decodeMhtmlQuotedPrintable(value);
      var ids = [];
      var seen = new Set();
      function add(raw) {
        var appid = String(raw || "");
        if (/^\d{1,9}$/.test(appid) && gameMap[appid] && !seen.has(appid)) {
          seen.add(appid);
          ids.push(appid);
        }
      }
      var patterns = [
        /data-(?:ds-)?appid\s*=\s*["']?(\d{1,9})/gi,
        /\/(?:app|games)\/(\d{1,9})(?:\/|[?#]|$)/gi,
        /["']appid["']?\s*[:=]\s*["']?(\d{1,9})/gi
      ];
      patterns.forEach(function (pattern) {
        var match;
        while ((match = pattern.exec(source))) add(match[1]);
      });
      var marker = source.search(/g_rgOwnedApps|g_rgAppInfo|games_list_rows/i);
      if (marker >= 0) {
        var chunk = source.slice(marker, marker + 2000000);
        var numbers = chunk.match(/\b\d{2,9}\b/g) || [];
        numbers.forEach(function (number) { if (gameMap[number]) add(number); });
      }
      var steamIdMatch = source.match(/(?:g_steamID|steamid|steamID64)[^0-9]{0,30}(\d{17})/i) || source.match(/\/profiles\/(\d{17})/i);
      return { appids: ids, steamId64: steamIdMatch ? steamIdMatch[1] : "" };
    }

    function setManualImportStatus(message, isError) {
      if (!el.settingsManualImportStatus) return;
      el.settingsManualImportStatus.textContent = String(message || "");
      el.settingsManualImportStatus.style.color = isError ? "var(--danger)" : "";
    }

    function updateWishlistApiLink() {
      var steamId = String(el.settingsSteamId64.value || "").trim();
      settingsOwnedImportSteamId = /^\d{10,20}$/.test(steamId) ? steamId : "";
      if (!settingsOwnedImportSteamId) {
        el.settingsWishlistApiLink.hidden = true;
        el.settingsWishlistApiLink.removeAttribute("href");
        return;
      }
      var url = "https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=" + encodeURIComponent(settingsOwnedImportSteamId);
      el.settingsWishlistApiLink.href = url;
      el.settingsWishlistApiLink.textContent = "開啟願望清單 JSON（" + settingsOwnedImportSteamId + "）";
      el.settingsWishlistApiLink.hidden = false;
    }

    function importOwnedMhtml(file) {
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (event) {
        var result = parseOwnedMhtml(event.target.result);
        if (result.steamId64) {
          el.settingsSteamId64.value = result.steamId64;
          updateWishlistApiLink();
        }
        if (!result.appids.length) {
          setManualImportStatus("MHTML 中沒有匹配到本站遊戲 App ID；請確認 Steam 遊戲頁已拉到底後再另存。", true);
          return;
        }
        var syncResult = syncImportedRiver("owned", result.appids);
        prepareExploreRiver();
        renderSettingsPanel();
        render();
        setManualImportStatus("已從 MHTML 讀取已擁有遊戲：" + formatNumber(syncResult.total) + " 款" + (result.steamId64 ? "；已取得 SteamID64" : "；沒有取得 SteamID64"));
      };
      reader.onerror = function () { setManualImportStatus("無法讀取 MHTML 檔案", true); };
      reader.readAsText(file);
    }

    function collectWishlistJsonAppIds(value, result, seen, depth) {
      if (depth > 8 || value === null || value === undefined) return;
      if (typeof value === "number" || typeof value === "string") {
        var text = String(value).trim();
        var urlMatch = text.match(/\/(?:app|games)\/(\d{1,9})(?:\/|[?#]|$)/i);
        var appid = urlMatch ? urlMatch[1] : text;
        if (/^\d{1,9}$/.test(appid) && gameMap[appid] && !seen.has(appid)) {
          seen.add(appid);
          result.push(appid);
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(function (item) { collectWishlistJsonAppIds(item, result, seen, depth + 1); });
        return;
      }
      Object.keys(value).forEach(function (key) {
        if (/^\d{1,9}$/.test(key) && gameMap[key] && !seen.has(key)) {
          seen.add(key);
          result.push(key);
        }
        if (/^(?:app_?id|id)$/i.test(key) || /^\d{1,9}$/.test(key)) collectWishlistJsonAppIds(value[key], result, seen, depth + 1);
        else if (value[key] && typeof value[key] === "object") collectWishlistJsonAppIds(value[key], result, seen, depth + 1);
      });
    }

    function importWishlistJsonText() {
      var parsed;
      try { parsed = JSON.parse(String(el.settingsWishlistJson.value || "")); }
      catch (error) { setManualImportStatus("願望清單內容不是有效的 JSON", true); return; }
      var ids = [];
      collectWishlistJsonAppIds(parsed, ids, new Set(), 0);
      if (!ids.length) {
        setManualImportStatus("JSON 中沒有匹配到本站遊戲 App ID", true);
        return;
      }
      var syncResult = syncImportedRiver("wishlist", ids);
      prepareExploreRiver();
      renderSettingsPanel();
      render();
      el.settingsWishlistJson.value = "";
      setManualImportStatus("願望清單同步完成：" + formatNumber(syncResult.total) + " 款；已取代上次官方清單");
    }

    function openSettings() {
      renderSettingsPanel();
      el.settingsClearReadConfirm.hidden = true;
      el.settingsBackdrop.hidden = false;
      document.body.style.overflow = "hidden";
      el.settingsClose.focus();
    }

    function closeSettings() {
      if (!el || !el.settingsBackdrop || el.settingsBackdrop.hidden) return;
      el.settingsBackdrop.hidden = true;
      document.body.style.overflow = "";
      if (el.settingsButton) el.settingsButton.focus();
    }

    function settingsVisibilityChanged(message) {
      refreshSettingsCaches();
      state.topics = new Set(Array.from(state.topics).filter(function (value) { return !isTagBlacklisted(value); }));
      topicCounts = countTopicValues();
      pendingRiverSourceIds = null;
      riverVisibleCount = pageSize;
      if (state.detailId && !gameAllowedBySettings(gameMap[state.detailId])) {
        state.detailId = "";
        syncUrl(true);
      }
      renderSettingsPanel();
      render();
      if (message) showPortalToast(message);
    }

    function captureExploreDefaults() {
      portalSettings.exploreDefaults = normalizeExploreDefaults(snapshotFilters());
      savePortalSettings();
      var river = rivers.find(function (item) { return item.id === "default"; });
      if (river) {
        river.filters = normalizeRiverFilters(portalSettings.exploreDefaults);
        saveRivers();
      }
      renderSettingsPanel();
      showPortalToast("已保存探索河道的啟動篩選");
    }

    function clearExploreDefaults() {
      portalSettings.exploreDefaults = defaultExploreFilters();
      savePortalSettings();
      var river = rivers.find(function (item) { return item.id === "default"; });
      if (river) {
        river.filters = normalizeRiverFilters(portalSettings.exploreDefaults);
        saveRivers();
      }
      renderSettingsPanel();
      showPortalToast("已清除探索河道的啟動篩選");
    }

    function addBlacklistTag(value) {
      var tag = String(value || "").trim();
      if (!tag || isTagBlacklisted(tag)) return;
      portalSettings.tagBlacklist.push(tag);
      savePortalSettings();
      settingsVisibilityChanged("已隱藏標籤「" + tag + "」及相關遊戲");
    }

    function removeBlacklistTag(value) {
      var key = normalizeText(value);
      portalSettings.tagBlacklist = portalSettings.tagBlacklist.filter(function (tag) { return normalizeText(tag) !== key; });
      savePortalSettings();
      settingsVisibilityChanged("已從標籤黑名單移除「" + value + "」");
    }

    function clearReadHistory() {
      readGames.clear();
      readGamesVersion += 1;
      saveReadGames();
      prepareExploreRiver();
      el.settingsClearReadConfirm.hidden = true;
      render();
      showPortalToast("已清除手動閱讀紀錄");
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
      var controller = new AbortController();
      var timeoutId = window.setTimeout(function () { controller.abort(); }, PRICE_SNAPSHOT_REQUEST_TIMEOUT_MS);
      return fetch(priceSnapshotRequestUrl(), {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal
      }).then(function (response) {
        if (!response.ok) throw new Error("GitHub price.json HTTP " + response.status);
        return response.json();
      }).then(function (payload) {
        window.clearTimeout(timeoutId);
        return payload;
      }, function (error) {
        window.clearTimeout(timeoutId);
        if (error && error.name === "AbortError") throw new Error("價格同步逾時");
        throw error;
      });
    }

    function loadPriceSnapshot() {
      return fetchPriceSnapshotFromNetwork().then(parsePriceSnapshotPayload).catch(function (networkError) {
        return {
          ok: false,
          status: "unavailable",
          generatedAt: 0,
          itemCount: 0,
          items: Object.create(null),
          error: networkError && networkError.message ? String(networkError.message) : "網路請求失敗"
        };
      });
    }

    function applyPriceSnapshot(result) {
      priceSnapshotVersion += 1;
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
      el.exportStateButton.title = due ? (lastExportAt ? "距上次匯出已超過 7 天" : "尚未匯出清單 JSON") : "下載清單、河道與閱讀狀態 JSON";
    }

    function markGameRead(id) {
      var appid = String(id || "");
      if (!appid || readGames.has(appid)) return;
      readGames.add(appid);
      readGamesVersion += 1;
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

    function loadPortalSettings() {
      return safeStorageGet(PORTAL_SETTINGS_KEY).then(function (raw) {
        if (!raw) return defaultPortalSettings();
        try { return normalizePortalSettings(JSON.parse(raw)); }
        catch (error) { return defaultPortalSettings(); }
      });
    }

    function savePortalSettings() {
      portalSettings = normalizePortalSettings(portalSettings);
      refreshSettingsCaches();
      displayTraditionalNames = portalSettings.displayTraditionalNames;
      safeStorageSet(PORTAL_SETTINGS_KEY, JSON.stringify(portalSettings));
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
          lists: listRivers().map(function (list) { return normalizeRiver(list); }).filter(Boolean),
          rivers: rivers.map(function (river) { return normalizeRiver(river); }).filter(Boolean),
          riversCollapsed: !!riversCollapsed,
          riverReadMode: riverReadMode,
          settings: normalizePortalSettings(portalSettings)
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
        setBackupStatus("已匯出清單 JSON；匯入時會與本機資料合併");
      } catch (error) {
        setBackupStatus("匯出失敗，請確認瀏覽器允許下載檔案", true);
      }
    }

    function exportVisibleGameList() {
      try {
        var current = activeRiver();
        var visibleGames;
        if (current) {
          visibleGames = lastResults.slice(0, Math.min(riverVisibleCount, lastResults.length));
        } else {
          var start = Math.max(0, (state.page - 1) * pageSize);
          visibleGames = lastResults.slice(start, start + pageSize);
        }
        var lines = [];
        visibleGames.forEach(function (game) {
          lines.push(String(game.name || ""));
          lines.push("https://store.steampowered.com/app/" + encodeURIComponent(game.appid) + "/");
          lines.push("");
          lines.push("");
        });
        var blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var link = document.createElement("a");
        link.href = url;
        var now = new Date();
        var stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(function (value) { return String(value).padStart(2, "0"); }).join("") + "_" + [now.getHours(), now.getMinutes()].map(function (value) { return String(value).padStart(2, "0"); }).join("");
        link.download = "steam_games_" + stamp + ".txt";
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 0);
        setBackupStatus("已匯出 " + formatNumber(visibleGames.length) + " 款原名與 Steam 網址");
      } catch (error) {
        setBackupStatus("匯出遊戲清單失敗，請確認瀏覽器允許下載檔案", true);
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
      if (!payload || payload.format !== STATE_EXPORT_FORMAT || Number(payload.version) !== STATE_EXPORT_VERSION || payload.source !== STATE_EXPORT_SOURCE || !payload.state || typeof payload.state !== "object" || !Array.isArray(payload.state.lists)) {
        throw new Error("不是本入口匯出的同步資料");
      }
      return {
        favorites: normalizeImportedIds(payload.state.favorites),
        readGames: normalizeImportedIds(payload.state.readGames),
        lists: (Array.isArray(payload.state.lists) ? payload.state.lists : []).map(function (list) { return normalizeRiver(list); }).filter(function (list) { return list && isListRiver(list); }),
        rivers: (Array.isArray(payload.state.rivers) ? payload.state.rivers : []).map(function (river) { return normalizeRiver(river); }).filter(Boolean),
        riversCollapsed: typeof payload.state.riversCollapsed === "boolean" ? payload.state.riversCollapsed : riversCollapsed,
        riverReadMode: normalizeRiverReadMode(payload.state.riverReadMode),
        settings: normalizePortalSettings(payload.state.settings)
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
      var mergedReadGames = new Set(Array.from(readGames));
      imported.readGames.forEach(function (id) { mergedReadGames.add(id); });
      var importedRivers = imported.rivers.slice();
      var importedRiverIds = new Set(importedRivers.map(function (river) { return river.id; }));
      imported.lists.forEach(function (list) {
        if (!importedRiverIds.has(list.id)) importedRivers.push(list);
      });
      rivers = mergeImportedRivers(importedRivers);
      var importedFavorites = rivers.find(function (river) { return river.id === "favorites"; });
      if (importedFavorites) favorites = new Set(importedFavorites.ids);
      else {
        var mergedFavorites = new Set(Array.from(favorites));
        imported.favorites.forEach(function (id) { mergedFavorites.add(id); });
        favorites = mergedFavorites;
      }
      readGames = mergedReadGames;
      readGamesVersion += 1;
      invalidateFixedReadIds();
      pendingRiverSourceIds = null;
      riversCollapsed = imported.riversCollapsed;
      riverReadMode = imported.riverReadMode;
      portalSettings = imported.settings;
      refreshSettingsCaches();
      displayTraditionalNames = portalSettings.displayTraditionalNames;
      pageSpoilersHidden = portalSettings.hideNegative;
      saveFavorites();
      saveReadGames();
      saveRiversCollapsed();
      saveRiverReadMode();
      savePortalSettings();
      ensureDefaultRiver();
      reconcileDynamicRivers();
      topicCounts = countTopicValues();
      saveRivers();
      state = readUrlState();
      render();
      setBackupStatus("已匯入並合併；清單 " + formatNumber(imported.lists.length) + " 個、河道 " + formatNumber(imported.rivers.length) + " 條");
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

    function loadRivers() {
      return safeStorageGet("steam_portal_rivers_v1").then(function (raw) {
        if (!raw) return [];
        try {
          var values = JSON.parse(raw);
          if (!Array.isArray(values)) return [];
          return values.map(normalizeRiver).filter(function (river) {
            return river && (isListRiver(river) || !river.filters.favoritesOnly);
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
      var systemDefaults = systemListDefaults(riverId);
      var listLike = riverId !== "default" && (river.kind === "list" || !!systemDefaults);
      var legacyTitles = { "收藏河道": "收藏", "Steam 願望清單": "願望清單", "Steam 已擁有遊戲": "已擁有遊戲" };
      var incomingTitle = String(river.title || "").trim();
      if (legacyTitles[incomingTitle]) incomingTitle = legacyTitles[incomingTitle];
      var defaultTitle = riverId === "default" ? "探索河道" : systemDefaults ? systemDefaults.title : listLike ? "新清單" : "搜尋河道";
      return {
        id: riverId,
        title: String(riverId === "default" ? defaultTitle : incomingTitle || defaultTitle),
        kind: listLike ? "list" : "search",
        color: listLike ? normalizeListColor(river.color || (systemDefaults && systemDefaults.color) || "blue") : "blue",
        markRead: listLike ? typeof river.markRead === "boolean" ? river.markRead : listDefaultRead(riverId) : false,
        recommended: listLike ? typeof river.recommended === "boolean" ? river.recommended : listDefaultRecommended(riverId) : false,
        listType: listLike ? (systemDefaults ? riverId : "custom") : "",
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
      riverViewCache = { key: "", ids: null };
      safeStorageSet("steam_portal_rivers_v1", JSON.stringify(rivers));
      updateStorageNote();
    }

    function invalidateFixedReadIds() {
      fixedReadIdsCache = null;
      readGamesVersion += 1;
    }

    function fixedReadIds() {
      if (fixedReadIdsCache) return fixedReadIdsCache;
      fixedReadIdsCache = new Set();
      listRivers().forEach(function (river) {
        if (!river.markRead) return;
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

      var favoriteSet = new Set(favoriteIds);
      var oldIds = existing ? existing.ids.slice() : [];
      var nextIds = oldIds.filter(function (id) { return favoriteSet.has(id); });
      favoriteIds.forEach(function (id) { if (nextIds.indexOf(id) < 0) nextIds.push(id); });
      var oldPosition = existing ? existing.position : null;
      var currentId = existing && oldPosition !== null ? (oldIds[oldPosition] || "") : "";
      var nextPosition = null;
      if (currentId && nextIds.indexOf(currentId) >= 0) nextPosition = nextIds.indexOf(currentId);
      else if (oldPosition !== null && nextIds.length) nextPosition = Math.min(oldPosition, nextIds.length - 1);
      var nextFilters = existing ? normalizeRiverFilters(existing.filters) : normalizeRiverFilters({ favoritesOnly: true, sort: "relevance" });
      var changed = !existing || oldIds.join("\u0000") !== nextIds.join("\u0000") || oldPosition !== nextPosition;
      if (!existing) {
        existing = {
          id: "favorites",
          title: listDefaultTitle("favorites"),
          kind: "list",
          color: listDefaultColor("favorites"),
          markRead: listDefaultRead("favorites"),
          recommended: listDefaultRecommended("favorites"),
          listType: "favorites",
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
      existing.kind = "list";
      existing.listType = "favorites";
      existing.color = normalizeListColor(existing.color || listDefaultColor("favorites"));
      existing.markRead = typeof existing.markRead === "boolean" ? existing.markRead : listDefaultRead("favorites");
      existing.recommended = typeof existing.recommended === "boolean" ? existing.recommended : listDefaultRecommended("favorites");
      existing.filters = nextFilters;
      existing.ids = nextIds;
      existing.position = nextPosition;
      if (changed) existing.updatedAt = Date.now();
      invalidateFixedReadIds();
      return changed;
    }

    function syncImportedRiver(kind, appids) {
      var definition = systemListDefaults(kind) ? { id: kind, title: listDefaultTitle(kind) } : null;
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
      if (existing && !nextIds.length) {
        rivers = rivers.filter(function (river) { return river.id !== definition.id; });
        invalidateFixedReadIds();
        if (state && state.riverId === definition.id) {
          var defaultRiver = rivers.find(function (river) { return river.id === "default"; });
          state = restoreRiverFilters(defaultRiver ? defaultRiver.filters : { sort: "river" });
          state.riverId = "default";
          state.detailId = "";
          syncUrl(true);
        }
        saveRivers();
        return { added: added, removed: removed, total: 0, ignored: ignored };
      }

      var oldPosition = existing ? existing.position : null;
      var currentId = existing && oldPosition !== null ? (oldIds[oldPosition] || "") : "";
      var nextPosition = currentId && nextIds.indexOf(currentId) >= 0 ? nextIds.indexOf(currentId) : (nextIds.length ? Math.min(oldPosition === null ? 0 : oldPosition, nextIds.length - 1) : null);
      var changed = !existing || added > 0 || removed > 0 || oldIds.join("\u0000") !== nextIds.join("\u0000") || oldPosition !== nextPosition;
      if (!existing) {
        existing = {
          id: definition.id,
          title: definition.title,
          kind: "list",
          color: listDefaultColor(definition.id),
          markRead: listDefaultRead(definition.id),
          recommended: listDefaultRecommended(definition.id),
          listType: definition.id,
          filters: normalizeRiverFilters({ sort: "relevance" }),
          ids: nextIds,
          position: nextPosition,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          isDefault: false
        };
        rivers.push(existing);
      } else {
        existing.kind = "list";
        existing.listType = definition.id;
        existing.color = normalizeListColor(existing.color || listDefaultColor(definition.id));
        existing.markRead = typeof existing.markRead === "boolean" ? existing.markRead : listDefaultRead(definition.id);
        existing.recommended = typeof existing.recommended === "boolean" ? existing.recommended : listDefaultRecommended(definition.id);
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

    function initializeRiverPosition() {
      var river = activeRiver();
      if (!river || !river.ids.length) return;
      var requestedId = String(state.detailId || "");
      var requestedPosition = requestedId ? river.ids.indexOf(requestedId) : -1;
      var nextPosition = river.id === "default" || requestedPosition < 0 ? 0 : requestedPosition;
      if (river.position === nextPosition) return;
      river.position = nextPosition;
      river.updatedAt = Date.now();
      saveRivers();
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
      listRivers().forEach(function (list) {
        if (!list.recommended) return;
        list.ids.forEach(function (id) { if (gameMap[id]) ids.add(String(id)); });
      });
      return Array.from(ids);
    }

    function exploreTagHeat() {
      var referenceIds = exploreReferenceIds();
      if (!referenceIds.length) return null;
      var heat = Object.create(null);
      referenceIds.forEach(function (id) {
        var game = gameMap[id];
        if (!gameAllowedBySettings(game)) return;
        var seenTags = new Set();
        (game && Array.isArray(game.tags) ? game.tags : []).forEach(function (value, index) {
          var key = game.tagKeys[index];
          if (!key || EXPLORE_COMMON_TAGS.has(key) || seenTags.has(key) || tagBlacklistKeys.has(key)) return;
          seenTags.add(key);
          heat[key] = (heat[key] || 0) + 1;
        });
      });
      return Object.keys(heat).length ? heat : null;
    }

    function exploreGameWeight(id, heat) {
      var game = gameMap[id];
      if (!game || !heat || !gameAllowedBySettings(game)) return 0;
      var seenTags = new Set();
      return (Array.isArray(game.tags) ? game.tags : []).reduce(function (total, value, index) {
        var key = game.tagKeys[index];
        if (!key || EXPLORE_COMMON_TAGS.has(key) || seenTags.has(key) || tagBlacklistKeys.has(key)) return total;
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

    function prepareExploreRiver(firstId) {
      var river = rivers.find(function (item) { return item.id === "default"; });
      if (!river) return;
      var previousIds = river.ids.slice();
      var sourceIds = games.map(function (game) { return game.appid; });
      var unread = [];
      var read = [];
      sourceIds.forEach(function (id) {
        (isGameRead(id) ? read : unread).push(id);
      });
      var first = String(firstId || "");
      var hasFirst = !!first && sourceIds.indexOf(first) >= 0 && gameMap[first] && gameAllowedBySettings(gameMap[first]);
      if (hasFirst) {
        unread = unread.filter(function (id) { return id !== first; });
        read = read.filter(function (id) { return id !== first; });
      }
      var heat = exploreTagHeat();
      var unreadOrder = buildExploreBucketOrder(unread, heat);
      var readOrder = buildExploreBucketOrder(read, heat);
      river.ids = (hasFirst ? [first] : []).concat(unreadOrder, readOrder);
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
      if (isListRiver(a) && !isListRiver(b)) return -1;
      if (!isListRiver(a) && isListRiver(b)) return 1;
      return Number(b.createdAt || 0) - Number(a.createdAt || 0) || String(a.title).localeCompare(String(b.title), "zh-Hant");
    }

    function isProtectedRiver(id) {
      return String(id) === "default" || !!systemListDefaults(id);
    }

    function activeRiver() {
      if (riverInitializationPending) return null;
      return rivers.find(function (river) { return river.id === state.riverId; }) || null;
    }

    function riverItemMatchesReadFilter(id) {
      var isRead = isGameRead(id);
      return riverReadMode === "read" ? isRead : riverReadMode === "unread" ? !isRead : true;
    }

    function riverIdsForReadFilter(river, includeId) {
      if (!river) return [];
      var forcedId = includeId ? String(includeId) : "";
      var filters = river.filters ? buildFilterContext(river.filters) : null;
      return river.ids.filter(function (id) {
        var game = gameMap[id];
        if (!game || (filters && !gameMatchesFilters(game, river.filters, filters))) return false;
        return id === forcedId || riverItemMatchesReadFilter(id);
      });
    }

    function currentRiverViewCacheKey(river, includeId) {
      return JSON.stringify([
        river.id,
        river.updatedAt,
        river.ids.length,
        String(includeId || ""),
        riverReadMode,
        readGamesVersion,
        settingsVisibilityVersion,
        priceSnapshotVersion,
        state.q,
        Array.from(state.topics),
        Array.from(state.authors),
        state.price,
        state.maxPrice,
        state.saleOnly,
        state.minDiscount,
        state.rating,
        state.minYear,
        state.maxYear,
        state.language,
        state.favoritesOnly,
        state.demoOnly
      ]);
    }

    function riverIdsForCurrentView(river, includeId) {
      if (!river) return [];
      if (activeRiver() !== river) return riverIdsForReadFilter(river, includeId);
      var cacheKey = currentRiverViewCacheKey(river, includeId);
      if (riverViewCache.key === cacheKey && riverViewCache.ids) return riverViewCache.ids;
      var forcedId = includeId ? String(includeId) : "";
      var filters = buildFilterContext(state);
      var ids = river.ids.filter(function (id) {
        var game = gameMap[id];
        return !!game && gameMatchesFilters(game, state, filters) && (id === forcedId || riverItemMatchesReadFilter(id));
      });
      riverViewCache = { key: cacheKey, ids: ids };
      return ids;
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
      var scopeContext = buildFilterContext(scopeFilters);
      var defaultRiver = rivers.find(function (river) { return river.id === "default"; });
      var sourceIds = Array.isArray(pendingRiverSourceIds) ? pendingRiverSourceIds : (defaultRiver ? defaultRiver.ids : []);
      var ids = sourceIds.filter(function (id) {
        return !!gameMap[id] && gameMatchesFilters(gameMap[id], scopeFilters, scopeContext);
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
      var scopeContext = buildFilterContext(scopeFilters);
      var ids = [];
      var seenIds = new Set();
      var defaultRiver = rivers.find(function (river) { return river.id === "default"; });
      var sourceIds = Array.isArray(pendingRiverSourceIds) ? pendingRiverSourceIds : (defaultRiver ? defaultRiver.ids : results.map(function (game) { return game && game.appid; }));
      sourceIds.forEach(function (value) {
        var appid = String(value || "");
        if (!appid || seenIds.has(appid) || !gameMap[appid]) return;
        if (!gameMatchesFilters(gameMap[appid], scopeFilters, scopeContext)) return;
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

    function riverGameMatches(game, filters, keepUnresolvedSale, context) {
      var saleFilter = filters.price === "sale" || filters.saleOnly || Number(filters.minDiscount || 0) > 0;
      if (saleFilter && keepUnresolvedSale) {
        var saleInfo = liveSaleInfo(game);
        var unresolved = !saleInfo.record || saleInfo.status === "unseen" || saleInfo.record.status === "error";
        if (unresolved) {
          var fallbackFilters = Object.assign({}, filters, { price: "all", saleOnly: false, minDiscount: "" });
          return gameMatchesFilters(game, fallbackFilters, buildFilterContext(fallbackFilters));
        }
      }
      return gameMatchesFilters(game, filters, context || buildFilterContext(filters));
    }

    function reconcileDynamicRivers() {
      var changed = syncFavoriteRiver();
      rivers.forEach(function (river) {
        if (!riverHasDynamicFilter(river)) return;
        var oldIds = river.ids.slice();
        var oldPosition = river.position;
        var currentId = oldPosition === null ? "" : (oldIds[oldPosition] || "");
        var knownIds = new Set(oldIds);
        var filterContext = buildFilterContext(river.filters);
        var nextIds = oldIds.filter(function (id) {
          var game = gameMap[id];
          return !!game && riverGameMatches(game, river.filters, true, filterContext);
        });
        games.forEach(function (game) {
          if (knownIds.has(game.appid)) return;
          if (riverGameMatches(game, river.filters, false, filterContext)) nextIds.push(game.appid);
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
        el.storageNote.textContent = "目前瀏覽器不允許使用 IndexedDB 保存清單、河道、閱讀狀態與名稱顯示偏好；本次工作階段仍可正常瀏覽。";
      } else {
        el.storageNote.hidden = true;
      }
    }

    function refreshSettingsCaches() {
      tagBlacklistKeys = new Set(portalSettings.tagBlacklist.map(normalizeText));
      settingsVisibilityVersion += 1;
    }

    function isTagBlacklisted(value) {
      return tagBlacklistKeys.has(normalizeText(value));
    }

    function isAdultGame(game) {
      return !!(game && game.isAdult);
    }

    function gameAllowedBySettings(game) {
      if (!game) return false;
      if (game.allowedSettingsVersion === settingsVisibilityVersion) return game.allowedBySettings;
      game.allowedBySettings = (portalSettings.adultEnabled || !isAdultGame(game)) && !game.topicKeys.some(function (key) {
        return tagBlacklistKeys.has(key);
      });
      game.allowedSettingsVersion = settingsVisibilityVersion;
      return game.allowedBySettings;
    }

    function visibleTopicGroups(game) {
      return game.topicGroups.map(function (group) {
        return { kind: group.kind, values: group.values.filter(function (value, index) { return !tagBlacklistKeys.has(group.keys[index]); }) };
      }).filter(function (group) { return group.values.length; });
    }

    function allTopicNames() {
      var values = Object.create(null);
      games.forEach(function (game) {
        game.topics.forEach(function (value) { values[value] = true; });
      });
      return Object.keys(values).sort(function (a, b) { return a.localeCompare(b, "zh-Hant"); });
    }

    function countTopicValues() {
      var counts = Object.create(null);
      games.forEach(function (game) {
        if (!gameAllowedBySettings(game)) return;
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

    function hasUrlFilterState() {
      var params = new URLSearchParams(window.location.search);
      return ["q", "price", "max_price", "sale", "discount", "rating", "year_from", "year_to", "language", "demo", "sort", "topic", "tag", "genre", "author"].some(function (key) {
        return params.has(key);
      });
    }

    function syncUrl(replace) {
      try {
        var url = new URL(window.location.href);
        var params = url.searchParams;
        ["q", "price", "max_price", "sale", "discount", "rating", "year_from", "year_to", "language", "favorites", "demo", "sort", "page", "game", "river", "topic", "tag", "genre", "author", "mobile", "m"].forEach(function (key) { params.delete(key); });
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
        if (mobilePreview) params.set("mobile", "1");
        var query = params.toString();
        var target = url.pathname + (query ? "?" + query : "") + url.hash;
        if (replace) window.history.replaceState({}, "", target);
        else window.history.pushState({}, "", target);
      } catch (error) {}
    }

    function gameMatches(game) {
      return gameMatchesFilters(game, state);
    }

    function buildFilterContext(filters) {
      var source = filters || {};
      var topicValues = Array.isArray(source.topics) ? source.topics : Array.from(source.topics || []);
      var authorValues = Array.isArray(source.authors) ? source.authors : Array.from(source.authors || []);
      var minDiscount = Number(source.minDiscount || 0);
      return {
        query: normalizeText(source.q),
        topics: topicValues.map(normalizeText),
        authors: authorValues,
        price: String(source.price || "all"),
        saleOnly: !!source.saleOnly,
        minDiscount: Number.isFinite(minDiscount) ? minDiscount : 0,
        hasMaxPrice: !!source.maxPrice,
        maxPrice: Number(source.maxPrice || 0),
        rating: Number(source.rating || 0),
        minYear: Number(source.minYear || 0),
        maxYear: Number(source.maxYear || 0),
        language: String(source.language || "all"),
        favoritesOnly: !!source.favoritesOnly,
        demoOnly: !!source.demoOnly
      };
    }

    function gameMatchesFilters(game, filters, context) {
      if (!gameAllowedBySettings(game)) return false;
      var activeFilters = context || buildFilterContext(filters);
      if (activeFilters.query && game.searchText.indexOf(activeFilters.query) === -1) return false;
      if (activeFilters.topics.length && !activeFilters.topics.some(function (topic) { return game.topicSet.has(topic); })) return false;
      if (activeFilters.authors.length && !activeFilters.authors.every(function (author) { return game.authorSet.has(author); })) return false;
      if (activeFilters.price === "free" && !game.is_free) return false;
      if (activeFilters.price === "paid" && game.is_free) return false;
      if (activeFilters.saleOnly || activeFilters.price === "sale" || activeFilters.minDiscount > 0) {
        var saleInfo = liveSaleInfo(game);
        if ((activeFilters.price === "sale" || activeFilters.saleOnly) && !saleInfo.isSale) return false;
        if (activeFilters.minDiscount > 0 && (!saleInfo.isSale || saleInfo.discountPercent < activeFilters.minDiscount)) return false;
      }
      if (activeFilters.hasMaxPrice) {
        var gamePrice = priceValueFor(game);
        if (gamePrice === null || gamePrice > activeFilters.maxPrice) return false;
      }
      if (activeFilters.rating > 0 && game.reviewPercent < activeFilters.rating) return false;
      if (activeFilters.minYear && (game.releaseYear === null || game.releaseYear < activeFilters.minYear)) return false;
      if (activeFilters.maxYear && (game.releaseYear === null || game.releaseYear > activeFilters.maxYear)) return false;
      if (activeFilters.language !== "all" && !hasLanguage(game, activeFilters.language)) return false;
      if (activeFilters.favoritesOnly && !favorites.has(game.appid)) return false;
      if (activeFilters.demoOnly && !game.hasDemo) return false;
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
      var original = game.nameKey;
      var translated = game.translatedNameKey;
      var subtitle = game.subtitleKey;
      if (original === query || translated === query) return 1000;
      if (original.indexOf(query) === 0 || translated.indexOf(query) === 0) return 850;
      if (original.indexOf(query) >= 0 || translated.indexOf(query) >= 0) return 700;
      if (subtitle.indexOf(query) >= 0) return 600;
      if (game.topicKeys.some(function (topic) { return topic.indexOf(query) >= 0; })) return 450;
      return 100;
    }

    function getResults() {
      if (riverInitializationPending && state.detailId && gameMap[state.detailId]) return [gameMap[state.detailId]];
      var query = normalizeText(state.q);
      var river = activeRiver();
      if (river) {
        return riverIdsForCurrentView(river).map(function (id) { return gameMap[id]; }).filter(Boolean);
      }
      if (Array.isArray(pendingRiverSourceIds)) {
        var snapshot = snapshotFilters();
        var snapshotContext = buildFilterContext(snapshot);
        return pendingRiverSourceIds.map(function (id) { return gameMap[id]; }).filter(function (game) {
          return !!game && gameMatchesFilters(game, snapshot, snapshotContext);
        });
      }
      var stateContext = buildFilterContext(state);
      var result = games.filter(function (game) { return gameMatchesFilters(game, state, stateContext); });
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
      if (systemListDefaults(river.id)) return listDefaultTitle(river.id);
      return "搜尋河道";
    }

    function renderRivers() {
      var current = activeRiver() || pendingSearchRiver();
      el.riverReadFilter.value = riverReadMode;
      el.riverCount.textContent = current ? riverProgress(current) : "";
      el.riverToggle.setAttribute("aria-expanded", String(!riversCollapsed));
      el.riverToggle.textContent = riversCollapsed ? "展開" : "收起";
      var listShortcuts = listRivers().filter(function (river) { return river.ids.length > 0; }).sort(riverOrder);
      var shortcutHtml = listShortcuts.map(function (river) {
        var title = displayRiverTitle(river);
        var active = current && current.id === river.id;
        return '<button type="button" class="river-shortcut ' + escapeHtml(listColorClass(river)) + (active ? ' active' : '') + '" data-open-river="' + escapeHtml(river.id) + '" title="' + escapeHtml(title + "　" + riverProgress(river)) + '" aria-label="開啟' + escapeHtml(title) + '">' + escapeHtml(title) + '</button>';
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
        var editButton = isListRiver(river) && !river.pending ? '<button type="button" class="river-edit ' + escapeHtml(listColorClass(river)) + '" data-edit-list="' + escapeHtml(river.id) + '" aria-label="編輯' + escapeHtml(title) + '" title="編輯清單">✎</button>' : '';
        var openAttribute = river.pending ? ' aria-label="尚未保存的搜尋河道"' : ' data-open-river="' + escapeHtml(river.id) + '" aria-label="開啟' + escapeHtml(title) + '"';
        return '<div class="river-item"><button type="button" class="river-main ' + escapeHtml(listColorClass(river)) + (active ? ' active' : '') + '"' + openAttribute + (river.pending ? ' disabled' : '') + '><span class="river-copy"><span class="river-title">' + escapeHtml(title) + '</span><span class="river-progress" aria-hidden="true"><i style="width:' + riverProgressPercent(river) + '%"></i></span></span><span class="river-meta">' + escapeHtml(riverProgress(river)) + '</span></button>' + editButton + deleteButton + '</div>';
      }).join("");
      var mobileRivers = rivers.slice().sort(riverOrder);
      if (current && !mobileRivers.some(function (river) { return river.id === current.id; })) mobileRivers.unshift(current);
      el.mobileRiverTitle.textContent = current ? displayRiverTitle(current) : "探索河道";
      el.mobileRiverProgress.textContent = current ? riverProgress(current) : "0 / 0";
      el.mobileRiverList.innerHTML = mobileRivers.map(function (river) {
        var active = current && current.id === river.id;
        var title = displayRiverTitle(river);
        return '<button type="button" class="mobile-river-option' + (active ? ' active' : '') + '" data-open-river="' + escapeHtml(river.id) + '"' + (river.pending ? ' disabled' : '') + '><span>' + escapeHtml(title) + '</span><em>' + escapeHtml(riverProgress(river)) + '</em></button>';
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
      if (isMobileLayout()) return mobileGameCardHtml(game);
      var topicEntries = visibleTopicGroups(game).reduce(function (all, group) {
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

    function mobileIconSvg(kind, active) {
      if (kind === "steam") return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="16.8" cy="7.2" r="3.7"></circle><circle cx="7.1" cy="16.8" r="2.6"></circle><path d="M9.5 15.8l4.5-5.3M4.7 15.4l-2.8-1.1M9 18l4.8 2"></path></svg>';
      if (kind === "database") return '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5" rx="7" ry="3"></ellipse><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7"></path></svg>';
      if (kind === "essay") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4v13H6z"></path><path d="M14 3.5v5h4M9 12.5h6M9 15.5h6"></path><path class="essay-arrow" d="m8.8 18.2 3.2 2.3 3.2-2.3"></path></svg>';
      if (kind === "chevron") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';
      return '<svg viewBox="0 0 24 24" aria-hidden="true"' + (active ? ' class="filled"' : '') + '><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"></path></svg>';
    }

    function mobileGameActionsHtml(game, location) {
      var favorite = favorites.has(game.appid);
      var steamUrl = 'https://store.steampowered.com/app/' + encodeURIComponent(game.appid) + '/';
      var steamDbUrl = 'https://steamdb.info/app/' + encodeURIComponent(game.appid) + '/';
      return '<div class="mobile-game-actions mobile-game-actions-' + location + '" aria-label="遊戲快捷操作">' +
        '<a class="mobile-icon-action steam" href="' + steamUrl + '" target="_blank" rel="noopener" aria-label="前往 Steam">' + mobileIconSvg("steam") + '</a>' +
        '<a class="mobile-icon-action steamdb" href="' + steamDbUrl + '" target="_blank" rel="noopener" aria-label="前往 SteamDB">' + mobileIconSvg("database") + '</a>' +
        '<button type="button" class="mobile-icon-action favorite' + (favorite ? ' active' : '') + '" data-favorite-id="' + escapeHtml(game.appid) + '" aria-label="' + (favorite ? '取消收藏' : '加入收藏') + '" aria-pressed="' + String(favorite) + '">' + mobileIconSvg("star", favorite) + '</button></div>';
    }

    function mobileEssayFooterActionsHtml(game) {
      var favorite = favorites.has(game.appid);
      var steamUrl = 'https://store.steampowered.com/app/' + encodeURIComponent(game.appid) + '/';
      var steamDbUrl = 'https://steamdb.info/app/' + encodeURIComponent(game.appid) + '/';
      return '<a class="mobile-text-action steam" href="' + steamUrl + '" target="_blank" rel="noopener">Steam</a>' +
        '<a class="mobile-text-action steamdb" href="' + steamDbUrl + '" target="_blank" rel="noopener">SteamDB</a>' +
        '<button type="button" class="mobile-text-action favorite' + (favorite ? ' active' : '') + '" data-favorite-id="' + escapeHtml(game.appid) + '" aria-label="' + (favorite ? '取消收藏' : '加入收藏') + '" aria-pressed="' + String(favorite) + '">' + (favorite ? '已收藏' : '收藏') + '</button>';
    }

    function mobileEssayRegionHtml(game, title) {
      if (!expandedMobileGameIds.has(game.appid)) return "";
      if (game.detailStatus === "error") {
        return '<section class="mobile-player-essay" data-mobile-essay="' + escapeHtml(game.appid) + '"><div class="mobile-essay-status"><strong>玩家心得載入失敗</strong><button type="button" class="button" data-retry-mobile-detail="' + escapeHtml(game.appid) + '">重試</button></div></section>';
      }
      if (game.detailStatus !== "ready") {
        return '<section class="mobile-player-essay" data-mobile-essay="' + escapeHtml(game.appid) + '"><div class="mobile-essay-status">正在載入圖文心得…</div></section>';
      }
      var screenshotUrls = game.screenshots.slice(0, 12).map(safeUrl).filter(Boolean);
      return '<section class="mobile-player-essay" data-mobile-essay="' + escapeHtml(game.appid) + '"><div class="mobile-essay-copy">' + essayHtml(game.player_essay, game.appid, screenshotUrls, title) + '</div><footer class="mobile-essay-footer">' + mobileEssayFooterActionsHtml(game) + '<button type="button" class="mobile-collapse-essay" data-mobile-essay-toggle="' + escapeHtml(game.appid) + '">收起心得</button></footer></section>';
    }

    function mobileGameCardHtml(game) {
      var title = displayName(game);
      var cover = safeUrl(game.header_image);
      var coverHtml = cover ? '<img class="mobile-game-cover-image" src="' + escapeHtml(cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer" aria-hidden="true">' : '<div class="mobile-game-cover-missing">暫無封面</div>';
      var genreGroup = visibleTopicGroups(game).find(function (group) { return group.kind === "genre"; });
      var genres = genreGroup ? genreGroup.values.map(function (value) { return topicPillHtml(value, "genre"); }).join("") : "";
      var coreLabels = game.corePointLabels.map(function (label) { return '<span>' + escapeHtml(label) + '</span>'; }).join("");
      var review = game.reviewCount ? escapeHtml(game.reviewPercent) + '% 好評' : '尚無評價';
      var price = escapeHtml(displayPrice(game));
      var language = languageText(game.languages);
      var expanded = expandedMobileGameIds.has(game.appid);
      return '<article class="mobile-game-card" data-mobile-game-card="' + escapeHtml(game.appid) + '"><section class="mobile-game-visual">' + coverHtml + '<div class="mobile-game-shade"></div><div class="mobile-game-overlay"><div class="mobile-game-title-row"><h3>' + escapeHtml(title) + '</h3>' + mobileGameActionsHtml(game, "cover") + '</div>' + (genres ? '<div class="mobile-genre-strip">' + genres + '</div>' : '') + (coreLabels ? '<div class="mobile-core-prefixes">' + coreLabels + '</div>' : '') + '<div class="mobile-game-facts"><span class="mobile-fact-language ' + (language === "無中文" ? "language-none" : "") + '">' + escapeHtml(language) + '</span><span class="mobile-fact-primary"><span>' + review + '</span><span>' + price + '</span></span></div></div></section><section class="mobile-summary-row"><p>' + escapeHtml(game.summary || '暫無摘要。') + '</p><button type="button" class="mobile-essay-toggle" data-mobile-essay-toggle="' + escapeHtml(game.appid) + '" aria-expanded="' + String(expanded) + '" aria-label="' + (expanded ? '收起玩家心得' : '展開玩家心得') + '" title="' + (expanded ? '收起玩家心得' : '展開玩家心得') + '">' + mobileIconSvg("essay") + '</button></section>' + mobileEssayRegionHtml(game, title) + '</article>';
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

    function applyLoadedDetail(game, detail) {
      game.core_points = Array.isArray(detail && detail.core_points) ? detail.core_points.map(String) : [];
      game.player_essay = String(detail && detail.player_essay || "");
      game.screenshots = Array.isArray(detail && detail.screenshots) ? detail.screenshots.map(String) : [];
      game.detailStatus = "ready";
      game.detailError = "";
    }

    function loadGameDetail(game, retry) {
      if (!game) return Promise.reject(new Error("找不到遊戲"));
      if (game.detailStatus === "ready" && !retry) return Promise.resolve(game);
      if (detailRequests[game.appid] && !retry) return detailRequests[game.appid];
      game.detailStatus = "loading";
      game.detailError = "";
      var request = Promise.resolve(dataAdapter.loadDetail(game.appid)).then(function (detail) {
        applyLoadedDetail(game, detail);
        delete detailRequests[game.appid];
        if (state.detailId === game.appid) render();
        return game;
      }).catch(function (error) {
        delete detailRequests[game.appid];
        game.detailStatus = "error";
        game.detailError = error && error.message ? String(error.message) : "詳情資料載入失敗";
        if (state.detailId === game.appid) render();
        throw error;
      });
      detailRequests[game.appid] = request;
      return request;
    }

    function renderDetailStatus(game) {
      var failed = game.detailStatus === "error";
      var title = failed ? "詳情載入失敗" : "正在載入遊戲詳情";
      var message = failed ? escapeHtml(game.detailError || "這款遊戲的詳情暫時無法讀取。") : "心得、核心要點與截圖載入中…";
      el.detail.innerHTML = '<article class="detail-card"><div class="detail-content"><h1>《' + escapeHtml(displayName(game)) + '》</h1><div class="about-box"><strong>' + title + '</strong><p>' + message + '</p>' + (failed ? '<button type="button" class="button" data-retry-detail="' + escapeHtml(game.appid) + '">重試載入</button> ' : '') + '<button type="button" class="button ghost" id="detailHome">回到河道</button></div></div></article>';
      var home = document.getElementById("detailHome");
      if (home) home.addEventListener("click", closeDetail);
    }

    function renderDetail(game) {
      if (!game || !gameAllowedBySettings(game)) {
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
      var classification = visibleTopicGroups(game).reduce(function (all, group) {
        return all.concat(group.values.map(function (value) { return topicPillHtml(value, group.kind); }));
      }, []).join("");
      var developers = companyLinks(game.developers);
      var publishers = companyLinks(game.publishers);
      var review = game.reviewCount ? escapeHtml(game.review.description || "社群評價") + "　" + escapeHtml(game.reviewPercent) + "% 好評（" + escapeHtml(formatNumber(game.reviewCount)) + " 則）" : "尚無評價";
      var language = languageHtml(game.languages);
      var favorite = favorites.has(game.appid);
      var steamAction = '<span class="steam-action">' + (game.hasDemo ? '<small class="demo-note">有試玩版</small>' : '') + '<a class="button steam-link" href="https://store.steampowered.com/app/' + encodeURIComponent(game.appid) + '/" target="_blank" rel="noopener">前往 Steam</a></span>';
      var screenshotUrls = game.screenshots.slice(0, 12).map(safeUrl).filter(Boolean);
      screenshotUrls.forEach(function (url) { var preload = new Image(); preload.referrerPolicy = "no-referrer"; preload.src = url; });
      var points = game.core_points.map(function (point) { return pointHtml(point, game.appid); }).join("");
      var separatedLayout = portalSettings.detailLayout === "separated";
      var screenshotSection = separatedLayout ? separateScreenshotsHtml(screenshotUrls, title) : "";
      var progressParts = (currentPosition + 1) + " / " + navigationIds.length;
      var homeLabel = river || state.riverId ? "回到河道" : "回到搜尋";
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
        screenshotSection +
        (points ? '<section class="detail-section"><h2>三大核心要點</h2><div class="selling-box"><ul>' + points + '</ul></div></section>' : '') +
        '<section class="detail-section"><div class="detail-section-head"><h2>✍ 玩家心得</h2></div><div class="player-essay">' + essayHtml(game.player_essay, game.appid, separatedLayout ? [] : screenshotUrls, title) + '</div></section></div></article>';
      var home = document.getElementById("detailHome");
      if (home) home.addEventListener("click", closeDetail);
      var detailFavorite = document.getElementById("detailFavorite");
      if (detailFavorite) detailFavorite.addEventListener("click", function () { toggleFavorite(game.appid); });
    }

    function spoilerTextHtml(text, appid) {
      var value = String(text || "");
      if (!value.includes("||")) return escapeHtml(value);
      if (!pageSpoilersHidden) return escapeHtml(value.replace(/\|\|([\s\S]*?)\|\|/g, "$1"));
      var output = "";
      var lastIndex = 0;
      var pattern = /\|\|([\s\S]*?)\|\|/g;
      var match;
      while ((match = pattern.exec(value))) {
        output += escapeHtml(value.slice(lastIndex, match.index));
        output += '<span class="spoiler-mask" aria-label="劇透內容已隱藏">' + escapeHtml(match[1]) + '</span>';
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

    function essayImageHtml(url, title, index) {
      var safe = safeUrl(url);
      if (!safe) return "";
      return '<figure class="essay-image"><a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener"><img src="' + escapeHtml(safe) + '" alt="' + escapeHtml(String(title || "遊戲") + " 截圖 " + (index + 1)) + '" loading="eager" decoding="async" referrerpolicy="no-referrer"></a></figure>';
    }

    function separateScreenshotsHtml(imageUrls, title) {
      var images = (Array.isArray(imageUrls) ? imageUrls : []).map(function (url, index) {
        var safe = safeUrl(url);
        if (!safe) return "";
        return '<a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener"><img src="' + escapeHtml(safe) + '" alt="' + escapeHtml(String(title || "遊戲") + " 截圖 " + (index + 1)) + '" loading="eager" decoding="async" referrerpolicy="no-referrer"></a>';
      }).join("");
      return images ? '<section class="detail-section separate-screenshots"><h2>遊戲截圖</h2><div class="separate-screenshot-strip">' + images + '</div></section>' : "";
    }

    function essayHtml(text, appid, imageUrls, title) {
      var lines = String(text || "").split(/\r?\n/);
      var blocks = [];
      var paragraph = [];
      function flush() {
        if (!paragraph.length) return;
        blocks.push({ kind: "paragraph", html: '<p>' + spoilerTextHtml(paragraph.join(" "), appid) + '</p>' });
        paragraph = [];
      }
      lines.forEach(function (line) {
        var trimmed = line.trim();
        if (!trimmed) { flush(); return; }
        if (trimmed.indexOf("## ") === 0) { flush(); blocks.push({ kind: "heading", html: '<h3>' + spoilerTextHtml(trimmed.slice(3), appid) + '</h3>' }); return; }
        paragraph.push(trimmed);
      });
      flush();
      if (!blocks.length) return '<p>暫無玩家心得。</p>';
      var paragraphIndexes = blocks.map(function (block, index) { return block.kind === "paragraph" ? index : -1; }).filter(function (index) { return index >= 0; });
      var insertionIndexes = new Set(paragraphIndexes.slice(0, -1));
      var images = (Array.isArray(imageUrls) ? imageUrls : []).slice(0, insertionIndexes.size);
      var imageIndex = 0;
      return blocks.map(function (block, blockIndex) {
        var image = insertionIndexes.has(blockIndex) && imageIndex < images.length ? essayImageHtml(images[imageIndex], title, imageIndex++) : "";
        return block.html + image;
      }).join("");
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
        el.saleSyncAge.textContent = "中央價格已超過 12 小時，顯示最後一次有效快取";
        return;
      }
      if (priceSnapshot.status === "unavailable") {
        el.saleSyncAge.textContent = "中央價格暫時無法使用，顯示最後一次有效快取";
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
      render();
    }

    function rerenderDetailAtCurrentScroll() {
      var scrollTop = window.scrollY;
      render();
      window.requestAnimationFrame(function () { window.scrollTo(0, scrollTop); });
    }

    function togglePageSpoilers() {
      if (!state.detailId) return;
      pageSpoilersHidden = !pageSpoilersHidden;
      rerenderDetailAtCurrentScroll();
      showPortalToast(pageSpoilersHidden ? "本頁負評／劇透已隱藏" : "本頁負評／劇透已顯示");
    }

    function toggleMobilePreview() {
      mobilePreview = !mobilePreview;
      document.body.classList.toggle("mobile-preview", mobilePreview);
      syncMobileLayoutClass();
      syncUrl(true);
      render();
      showPortalToast(mobilePreview ? "已切換手機版預覽（M）" : "已切回桌面版（M）");
    }

    function toggleDetailLayout() {
      portalSettings.detailLayout = portalSettings.detailLayout === "separated" ? "interleaved" : "separated";
      savePortalSettings();
      if (state.detailId) rerenderDetailAtCurrentScroll(); else render();
      renderSettingsPanel();
      showPortalToast(portalSettings.detailLayout === "separated" ? "已切換為圖文分開" : "已切換為圖文交錯");
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
      if (!gameMap[id] || !gameAllowedBySettings(gameMap[id])) return;
      if (state.detailId !== id) pageSpoilersHidden = portalSettings.hideNegative;
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
      document.body.classList.toggle("detail-layout-separated", portalSettings.detailLayout === "separated");
      if (state.detailId && gameMap[state.detailId]) {
        el.browse.hidden = true;
        el.detail.hidden = false;
        lastResults = getResults();
        var detailGame = gameMap[state.detailId];
        if (detailGame.detailStatus === "ready") {
          renderDetail(detailGame);
        } else {
          renderDetailStatus(detailGame);
          if (detailGame.detailStatus === "idle") loadGameDetail(detailGame, false).catch(function () {});
        }
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
      if (el.mobileSearchInput) el.mobileSearchInput.value = state.q;
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
      if (!current || isListRiver(current)) return;
      var nextFilters = snapshotFilters();
      if (JSON.stringify(current.filters) === JSON.stringify(nextFilters)) return;
      if (current.id !== "default") {
        var currentId = current.position === null ? "" : (current.ids[current.position] || "");
        var oldFilters = normalizeRiverFilters(current.filters || {});
        var oldFilterContext = buildFilterContext(oldFilters);
        var nextFilterContext = buildFilterContext(nextFilters);
        var oldVisible = current.ids.filter(function (id) {
          return !!gameMap[id] && gameMatchesFilters(gameMap[id], oldFilters, oldFilterContext);
        });
        var oldVisibleSet = new Set(oldVisible);
        var added = current.ids.filter(function (id) {
          return !oldVisibleSet.has(id) && !!gameMap[id] && gameMatchesFilters(gameMap[id], nextFilters, nextFilterContext);
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
      if (searchLike && current && current.id === "default") {
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
      if (el.mobileHub) el.mobileHub.setAttribute("aria-expanded", "false");
    }

    function openFilters() {
      el.filters.classList.add("open");
      el.backdrop.hidden = false;
      if (el.mobileHub) el.mobileHub.setAttribute("aria-expanded", "true");
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
    el.settingsButton.addEventListener("click", openSettings);
    el.mobileSearchForm.addEventListener("submit", function (event) { event.preventDefault(); state.q = el.mobileSearchInput.value.trim(); refreshSearchQuery(); closeFilters(); });
    el.mobileSearchInput.addEventListener("input", debounce(function () { state.q = el.mobileSearchInput.value.trim(); refreshSearchQuery(); }, 120));
    el.mobileSettings.addEventListener("click", function () { closeFilters(); openSettings(); });
    el.settingsClose.addEventListener("click", closeSettings);
    el.settingsBackdrop.addEventListener("click", function (event) { if (event.target === el.settingsBackdrop) closeSettings(); });
    el.settingsBackdrop.addEventListener("change", function (event) {
      var target = event.target;
      if (target.name === "settingsNameMode") {
        portalSettings.displayTraditionalNames = target.value === "traditional";
        savePortalSettings();
        render();
        renderSettingsPanel();
      } else if (target.name === "settingsDetailLayout") {
        portalSettings.detailLayout = target.value === "separated" ? "separated" : "interleaved";
        savePortalSettings();
        if (state.detailId) rerenderDetailAtCurrentScroll(); else render();
        renderSettingsPanel();
      } else if (target === el.settingsHideSpoilers) {
        portalSettings.hideNegative = target.checked;
        pageSpoilersHidden = portalSettings.hideNegative;
        savePortalSettings();
        if (state.detailId) rerenderDetailAtCurrentScroll();
      } else if (target === el.settingsAdultEnabled) {
        portalSettings.adultEnabled = target.checked;
        savePortalSettings();
        settingsVisibilityChanged(target.checked ? "成人內容已顯示" : "成人內容已隱藏");
      }
    });
    el.settingsCaptureExplore.addEventListener("click", captureExploreDefaults);
    el.settingsClearExplore.addEventListener("click", clearExploreDefaults);
    el.settingsBlacklistAdd.addEventListener("click", function () { addBlacklistTag(el.settingsBlacklistSelect.value); });
    el.settingsBlacklistList.addEventListener("click", function (event) {
      var button = event.target.closest("[data-remove-blacklist]");
      if (button) removeBlacklistTag(button.getAttribute("data-remove-blacklist"));
    });
    el.settingsClearRead.addEventListener("click", function () { el.settingsClearReadConfirm.hidden = false; });
    el.settingsClearReadCancel.addEventListener("click", function () { el.settingsClearReadConfirm.hidden = true; });
    el.settingsClearReadApply.addEventListener("click", clearReadHistory);
    el.settingsListSelect.addEventListener("change", function () {
      settingsSelectedListId = el.settingsListSelect.value;
      settingsListItemQuery = "";
      settingsListVisibleCount = LIST_EDITOR_PAGE_SIZE;
      renderListManager();
    });
    el.settingsListItemSearch.addEventListener("input", function () {
      settingsListItemQuery = el.settingsListItemSearch.value || "";
      settingsListVisibleCount = LIST_EDITOR_PAGE_SIZE;
      renderListManager();
    });
    el.settingsCreateList.addEventListener("click", createList);
    el.settingsSaveList.addEventListener("click", saveSelectedListSettings);
    el.settingsDeleteList.addEventListener("click", deleteSelectedList);
    el.settingsImportList.addEventListener("click", importTextIntoSelectedList);
    el.settingsListItems.addEventListener("click", function (event) {
      var loadMore = event.target.closest("[data-list-load-more]");
      if (loadMore) {
        settingsListVisibleCount += LIST_EDITOR_PAGE_SIZE;
        renderListManager();
        return;
      }
      var up = event.target.closest("[data-list-move-up]");
      if (up) { moveSelectedListItem(up.getAttribute("data-list-move-up"), -1); return; }
      var down = event.target.closest("[data-list-move-down]");
      if (down) { moveSelectedListItem(down.getAttribute("data-list-move-down"), 1); return; }
      var copy = event.target.closest("[data-list-copy-item]");
      if (copy && !copy.disabled) { copyOrMoveSelectedListItem(copy.getAttribute("data-list-copy-item"), false); return; }
      var move = event.target.closest("[data-list-move-item]");
      if (move && !move.disabled) { copyOrMoveSelectedListItem(move.getAttribute("data-list-move-item"), true); return; }
      var remove = event.target.closest("[data-list-remove-item]");
      if (remove) { removeSelectedListItem(remove.getAttribute("data-list-remove-item")); }
    });
    el.settingsOwnedMhtml.addEventListener("change", function () { importOwnedMhtml(el.settingsOwnedMhtml.files && el.settingsOwnedMhtml.files[0]); el.settingsOwnedMhtml.value = ""; });
    el.settingsSteamId64.addEventListener("input", updateWishlistApiLink);
    el.settingsBuildWishlistUrl.addEventListener("click", function () {
      updateWishlistApiLink();
      if (!settingsOwnedImportSteamId) setManualImportStatus("請先輸入有效的 SteamID64", true);
    });
    el.settingsImportWishlistJson.addEventListener("click", importWishlistJsonText);
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
    el.exportVisibleListButton.addEventListener("click", exportVisibleGameList);
    el.exportStateButton.addEventListener("click", exportPortalState);
    el.importStateButton.addEventListener("click", function () { el.importStateFile.click(); });
    el.importStateFile.addEventListener("change", function () { importStateFile(el.importStateFile.files && el.importStateFile.files[0]); });
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
      var editButton = event.target.closest("[data-edit-list]");
      if (editButton) {
        event.preventDefault();
        event.stopPropagation();
        settingsSelectedListId = editButton.getAttribute("data-edit-list") || "";
        openSettings();
        return;
      }
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
        openRiver(riverId, isListRiver(rivers.find(function (river) { return river.id === riverId; })));
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
    function renderResultsPreservingMobileCard(id) {
      var selector = '[data-mobile-game-card="' + String(id || "") + '"]';
      var beforeCard = el.gameList.querySelector(selector);
      var beforeTop = beforeCard ? beforeCard.getBoundingClientRect().top : null;
      renderResults();
      if (beforeTop === null) return;
      var afterCard = el.gameList.querySelector(selector);
      if (!afterCard) return;
      var delta = afterCard.getBoundingClientRect().top - beforeTop;
      if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
    }

    function toggleMobileEssay(id) {
      id = String(id || "");
      var game = gameMap[id];
      if (!game) return;
      if (expandedMobileGameIds.has(id)) {
        expandedMobileGameIds.delete(id);
        renderResultsPreservingMobileCard(id);
        return;
      }
      expandedMobileGameIds.add(id);
      markGameRead(id);
      renderResultsPreservingMobileCard(id);
      if (game.detailStatus === "ready" || game.detailStatus === "loading") return;
      loadGameDetail(game, false).then(function () {
        if (expandedMobileGameIds.has(id)) renderResultsPreservingMobileCard(id);
      }).catch(function () {
        if (expandedMobileGameIds.has(id)) renderResultsPreservingMobileCard(id);
      });
    }

    function delegatedClick(event) {
      var mobileEssayToggle = event.target.closest("[data-mobile-essay-toggle]");
      if (mobileEssayToggle) {
        event.preventDefault();
        event.stopPropagation();
        toggleMobileEssay(mobileEssayToggle.getAttribute("data-mobile-essay-toggle"));
        return;
      }
      var retryMobileDetail = event.target.closest("[data-retry-mobile-detail]");
      if (retryMobileDetail) {
        event.preventDefault();
        var retryMobileGame = gameMap[retryMobileDetail.getAttribute("data-retry-mobile-detail") || ""];
        if (retryMobileGame) loadGameDetail(retryMobileGame, true).then(function () { renderResultsPreservingMobileCard(retryMobileGame.appid); }).catch(function () { renderResultsPreservingMobileCard(retryMobileGame.appid); });
        return;
      }
      var retryDetail = event.target.closest("[data-retry-detail]");
      if (retryDetail) {
        event.preventDefault();
        var retryGame = gameMap[retryDetail.getAttribute("data-retry-detail") || ""];
        if (retryGame) {
          var retryRequest = loadGameDetail(retryGame, true);
          renderDetailStatus(retryGame);
          retryRequest.catch(function () {});
        }
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
    el.mobileFilter.addEventListener("click", openFilters);
    el.mobileHub.addEventListener("click", function () { if (el.filters.classList.contains("open")) closeFilters(); else openFilters(); });
    el.mobileDrawerClose.addEventListener("click", closeFilters);
    el.mobileRiverList.addEventListener("click", function (event) {
      var openButton = event.target.closest("[data-open-river]");
      if (!openButton || openButton.disabled) return;
      event.preventDefault();
      var riverId = openButton.getAttribute("data-open-river");
      openRiver(riverId, isListRiver(rivers.find(function (river) { return river.id === riverId; })));
      closeFilters();
    });
    el.backdrop.addEventListener("click", closeFilters);
    window.addEventListener("popstate", function () {
      state = readUrlState();
      pendingRiverSourceIds = null;
      render();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        if (!el.settingsBackdrop.hidden) {
          event.preventDefault();
          closeSettings();
          return;
        }
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
      if (!el.settingsBackdrop.hidden) return;
      if (event.target && ["INPUT", "TEXTAREA", "SELECT"].indexOf(event.target.tagName) >= 0) return;
      if (event.key === "m" || event.key === "M") {
        event.preventDefault();
        toggleMobilePreview();
        return;
      }
      if (state.detailId && (event.key === "b" || event.key === "B")) {
        event.preventDefault();
        togglePageSpoilers();
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        if (state.detailId) toggleDetailLayout(); else el.searchInput.focus();
        return;
      }
      if (state.detailId && (event.key === "f" || event.key === "F" || event.code === "ControlRight")) {
        event.preventDefault();
        toggleFavorite(state.detailId);
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

    window.addEventListener("resize", function () {
      var nextMobileLayout = isMobileLayout();
      if (nextMobileLayout === lastMobileLayout) return;
      syncMobileLayoutClass();
      if (portalReady) render();
    });
    initializePortalState();
  }());
