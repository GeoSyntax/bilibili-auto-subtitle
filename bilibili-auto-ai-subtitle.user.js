// ==UserScript==
// @name         B站自动打开ai字幕
// @namespace    https://www.bilibili.com/
// @version      0.1.0
// @description  Auto enable AI subtitles on Bilibili video pages when available.
// @author       Claude Code
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_TAG = "[BiliAI字幕]";
  const STORAGE_KEY_ENABLED = "bili-auto-ai-subtitle:enabled";
  const STORAGE_KEY_PANEL_VISIBLE = "bili-auto-ai-subtitle:panel-visible";
  const STORAGE_KEY_TOGGLE_SHORTCUT = "bili-auto-ai-subtitle:shortcut-toggle";
  const STORAGE_KEY_PANEL_SHORTCUT = "bili-auto-ai-subtitle:shortcut-panel";
  const MAX_PLAYER_WAIT_ATTEMPTS = 10;
  const MAX_ENABLE_ATTEMPTS = 3;
  const AUTO_POLL_INTERVAL_MS = 200;
  const AUTO_POLL_CLICK_GAP_MS = 1200;
  const PROCESS_BACKOFF_MS = [
    250, 500, 900, 1400, 2000, 2800, 3600, 4500, 5500, 7000,
  ];
  const PLAYER_SELECTORS = [
    ".bpx-player-container",
    ".bilibili-player",
    "#bilibili-player",
    "video",
  ];
  const SUBTITLE_BUTTON_SELECTORS = [
    ".bpx-player-ctrl-subtitle",
    ".bpx-player-ctrl-btn-subtitle",
    ".bilibili-player-video-btn-subtitle",
    ".bilibili-player-video-subtitle-btn",
    '[class*="subtitle"]',
    '[data-tooltip*="字幕"]',
    'button[aria-label*="字幕"]',
  ];
  const SUBTITLE_ACTIVE_SELECTORS = [
    ".bpx-player-ctrl-subtitle.active",
    ".bpx-player-ctrl-subtitle.bpx-state-active",
    ".bpx-player-ctrl-btn-subtitle.active",
    ".bpx-player-ctrl-btn-subtitle.bpx-state-active",
    ".bilibili-player-video-btn-subtitle.video-state-on",
    ".bilibili-player-video-btn-subtitle.active",
    ".bilibili-player-video-subtitle-btn.video-state-on",
    ".bpx-player-subtitle-wrap .bpx-player-subtitle-item",
    ".bilibili-player-video-subtitle .subtitle-item",
  ];
  const AI_TEXT_PATTERN =
    /(AI字幕|AI 字幕|自动生成|自动字幕|机器生成|智能字幕)/i;
  const AI_SUBTITLE_ITEM_SELECTORS = [
    'div[data-lan="ai-zh"]',
    '[data-lan="ai-zh"]',
    '[data-value="ai-zh"]',
    '[class*="subtitle"] [data-lan*="ai"]',
  ];
  const SUBTITLE_CLOSE_SWITCH_SELECTORS = [
    ".bpx-player-ctrl-subtitle-close-switch",
    '.bpx-player-subtitle-panel [class*="close-switch"]',
  ];

  let lastUrl = location.href;
  let routeCheckTimer = null;
  let processToken = 0;
  let currentIdentityKey = "";
  let currentIdentityState = null;
  let observer = null;
  let controlRoot = null;
  let toastRoot = null;
  let toastTimer = null;
  let identityWatchTimer = null;
  let autoPollTimer = null;
  let lastIdentityKey = "";
  let lastAutoClickAt = 0;

  function log(...args) {
    console.log(SCRIPT_TAG, ...args);
  }

  function getFeatureEnabled() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_ENABLED);
      return saved === null ? true : saved === "true";
    } catch (error) {
      log("读取启用状态失败，使用默认值", error);
      return true;
    }
  }

  function setFeatureEnabled(enabled) {
    try {
      localStorage.setItem(STORAGE_KEY_ENABLED, String(Boolean(enabled)));
    } catch (error) {
      log("保存启用状态失败", error);
    }
  }

  function getPanelVisible() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_PANEL_VISIBLE);
      return saved === null ? true : saved === "true";
    } catch (error) {
      log("读取面板状态失败，使用默认值", error);
      return true;
    }
  }

  function setPanelVisible(visible) {
    try {
      localStorage.setItem(STORAGE_KEY_PANEL_VISIBLE, String(Boolean(visible)));
    } catch (error) {
      log("保存面板状态失败", error);
    }
  }

  function ensureToastMounted() {
    if (toastRoot?.isConnected) return;
    if (!document.body) {
      window.setTimeout(ensureToastMounted, 100);
      return;
    }

    toastRoot = document.createElement("div");
    toastRoot.style.position = "fixed";
    toastRoot.style.right = "18px";
    toastRoot.style.bottom = "70px";
    toastRoot.style.zIndex = "2147483647";
    toastRoot.style.maxWidth = "280px";
    toastRoot.style.padding = "10px 12px";
    toastRoot.style.borderRadius = "12px";
    toastRoot.style.background = "rgba(24, 24, 28, 0.9)";
    toastRoot.style.color = "#fff";
    toastRoot.style.fontSize = "13px";
    toastRoot.style.lineHeight = "1.45";
    toastRoot.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.22)";
    toastRoot.style.opacity = "0";
    toastRoot.style.pointerEvents = "none";
    toastRoot.style.transform = "translateY(8px)";
    toastRoot.style.transition = "opacity 0.35s ease, transform 0.35s ease";
    document.body.appendChild(toastRoot);
  }

  function showToast(message) {
    ensureToastMounted();
    if (!toastRoot) return;

    if (toastTimer) {
      window.clearTimeout(toastTimer);
    }

    toastRoot.textContent = message;
    toastRoot.style.opacity = "1";
    toastRoot.style.transform = "translateY(0)";

    toastTimer = window.setTimeout(() => {
      if (!toastRoot) return;
      toastRoot.style.opacity = "0";
      toastRoot.style.transform = "translateY(8px)";
    }, 2200);
  }

  function normalizeShortcut(input) {
    if (!input) return "";

    const rawParts = String(input)
      .split("+")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);

    if (!rawParts.length) return "";

    const modifiers = [];
    let key = "";

    for (const part of rawParts) {
      if (part === "ctrl" || part === "control") {
        if (!modifiers.includes("Ctrl")) modifiers.push("Ctrl");
        continue;
      }
      if (part === "alt" || part === "option") {
        if (!modifiers.includes("Alt")) modifiers.push("Alt");
        continue;
      }
      if (part === "shift") {
        if (!modifiers.includes("Shift")) modifiers.push("Shift");
        continue;
      }
      if (
        part === "meta" ||
        part === "cmd" ||
        part === "command" ||
        part === "win"
      ) {
        if (!modifiers.includes("Meta")) modifiers.push("Meta");
        continue;
      }

      key = part.length === 1 ? part.toUpperCase() : part;
    }

    if (!key) return "";

    return [...modifiers, key].join("+");
  }

  function getShortcut(storageKey, fallback) {
    try {
      const saved = localStorage.getItem(storageKey);
      const normalized = normalizeShortcut(saved || fallback);
      return normalized || fallback;
    } catch (error) {
      log("读取快捷键失败，使用默认值", error);
      return fallback;
    }
  }

  function setShortcut(storageKey, value) {
    const normalized = normalizeShortcut(value);
    if (!normalized) return "";

    try {
      localStorage.setItem(storageKey, normalized);
    } catch (error) {
      log("保存快捷键失败", error);
    }

    return normalized;
  }

  function parseShortcut(shortcut) {
    const normalized = normalizeShortcut(shortcut);
    const parts = normalized ? normalized.split("+") : [];
    const key = parts.pop() || "";

    return {
      raw: normalized,
      key: key.toLowerCase(),
      altKey: parts.includes("Alt"),
      ctrlKey: parts.includes("Ctrl"),
      shiftKey: parts.includes("Shift"),
      metaKey: parts.includes("Meta"),
    };
  }

  function matchesShortcut(event, shortcut) {
    const parsed = parseShortcut(shortcut);
    if (!parsed.key) return false;

    return (
      event.key.toLowerCase() === parsed.key &&
      event.altKey === parsed.altKey &&
      event.ctrlKey === parsed.ctrlKey &&
      event.shiftKey === parsed.shiftKey &&
      event.metaKey === parsed.metaKey
    );
  }

  function configureShortcut(label, storageKey, fallback) {
    const current = getShortcut(storageKey, fallback);
    const nextValue = window.prompt(
      `请输入 ${label} 快捷键，例如 Alt+A`,
      current,
    );
    if (nextValue === null) return;

    const normalized = setShortcut(storageKey, nextValue);
    if (!normalized) {
      showToast(`${label} 快捷键无效`);
      return;
    }

    showToast(`${label} 快捷键已设为 ${normalized}`);
  }

  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== "function") return;

    GM_registerMenuCommand(
      `设置自动开关键 (${getShortcut(STORAGE_KEY_TOGGLE_SHORTCUT, "Alt+A")})`,
      () => {
        configureShortcut("自动开关", STORAGE_KEY_TOGGLE_SHORTCUT, "Alt+A");
      },
    );

    GM_registerMenuCommand(
      `设置面板显隐键 (${getShortcut(STORAGE_KEY_PANEL_SHORTCUT, "Alt+H")})`,
      () => {
        configureShortcut("面板显隐", STORAGE_KEY_PANEL_SHORTCUT, "Alt+H");
      },
    );
  }

  function isVideoPage() {
    return /^https:\/\/(www\.)?bilibili\.com\/(video\/|bangumi\/play\/)/.test(
      location.href,
    );
  }

  function getPathBvid() {
    const match = location.pathname.match(/\/(BV[0-9A-Za-z]+)/i);
    return match ? match[1] : "";
  }

  function getInitialState() {
    return window.__INITIAL_STATE__ || null;
  }

  function getPlayInfoCandidates() {
    const candidates = [];
    const initialState = getInitialState();

    if (window.__playinfo__) candidates.push(window.__playinfo__);
    if (window.__PLAYINFO__) candidates.push(window.__PLAYINFO__);
    if (window.__NEXT_PLAYINFO__) candidates.push(window.__NEXT_PLAYINFO__);
    if (initialState?.videoData) candidates.push(initialState.videoData);
    if (initialState?.epInfo) candidates.push(initialState.epInfo);
    if (initialState?.initEpList) candidates.push(initialState.initEpList);

    return candidates.filter(Boolean);
  }

  function getVideoIdentity() {
    if (!isVideoPage()) return null;

    const initialState = getInitialState();
    const videoData = initialState?.videoData || {};
    const epInfo = initialState?.epInfo || {};
    const bvid =
      videoData.bvid ||
      initialState?.bvid ||
      epInfo.bvid ||
      getPathBvid() ||
      "";

    let cid = videoData.cid || initialState?.cid || epInfo.cid || "";

    if (!cid && Array.isArray(videoData.pages)) {
      const page = Number(new URL(location.href).searchParams.get("p") || "1");
      cid = videoData.pages[page - 1]?.cid || videoData.pages[0]?.cid || "";
    }

    if (!cid) {
      const candidate = getPlayInfoCandidates().find(
        (item) => typeof item?.cid !== "undefined",
      );
      cid = candidate?.cid || "";
    }

    if (!bvid && !cid) return null;

    return {
      bvid,
      cid: String(cid || ""),
      key: `${bvid || "unknown"}:${cid || "unknown"}`,
    };
  }

  function getIdentityState(identity) {
    if (!identity) return null;

    if (!currentIdentityState || currentIdentityState.key !== identity.key) {
      currentIdentityState = {
        key: identity.key,
        hasAttemptedEnable: false,
        userIntervened: false,
        lastKnownSubtitleEnabled: false,
      };
    }

    return currentIdentityState;
  }

  function resetIdentityState(identity) {
    if (!identity) return null;

    currentIdentityState = {
      key: identity.key,
      hasAttemptedEnable: false,
      userIntervened: false,
      lastKnownSubtitleEnabled: false,
    };

    return currentIdentityState;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function hasSubtitleDomVisible() {
    return SUBTITLE_ACTIVE_SELECTORS.some(
      (selector) => !!document.querySelector(selector),
    );
  }

  function getSubtitleButton() {
    const nodes = [];

    for (const selector of SUBTITLE_BUTTON_SELECTORS) {
      document.querySelectorAll(selector).forEach((node) => nodes.push(node));
    }

    return (
      nodes.find((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const text = `${node.textContent || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-tooltip") || ""}`;
        return /字幕/i.test(text);
      }) || null
    );
  }

  function getAiSubtitleItem() {
    for (const selector of AI_SUBTITLE_ITEM_SELECTORS) {
      const node = document.querySelector(selector);
      if (node instanceof HTMLElement) return node;
    }

    const textCandidates = Array.from(
      document.querySelectorAll("div, li, span, button"),
    ).filter((node) => {
      const text =
        `${node.textContent || ""} ${node.getAttribute?.("data-lan") || ""}`.trim();
      return /ai-zh/i.test(text) || /AI字幕|AI 字幕|自动生成/.test(text);
    });

    return textCandidates.find((node) => node instanceof HTMLElement) || null;
  }

  function getSubtitleCloseSwitch() {
    for (const selector of SUBTITLE_CLOSE_SWITCH_SELECTORS) {
      const node = document.querySelector(selector);
      if (node instanceof HTMLElement) return node;
    }

    return null;
  }

  function isSubtitleExplicitlyClosed() {
    const closeSwitch = getSubtitleCloseSwitch();
    return !!closeSwitch && closeSwitch.classList.contains("bpx-state-active");
  }

  function isSubtitleEnabled() {
    if (isSubtitleExplicitlyClosed()) return false;

    const button = getSubtitleButton();
    if (button) {
      const className = button.className || "";
      const ariaPressed = button.getAttribute("aria-pressed");
      const ariaChecked = button.getAttribute("aria-checked");

      if (/active|on|selected|checked|enable|opened|show/i.test(className))
        return true;
      if (ariaPressed === "true" || ariaChecked === "true") return true;
    }

    return hasSubtitleDomVisible();
  }

  function createMutationWaiter(timeoutMs = 3000) {
    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        localObserver.disconnect();
        resolve(false);
      }, timeoutMs);

      const localObserver = new MutationObserver(() => {
        if (
          PLAYER_SELECTORS.some((selector) => document.querySelector(selector))
        ) {
          window.clearTimeout(timeoutId);
          localObserver.disconnect();
          resolve(true);
        }
      });

      localObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    });
  }

  async function waitForPlayerReady(expectedKey) {
    for (let i = 0; i < MAX_PLAYER_WAIT_ATTEMPTS; i += 1) {
      if (!isVideoPage()) return false;
      const identity = getVideoIdentity();
      if (!identity || identity.key !== expectedKey) return false;

      const ready = PLAYER_SELECTORS.some((selector) =>
        document.querySelector(selector),
      );
      if (ready) return true;

      await Promise.race([
        createMutationWaiter(Math.min(1600, 500 + i * 120)),
        wait(Math.min(1800, 400 + i * 180)),
      ]);
    }

    return false;
  }

  function collectSubtitleCandidates(value, results = []) {
    if (!value || typeof value !== "object") return results;

    if (Array.isArray(value)) {
      value.forEach((item) => collectSubtitleCandidates(item, results));
      return results;
    }

    const keys = Object.keys(value);
    const looksRelevant = keys.some((key) =>
      /(subtitle|subtitles|sub_title|subTitle|captions?)/i.test(key),
    );

    if (looksRelevant) {
      results.push(value);
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        collectSubtitleCandidates(child, results);
      }
    }

    return results;
  }

  function objectHasAiSubtitle(value) {
    if (!value) return false;

    if (Array.isArray(value)) {
      return value.some((item) => objectHasAiSubtitle(item));
    }

    if (typeof value !== "object") {
      if (typeof value === "string") return AI_TEXT_PATTERN.test(value);
      return false;
    }

    const textBlob = Object.entries(value)
      .map(
        ([key, val]) =>
          `${key}:${typeof val === "string" || typeof val === "number" || typeof val === "boolean" ? String(val) : ""}`,
      )
      .join(" | ");

    if (AI_TEXT_PATTERN.test(textBlob)) return true;

    const source = String(
      value.ai_type ||
        value.aiType ||
        value.source ||
        value.subtitle_type ||
        value.type ||
        "",
    ).toLowerCase();
    if (/ai|machine|auto|intelligence/.test(source)) return true;

    const flagValues = [
      value.is_ai,
      value.isAi,
      value.ai,
      value.ai_status,
      value.aiStatus,
      value.auto_generated,
      value.autoGenerated,
      value.machine_generated,
      value.machineGenerated,
    ];

    if (
      flagValues.some(
        (flag) =>
          flag === true ||
          flag === 1 ||
          flag === "1" ||
          String(flag).toLowerCase() === "true",
      )
    ) {
      return true;
    }

    return Object.values(value).some(
      (child) =>
        child && typeof child === "object" && objectHasAiSubtitle(child),
    );
  }

  function detectAiSubtitleFromPageData() {
    const candidates = [getInitialState(), ...getPlayInfoCandidates()].filter(
      Boolean,
    );

    for (const candidate of candidates) {
      if (objectHasAiSubtitle(candidate)) {
        return { found: true, source: "page-data-direct" };
      }

      const subtitleCandidates = collectSubtitleCandidates(candidate);
      if (subtitleCandidates.some((item) => objectHasAiSubtitle(item))) {
        return { found: true, source: "page-data-subtitle-list" };
      }
    }

    return { found: false, source: "page-data" };
  }

  async function fetchJson(url) {
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  async function detectAiSubtitleFromApi(identity) {
    if (!identity?.cid) return { found: false, source: "api-no-cid" };

    const endpoints = [
      `https://api.bilibili.com/x/player/v2?cid=${encodeURIComponent(identity.cid)}&bvid=${encodeURIComponent(identity.bvid || "")}`,
      `https://api.bilibili.com/x/player/wbi/v2?cid=${encodeURIComponent(identity.cid)}&bvid=${encodeURIComponent(identity.bvid || "")}`,
      `https://api.bilibili.com/x/player.so?id=cid:${encodeURIComponent(identity.cid)}&bvid=${encodeURIComponent(identity.bvid || "")}`,
    ];

    for (const endpoint of endpoints) {
      try {
        const data = await fetchJson(endpoint);
        if (objectHasAiSubtitle(data)) {
          return { found: true, source: endpoint };
        }
      } catch (error) {
        log("接口检测失败", endpoint, error);
      }
    }

    return { found: false, source: "api" };
  }

  function detectAiSubtitleFromDom() {
    const candidates = [
      ...document.querySelectorAll(
        '[class*="subtitle"], [class*="caption"], [data-tooltip], button, span, div, li',
      ),
    ];

    const hit = candidates.find((node) => {
      const text =
        `${node.textContent || ""} ${node.getAttribute?.("data-tooltip") || ""} ${node.getAttribute?.("aria-label") || ""}`.trim();
      return AI_TEXT_PATTERN.test(text);
    });

    return { found: !!hit, source: hit ? "dom" : "dom-none" };
  }

  async function detectAiSubtitle(identity) {
    const fromPage = detectAiSubtitleFromPageData();
    if (fromPage.found) return fromPage;

    const fromApi = await detectAiSubtitleFromApi(identity);
    if (fromApi.found) return fromApi;

    return detectAiSubtitleFromDom();
  }

  async function enableSubtitle(identity, state) {
    if (!identity || !state) return false;
    if (state.hasAttemptedEnable) return isSubtitleEnabled();
    if (state.userIntervened) return false;

    if (isSubtitleEnabled()) {
      state.hasAttemptedEnable = true;
      state.lastKnownSubtitleEnabled = true;
      return true;
    }

    for (let attempt = 0; attempt < MAX_ENABLE_ATTEMPTS; attempt += 1) {
      if (!isVideoPage()) return false;
      const latestIdentity = getVideoIdentity();
      if (!latestIdentity || latestIdentity.key !== identity.key) return false;
      if (state.userIntervened) return false;

      const aiSubtitleItem = getAiSubtitleItem();
      if (aiSubtitleItem) {
        aiSubtitleItem.click();
        state.hasAttemptedEnable = true;
        await wait(450 + attempt * 300);

        if (isSubtitleEnabled() || !isSubtitleExplicitlyClosed()) {
          state.lastKnownSubtitleEnabled = true;
          log("已自动选中 AI 字幕", identity.key);
          return true;
        }
      }

      const button = getSubtitleButton();
      if (button) {
        button.click();
        state.hasAttemptedEnable = true;
        await wait(450 + attempt * 300);

        const retriedAiSubtitleItem = getAiSubtitleItem();
        if (retriedAiSubtitleItem) {
          retriedAiSubtitleItem.click();
          await wait(300 + attempt * 200);
        }

        if (isSubtitleEnabled() || !isSubtitleExplicitlyClosed()) {
          state.lastKnownSubtitleEnabled = true;
          log("已自动开启字幕", identity.key);
          return true;
        }
      }

      await wait(400 + attempt * 250);
    }

    return isSubtitleEnabled() || !isSubtitleExplicitlyClosed();
  }

  async function disableSubtitle() {
    for (let attempt = 0; attempt < MAX_ENABLE_ATTEMPTS; attempt += 1) {
      const closeSwitch = getSubtitleCloseSwitch();
      if (closeSwitch && !isSubtitleExplicitlyClosed()) {
        closeSwitch.click();
        await wait(250 + attempt * 150);
      }

      if (isSubtitleExplicitlyClosed() || !isSubtitleEnabled()) {
        return true;
      }

      const button = getSubtitleButton();
      if (button && isSubtitleEnabled()) {
        button.click();
        await wait(250 + attempt * 150);
      }
    }

    return isSubtitleExplicitlyClosed() || !isSubtitleEnabled();
  }

  async function processCurrentPage(reason) {
    const token = ++processToken;

    if (!isVideoPage()) return;
    if (!getFeatureEnabled()) {
      log("功能已关闭，跳过检测", reason);
      return;
    }

    const identity = getVideoIdentity();
    if (!identity) {
      log("未获取到视频标识，稍后重试", reason);
      return;
    }

    currentIdentityKey = identity.key;
    const state = getIdentityState(identity);

    const playerReady = await waitForPlayerReady(identity.key);
    if (!playerReady || token !== processToken) return;

    const latestIdentity = getVideoIdentity();
    if (!latestIdentity || latestIdentity.key !== identity.key) return;

    if (state.userIntervened) {
      log("检测到用户已手动关闭字幕，跳过自动开启", identity.key);
      return;
    }

    if (isSubtitleEnabled()) {
      state.lastKnownSubtitleEnabled = true;
      return;
    }

    const detection = await detectAiSubtitle(identity);
    if (token !== processToken) return;

    if (!detection.found) {
      log("当前视频未检测到 AI 字幕", identity.key, detection.source);
      return;
    }

    log("检测到 AI 字幕，准备自动开启", identity.key, detection.source);
    await enableSubtitle(identity, state);
  }

  function scheduleCheck(reason) {
    if (routeCheckTimer) {
      window.clearTimeout(routeCheckTimer);
    }

    const identity = getVideoIdentity();
    const delay = identity && identity.key === currentIdentityKey ? 120 : 260;

    routeCheckTimer = window.setTimeout(() => {
      processCurrentPage(reason).catch((error) => {
        log("处理页面失败", reason, error);
      });
    }, delay);
  }

  function patchHistoryMethod(methodName) {
    const original = history[methodName];
    if (typeof original !== "function" || original.__biliAiSubtitlePatched)
      return;

    const wrapped = function (...args) {
      const result = original.apply(this, args);
      window.setTimeout(() => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          scheduleCheck(`history:${methodName}`);
        }
      }, 0);
      return result;
    };

    wrapped.__biliAiSubtitlePatched = true;
    history[methodName] = wrapped;
  }

  function bindRouteListeners() {
    patchHistoryMethod("pushState");
    patchHistoryMethod("replaceState");

    window.addEventListener("popstate", () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
      }
      ensureControlMounted();
      scheduleCheck("popstate");
    });
  }

  function startIdentityWatch() {
    if (identityWatchTimer) window.clearInterval(identityWatchTimer);

    identityWatchTimer = window.setInterval(() => {
      if (!isVideoPage()) return;
      const identity = getVideoIdentity();
      const key = identity?.key || "";
      if (!key || key === lastIdentityKey) return;

      lastIdentityKey = key;
      resetIdentityState(identity);
      currentIdentityKey = key;
      scheduleCheck("identity-change");
    }, 800);
  }

  function startAutoPoll() {
    if (autoPollTimer) window.clearInterval(autoPollTimer);

    autoPollTimer = window.setInterval(() => {
      if (!isVideoPage()) return;
      if (!getFeatureEnabled()) return;

      const aiSubtitleItem = getAiSubtitleItem();
      const closeSwitch = getSubtitleCloseSwitch();
      if (!aiSubtitleItem || !closeSwitch) return;

      const now = Date.now();
      if (now - lastAutoClickAt < AUTO_POLL_CLICK_GAP_MS) return;

      const explicitlyClosed = closeSwitch.classList.contains("bpx-state-active");
      if (explicitlyClosed) {
        aiSubtitleItem.click();
        lastAutoClickAt = now;
        const identity = getVideoIdentity();
        if (identity) {
          const state = getIdentityState(identity);
          if (state) state.lastKnownSubtitleEnabled = true;
        }
      }
    }, AUTO_POLL_INTERVAL_MS);
  }

  function bindUserInterventionListener() {
    document.addEventListener(
      "click",
      (event) => {
        if (!event.isTrusted) return;

        const target = event.target;
        if (!(target instanceof Element)) return;

        const button = target.closest(SUBTITLE_BUTTON_SELECTORS.join(","));
        if (!button) return;

        const identity = getVideoIdentity();
        const state = getIdentityState(identity);
        if (!state || !state.hasAttemptedEnable) return;

        window.setTimeout(() => {
          const enabled = isSubtitleEnabled();
          if (!enabled) {
            state.userIntervened = true;
            state.lastKnownSubtitleEnabled = false;
            log("检测到用户手动关闭字幕，后续不再强制开启", state.key);
          }
        }, 150);
      },
      true,
    );
  }

  function bindDomObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver(() => {
      const identity = getVideoIdentity();
      if (!identity) return;
      const state = getIdentityState(identity);
      if (!state || state.hasAttemptedEnable || state.userIntervened) return;

      scheduleCheck("dom-mutation");
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function updateControlView() {
    if (!controlRoot) return;

    const enabled = getFeatureEnabled();
    const visible = getPanelVisible();
    const label = controlRoot.querySelector('[data-role="label"]');
    const toggleShortcut = getShortcut(STORAGE_KEY_TOGGLE_SHORTCUT, "Alt+A");

    controlRoot.style.display = visible ? "flex" : "none";
    controlRoot.style.background = enabled
      ? "rgba(0, 161, 214, 0.92)"
      : "rgba(96, 96, 96, 0.92)";
    controlRoot.style.borderColor = enabled
      ? "rgba(255, 255, 255, 0.28)"
      : "rgba(255, 255, 255, 0.18)";

    if (label) {
      label.textContent = enabled
        ? `AI字幕自动开：开（${toggleShortcut}）`
        : `AI字幕自动开：关（${toggleShortcut}）`;
    }
  }

  function toggleFeature(enabled) {
    setFeatureEnabled(enabled);
    updateControlView();

    const toggleShortcut = getShortcut(STORAGE_KEY_TOGGLE_SHORTCUT, "Alt+A");
    showToast(
      enabled
        ? `已开启自动字幕（${toggleShortcut}）`
        : `已关闭自动字幕（${toggleShortcut}）`,
    );

    const identity = getVideoIdentity();

    if (enabled) {
      if (identity) {
        resetIdentityState(identity);
        currentIdentityKey = identity.key;
      }
      scheduleCheck("manual-enable");
    } else {
      processToken += 1;
      if (identity) {
        const state = getIdentityState(identity);
        if (state) {
          state.userIntervened = true;
          state.hasAttemptedEnable = false;
          state.lastKnownSubtitleEnabled = false;
        }
      }
      disableSubtitle().catch((error) => {
        log("关闭当前字幕失败", error);
      });
    }
  }

  function createControl() {
    if (controlRoot?.isConnected) {
      updateControlView();
      return;
    }

    controlRoot = document.createElement("div");
    controlRoot.style.position = "fixed";
    controlRoot.style.right = "18px";
    controlRoot.style.bottom = "18px";
    controlRoot.style.zIndex = "2147483647";
    controlRoot.style.display = "flex";
    controlRoot.style.alignItems = "center";
    controlRoot.style.gap = "8px";
    controlRoot.style.padding = "8px 10px";
    controlRoot.style.border = "1px solid rgba(255, 255, 255, 0.28)";
    controlRoot.style.borderRadius = "999px";
    controlRoot.style.color = "#fff";
    controlRoot.style.fontSize = "13px";
    controlRoot.style.lineHeight = "1";
    controlRoot.style.boxShadow = "0 6px 18px rgba(0, 0, 0, 0.18)";
    controlRoot.style.backdropFilter = "blur(8px)";
    controlRoot.style.webkitBackdropFilter = "blur(8px)";
    controlRoot.style.userSelect = "none";

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.setAttribute("data-role", "toggle");
    toggleButton.style.border = "none";
    toggleButton.style.background = "transparent";
    toggleButton.style.color = "inherit";
    toggleButton.style.cursor = "pointer";
    toggleButton.style.padding = "0";
    toggleButton.style.font = "inherit";

    const label = document.createElement("span");
    label.setAttribute("data-role", "label");
    toggleButton.appendChild(label);

    const hideButton = document.createElement("button");
    hideButton.type = "button";
    hideButton.title = "隐藏面板";
    hideButton.textContent = "×";
    hideButton.style.border = "none";
    hideButton.style.background = "rgba(255, 255, 255, 0.16)";
    hideButton.style.color = "inherit";
    hideButton.style.cursor = "pointer";
    hideButton.style.width = "20px";
    hideButton.style.height = "20px";
    hideButton.style.borderRadius = "50%";
    hideButton.style.padding = "0";
    hideButton.style.font = "inherit";
    hideButton.style.lineHeight = "20px";

    toggleButton.addEventListener("click", () => {
      toggleFeature(!getFeatureEnabled());
    });

    hideButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setPanelVisible(false);
      updateControlView();
      const panelShortcut = getShortcut(STORAGE_KEY_PANEL_SHORTCUT, "Alt+H");
      showToast(`面板已隐藏（${panelShortcut} 可重新显示）`);
    });

    controlRoot.appendChild(toggleButton);
    controlRoot.appendChild(hideButton);

    updateControlView();
    document.body.appendChild(controlRoot);
  }

  function ensureControlMounted() {
    if (!document.body) {
      window.setTimeout(ensureControlMounted, 100);
      return;
    }

    createControl();
  }

  function bindHotkeys() {
    document.addEventListener(
      "keydown",
      (event) => {
        const target = event.target;
        const isEditable =
          target instanceof HTMLElement &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable);

        if (isEditable) return;

        const toggleShortcut = getShortcut(
          STORAGE_KEY_TOGGLE_SHORTCUT,
          "Alt+A",
        );
        const panelShortcut = getShortcut(STORAGE_KEY_PANEL_SHORTCUT, "Alt+H");

        if (matchesShortcut(event, toggleShortcut)) {
          event.preventDefault();
          toggleFeature(!getFeatureEnabled());
          return;
        }

        if (matchesShortcut(event, panelShortcut)) {
          event.preventDefault();
          const nextVisible = !getPanelVisible();
          setPanelVisible(nextVisible);
          updateControlView();
          showToast(
            nextVisible
              ? `面板已显示（${panelShortcut}）`
              : `面板已隐藏（${panelShortcut}）`,
          );
        }
      },
      true,
    );
  }

  function bootstrap() {
    bindRouteListeners();
    bindUserInterventionListener();
    bindDomObserver();
    bindHotkeys();
    registerMenuCommands();
    ensureControlMounted();
    startIdentityWatch();
    startAutoPoll();
    scheduleCheck("init");

    PROCESS_BACKOFF_MS.forEach((delay, index) => {
      window.setTimeout(() => {
        const identity = getVideoIdentity();
        if (!identity) return;
        const state = getIdentityState(identity);
        if (
          state?.hasAttemptedEnable ||
          state?.userIntervened ||
          isSubtitleEnabled()
        )
          return;
        scheduleCheck(`bootstrap-retry-${index + 1}`);
      }, delay);
    });
  }

  bootstrap();
})();
