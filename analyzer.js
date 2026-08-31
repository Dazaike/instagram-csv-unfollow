// Integrated Instagram Follower Analyzer for review.html.
// The original userscript sections are refactored into this extension-page module:
// CONFIG, Utils, Storage, Icons, UI, API, App, and tour helper functions are retained
// while rendering into the existing review.html analyzer workspace instead of an Instagram floating panel.
(function () {
  "use strict";

  const d = new Set();
  const importCSS = async (cssText) => {
    if (d.has(cssText)) return;
    d.add(cssText);
    GM_addStyle(cssText);
  };

  const CONFIG = {
    STORAGE_KEY: "ig_snapshot_v2",
    POSITION_KEY: "ig_panel_position_v2",
    WHITELIST_KEY: "ig_whitelist_v2",
    HISTORY_KEY: "ig_history_v2",
    HISTORY_SNAPSHOTS_KEY: "ig_history_snapshots_v1",
    HISTORY_SNAPSHOT_LIMIT: 14,
    CHURN_KEY: "ig_churn_v3",
    DEACTIVATED_KEY: "ig_deactivated_v3",
    BLOCKED_KEY: "ig_blocked_v1",
    TOUR_KEY: "ig_tour_completed_v1",
    RENAMED_KEY: "ig_renamed_v1",
    FOLLOWING_HASH: "d04b0a864b4b54837c0d870b0e77e076",
    FOLLOWERS_HASH: "c76146de99bb02f6415203be841dd25a",
    PAGE_SIZE: 50,
    BASE_RATE_LIMIT_MS: 1500,
    MAX_RETRIES: 4,
    DEBUG: false,
    MIN_VISIBLE_PX: 50,
    DEFAULT_POSITION: { top: 80, right: 20 }
  };

  const Utils = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => (new Date()).toISOString(),
    log: (msg) => console.log(`[IG Analyzer] ${msg}`),
    logError: (msg, err) => {
      console.error(`[IG Analyzer Error] ${msg}`, err);
      UI.log(`${msg}${err?.message ? `: ${err.message}` : ""}`);
    },
    getUserId: async () => {
      const response = await chrome.runtime.sendMessage({ type: "GET_SESSION_STATUS" });
      return response?.viewerId || null;
    },
    diff: (a, b) => {
      const setB = new Set(b);
      return a.filter((item) => !setB.has(item));
    },
    intersection: (a, b) => {
      const setB = new Set(b);
      return a.filter((item) => setB.has(item));
    },
    unique: (arr) => [...new Set(arr)],
    toDetailedUserArray: (arr) => {
      if (!Array.isArray(arr)) return [];
      return arr.map((user) => {
        if (typeof user === "string") return { id: null, username: user };
        if (user && typeof user.username === "string") {
          return {
            id: user.id ? String(user.id) : null,
            username: String(user.username),
            fullName: user.fullName || user.full_name || "",
            profilePicUrl: user.profilePicUrl || user.profile_pic_url || ""
          };
        }
        return null;
      }).filter(Boolean);
    },
    mapById: (arr) => {
      const map = new Map();
      (arr || []).forEach((user) => {
        if (user?.id) map.set(String(user.id), user);
      });
      return map;
    },
    intersectionById: (a, b) => {
      const bIds = new Set((b || []).map((item) => item?.id).filter(Boolean));
      return (a || []).filter((item) => item?.id && bIds.has(item.id));
    },
    compactUserRecord: (user) => {
      if (!user?.username) return null;
      return {
        id: user.id ? String(user.id) : null,
        username: String(user.username)
      };
    },
    compactUserRecords: (arr) => (arr || []).map(Utils.compactUserRecord).filter(Boolean),
    compactHistorySnapshot: (snapshot) => {
      if (!snapshot || typeof snapshot !== "object") return null;
      const mapUsernames = (arr) => (arr || []).map((entry) => {
        if (typeof entry === "string") return entry;
        return entry?.username || null;
      }).filter(Boolean);
      return {
        version: 2,
        savedAt: snapshot.savedAt || Utils.now(),
        notFollowingBack: mapUsernames(snapshot.notFollowingBackDetailed || snapshot.notFollowingBack || []),
        fans: mapUsernames(snapshot.fansDetailed || snapshot.fans || []),
        mutuals: mapUsernames(snapshot.mutualsDetailed || snapshot.mutuals || [])
      };
    },
    sortSnapshotDates: (dates) => [...dates].sort((a, b) => new Date(a).getTime() - new Date(b).getTime()),
    trimHistorySnapshots: (snapshots, limit = CONFIG.HISTORY_SNAPSHOT_LIMIT) => {
      const normalized = {};
      Object.entries(snapshots || {}).forEach(([date, snapshot]) => {
        const compact = Utils.compactHistorySnapshot(snapshot);
        if (compact) normalized[date] = compact;
      });
      const dates = Utils.sortSnapshotDates(Object.keys(normalized));
      while (dates.length > limit) {
        delete normalized[dates.shift()];
      }
      return normalized;
    },
    detectRenamedMutuals: (prevMutuals, currentMutuals) => {
      const prevById = Utils.mapById(prevMutuals);
      const currById = Utils.mapById(currentMutuals);
      const changes = [];
      prevById.forEach((prevUser, id) => {
        const currUser = currById.get(id);
        if (!currUser) return;
        if (prevUser.username !== currUser.username) {
          changes.push({
            id,
            oldUsername: prevUser.username,
            newUsername: currUser.username
          });
        }
      });
      return changes;
    },
    exportCSV: (data, filename) => {
      if (!data || !data.length) return;
      const csvContent = "Username,Profile URL\n" + data.map((user) => `${user.username},${user.url}`).join("\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.setAttribute("download", filename);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    }
  };

  const Storage = {
    load: () => {
      try {
        const snap = GM_getValue(CONFIG.STORAGE_KEY, null);
        const hasLegacyFollowers = Array.isArray(snap?.followers) || Array.isArray(snap?.following);
        const hasCompactFollowers = Array.isArray(snap?.followersDetailed) || Array.isArray(snap?.followingDetailed);
        return snap && (hasLegacyFollowers || hasCompactFollowers) ? snap : null;
      } catch (error) {
        Utils.logError("Error loading snapshot", error);
        return null;
      }
    },
    save: (data) => {
      const payload = {
        version: 5,
        lastRun: data?.lastRun || Utils.now(),
        followersDetailed: Utils.compactUserRecords(data?.followersDetailed || data?.followers || []),
        followingDetailed: Utils.compactUserRecords(data?.followingDetailed || data?.following || [])
      };
      try {
        GM_setValue(CONFIG.STORAGE_KEY, payload);
      } catch (_error) {
        const snapshots = Utils.trimHistorySnapshots(Storage.getHistorySnapshots(), 1);
        GM_setValue(CONFIG.HISTORY_SNAPSHOTS_KEY, snapshots);
        GM_setValue(CONFIG.STORAGE_KEY, payload);
      }
    },
    getWhitelist: () => GM_getValue(CONFIG.WHITELIST_KEY, []),
    addToWhitelist: (username) => {
      const whitelist = Storage.getWhitelist();
      if (!whitelist.includes(username)) {
        whitelist.push(username);
        GM_setValue(CONFIG.WHITELIST_KEY, whitelist);
      }
      addSharedExclusion(username);
    },
    getHistory: () => GM_getValue(CONFIG.HISTORY_KEY, []),
    addHistoryEntry: (followersCount, followingCount) => {
      const history = Storage.getHistory();
      const dateStr = Utils.now().split("T")[0];
      const existingIdx = history.findIndex((entry) => entry.date === dateStr);
      if (existingIdx > -1) {
        history[existingIdx] = { date: dateStr, followers: followersCount, following: followingCount };
      } else {
        history.push({ date: dateStr, followers: followersCount, following: followingCount });
      }
      GM_setValue(CONFIG.HISTORY_KEY, history);
    },
    getHistorySnapshots: () => Utils.trimHistorySnapshots(GM_getValue(CONFIG.HISTORY_SNAPSHOTS_KEY, {})),
    getHistorySnapshot: (date) => {
      const snapshots = Storage.getHistorySnapshots();
      return snapshots?.[date] || null;
    },
    saveHistorySnapshot: (date, snapshot) => {
      const compactSnapshot = Utils.compactHistorySnapshot(snapshot);
      if (!compactSnapshot) return;
      let snapshots = Storage.getHistorySnapshots();
      snapshots[date] = compactSnapshot;
      snapshots = Utils.trimHistorySnapshots(snapshots);
      const persist = (value) => {
        GM_setValue(CONFIG.HISTORY_SNAPSHOTS_KEY, value);
      };
      try {
        persist(snapshots);
      } catch (error) {
        Utils.log(`History storage is full. Pruning older analyzer snapshots and retrying.`);
        const dates = Utils.sortSnapshotDates(Object.keys(snapshots));
        while (dates.length > 1) {
          delete snapshots[dates.shift()];
          try {
            persist(snapshots);
            return;
          } catch (_retryError) {
            // Keep pruning until the latest snapshot fits.
          }
        }
        persist({ [date]: compactSnapshot });
      }
    },
    getNominalList: (key) => GM_getValue(key, []),
    addNominalEntries: (key, usernames) => {
      if (!usernames || usernames.length === 0) return;
      const list = Storage.getNominalList(key);
      const dateStr = Utils.now().split("T")[0];
      usernames.forEach((username) => {
        if (!list.find((entry) => entry.username === username)) {
          list.push({ username, date: dateStr });
        }
      });
      GM_setValue(key, list);
    },
    addRenamedEntries: (entries) => {
      if (!Array.isArray(entries) || entries.length === 0) return;
      const list = Storage.getNominalList(CONFIG.RENAMED_KEY);
      const dateStr = Utils.now().split("T")[0];
      entries.forEach((entry) => {
        if (!entry?.id || !entry?.oldUsername || !entry?.newUsername) return;
        const exists = list.find((item) => item.id === entry.id && item.newUsername === entry.newUsername);
        if (!exists) {
          list.push({
            id: entry.id,
            username: entry.newUsername,
            oldUsername: entry.oldUsername,
            newUsername: entry.newUsername,
            date: dateStr
          });
        }
      });
      GM_setValue(CONFIG.RENAMED_KEY, list);
    },
    resetAll: () => {
      GM_deleteValue(CONFIG.STORAGE_KEY);
      GM_deleteValue(CONFIG.WHITELIST_KEY);
      GM_deleteValue(CONFIG.HISTORY_KEY);
      GM_deleteValue(CONFIG.HISTORY_SNAPSHOTS_KEY);
      GM_deleteValue(CONFIG.CHURN_KEY);
      GM_deleteValue(CONFIG.DEACTIVATED_KEY);
      GM_deleteValue(CONFIG.BLOCKED_KEY);
      GM_deleteValue(CONFIG.RENAMED_KEY);
      clearSharedExclusions();
    }
  };

  const Icons = {
    link: "↗",
    logs: "Logs",
    history: "History",
    notFollowing: "Not Following",
    fans: "Fans",
    mutuals: "Mutuals",
    unfollowers: "Unfollowers",
    deactivated: "Deactivated",
    blocked: "Blocked",
    renamed: "Renamed",
    logo: "IG",
    warning: "!",
    play: "Run",
    download: "Export",
    trash: "Reset",
    mailbox: "Mail",
    metrics: "Metrics",
    up: "up",
    down: "down",
    neutral: "-"
  };

  const UI = {
    init: () => {
      UI.bindTabs();
      UI.renderHistory(Storage.getHistory());
      UI.renderNominalList(Storage.getNominalList(CONFIG.CHURN_KEY), "ig-view-unfollowers", "Recent Unfollowers");
      UI.renderNominalList(Storage.getNominalList(CONFIG.DEACTIVATED_KEY), "ig-view-deactivated", "Deactivated Accounts");
      UI.renderNominalList(Storage.getNominalList(CONFIG.BLOCKED_KEY), "ig-view-blocked", "Blocked Accounts");
      UI.renderRenamedList(Storage.getNominalList(CONFIG.RENAMED_KEY), "ig-view-renamed", "Username Changes");
    },
    applyTheme: () => {
      // review.css owns the visual system; this hook is retained from the userscript integration surface.
    },
    confirmAction: async (title, message, confirmBtnText = "Yes, Continue") => {
      const plainMessage = message.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "");
      return window.confirm(`${title}\n\n${plainMessage}\n\n${confirmBtnText}?`);
    },
    bindTabs: () => {
      document.querySelectorAll(".ig-tab-btn").forEach((button) => {
        button.addEventListener("click", () => {
          document.querySelectorAll(".ig-tab-btn").forEach((tab) => tab.classList.remove("active"));
          document.querySelectorAll(".ig-view").forEach((view) => view.classList.remove("active"));
          button.classList.add("active");
          document.getElementById(button.dataset.target)?.classList.add("active");
        });
      });
    },
    setStatus: (text) => {
      const el = document.getElementById("ig-status");
      if (el) el.textContent = text;
    },
    log: (msg) => {
      const box = document.getElementById("ig-log");
      if (!box) return;
      const entry = document.createElement("div");
      entry.className = "ig-log-entry";
      entry.innerHTML = `<span class="ig-log-time">${escapeHtml(new Date().toLocaleTimeString())}</span> ${escapeHtml(msg)}`;
      box.prepend(entry);
      Utils.log(msg);
    },
    setProgress: (current, total, label = "") => {
      const container = document.getElementById("ig-progress-container");
      const bar = document.getElementById("ig-progress-bar");
      if (!container || !bar) return;
      container.hidden = false;
      const percent = total ? Math.min(100, Math.round((current / total) * 100)) : 0;
      bar.style.width = `${percent}%`;
      if (label) UI.setStatus(label);
    },
    hideProgress: () => {
      const container = document.getElementById("ig-progress-container");
      const bar = document.getElementById("ig-progress-bar");
      if (container) container.hidden = true;
      if (bar) bar.style.width = "0%";
    },
    renderResults: (users, title, containerId, isExportable = false) => {
      const container = document.getElementById(containerId);
      if (!container) return;
      const count = users?.length || 0;
      container.innerHTML = `<div class="ig-section-title">${escapeHtml(title)} <span class="ig-badge">${count}</span></div>`;
      if (!count) {
        container.append(createEmptyMessage("No accounts found for this view."));
        return;
      }

      users.forEach((user) => {
        const row = createUserRow(user.username, user.url);
        if (isExportable) {
          const whitelistButton = document.createElement("button");
          whitelistButton.className = "btn-whitelist";
          whitelistButton.type = "button";
          whitelistButton.textContent = "Whitelist";
          whitelistButton.addEventListener("click", () => {
            Storage.addToWhitelist(user.username);
            row.remove();
            window.__igLastResults = (window.__igLastResults || []).filter((item) => item.username !== user.username);
            const exportButton = document.getElementById("ig-export-csv");
            if (exportButton) exportButton.disabled = window.__igLastResults.length === 0;
            window.InstagramCsvUnfollow?.excludeAccount?.(user.username);
            UI.log(`Whitelisted @${user.username}.`);
          });
          row.querySelector(".ig-user-actions").prepend(whitelistButton);
        }
        container.append(row);
      });

      const exportButton = document.getElementById("ig-export-csv");
      if (isExportable && exportButton) exportButton.disabled = count === 0;
    },
    // Analyzer results feed the unfollow grid automatically; there is no intermediate
    // "Send to Unfollow" step. Safe to call repeatedly — the grid resets on each load.
    pushResultsToUnfollowGrid: async (sourceLabel) => {
      const results = window.__igLastResults || [];
      if (!results.length) {
        return;
      }

      const bridge = window.InstagramCsvUnfollow;
      if (!bridge?.loadUsernamesIntoUnfollowGrid) {
        UI.log("Unfollow grid is not ready yet. Reopen the review page and try again.");
        return;
      }

      try {
        await bridge.loadUsernamesIntoUnfollowGrid(results, { sourceLabel });
        UI.log(`Loaded ${results.length} account${results.length === 1 ? "" : "s"} into the unfollow grid.`);
      } catch (error) {
        // Callers may fire this without awaiting, so it must never reject.
        Utils.logError("Failed to load results into the unfollow grid", error);
      }
    },
    renderNominalList: (list, containerId, title) => {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.innerHTML = `<div class="ig-section-title">${escapeHtml(title)} <span class="ig-badge">${list.length}</span></div>`;
      if (!list.length) {
        container.append(createEmptyMessage("No stored entries yet."));
        return;
      }
      list.forEach((item) => {
        container.append(createUserRow(item.username, `https://www.instagram.com/${item.username}/`, item.date));
      });
    },
    renderRenamedList: (list, containerId, title) => {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.innerHTML = `<div class="ig-section-title">${escapeHtml(title)} <span class="ig-badge">${list.length}</span></div>`;
      if (!list.length) {
        container.append(createEmptyMessage("No username changes detected."));
        return;
      }
      list.forEach((item) => {
        const row = createUserRow(item.newUsername || item.username, `https://www.instagram.com/${item.newUsername || item.username}/`, item.date);
        row.querySelector(".ig-username").textContent = `@${item.oldUsername} → @${item.newUsername}`;
        container.append(row);
      });
    },
    renderHistory: (historyData) => {
      const container = document.getElementById("ig-view-history");
      if (!container) return;
      container.innerHTML = `<div class="ig-section-title">History <span class="ig-badge">${historyData.length}</span></div>`;
      if (!historyData.length) {
        container.append(createEmptyMessage("Run an analysis to start tracking history."));
        return;
      }
      const table = document.createElement("table");
      table.className = "ig-table";
      table.innerHTML = "<thead><tr><th>Date</th><th>Followers</th><th>Following</th><th>Data</th></tr></thead><tbody></tbody>";
      const body = table.querySelector("tbody");
      historyData.forEach((entry) => {
        const hasSnapshot = Boolean(Storage.getHistorySnapshot(entry.date));
        const row = document.createElement("tr");
        row.className = hasSnapshot ? "history-row is-restorable" : "history-row";
        row.innerHTML = `
          <td>${escapeHtml(entry.date)}</td>
          <td>${entry.followers}</td>
          <td>${entry.following}</td>
          <td><button class="history-load-button" type="button" ${hasSnapshot ? "" : "disabled"}>${hasSnapshot ? "Load" : "Counts only"}</button></td>
        `;
        if (hasSnapshot) {
          row.addEventListener("click", (event) => {
            if (event.target.closest("button")) {
              return;
            }
            UI.loadHistorySnapshot(entry.date);
          });
          row.querySelector("button").addEventListener("click", () => UI.loadHistorySnapshot(entry.date));
        }
        body.append(row);
      });
      container.append(table);
    },
    loadHistorySnapshot: (date) => {
      const snapshot = Storage.getHistorySnapshot(date);
      if (!snapshot) {
        UI.log(`No saved data is available for ${date}.`);
        return;
      }

      const mapToDetailed = (arr) => (arr || []).map((username) => ({ username, url: `https://www.instagram.com/${username}/` }));
      const notFollowingBackDetailed = snapshot.notFollowingBackDetailed || mapToDetailed(snapshot.notFollowingBack || []);
      const fansDetailed = snapshot.fansDetailed || mapToDetailed(snapshot.fans || []);
      const mutualsDetailed = snapshot.mutualsDetailed || mapToDetailed(snapshot.mutuals || []);

      UI.renderResults(notFollowingBackDetailed, `Not Following You Back (${date})`, "ig-view-notfollowing", true);
      UI.renderResults(fansDetailed, `Fans (${date})`, "ig-view-fans", false);
      UI.renderResults(mutualsDetailed, `Mutual Connections (${date})`, "ig-view-mutuals", false);
      UI.renderNominalList(Storage.getNominalList(CONFIG.CHURN_KEY), "ig-view-unfollowers", "Recent Unfollowers");
      UI.renderNominalList(Storage.getNominalList(CONFIG.DEACTIVATED_KEY), "ig-view-deactivated", "Deactivated Accounts");
      UI.renderNominalList(Storage.getNominalList(CONFIG.BLOCKED_KEY), "ig-view-blocked", "Blocked Accounts");
      UI.renderRenamedList(Storage.getNominalList(CONFIG.RENAMED_KEY), "ig-view-renamed", "Username Changes");
      window.__igLastResults = notFollowingBackDetailed;
      UI.pushResultsToUnfollowGrid(`analyzer snapshot ${date}`);
      document.querySelector('[data-target="ig-view-notfollowing"]')?.click();
      UI.setStatus(`Loaded ${date}`);
      UI.log(`Loaded analyzer data from ${date}.`);
    },
    makeDraggable: () => {
      // Retained from the userscript. The analyzer is integrated into the page, so dragging is not used.
    },
    clampPanelToViewport: (raw) => raw,
    loadPosition: () => {
      // Retained from the userscript. The integrated analyzer uses the review page layout.
    },
    resetPosition: () => {
      GM_deleteValue(CONFIG.POSITION_KEY);
    },
    togglePanel: () => {
      const section = document.querySelector(".analyzer-section");
      if (section) section.hidden = !section.hidden;
    }
  };

  const API = {
    fetchWithRetry: async (url, retries = CONFIG.MAX_RETRIES, backoff = 3000) => {
      for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
          const response = await fetch(url, { credentials: "include" });
          if (response.ok) return await response.json();
          if (response.status === 429) {
            UI.log(`Request limit (429). Retrying in ${backoff / 1000}s... (Attempt ${attempt + 1}/${retries})`);
            await Utils.sleep(backoff);
            backoff *= 2;
          } else {
            throw new Error(`HTTP ${response.status} while requesting ${url}`);
          }
        } catch (error) {
          if (attempt === retries - 1) throw error;
        }
      }
      throw new Error("Maximum retries achieved.");
    },
    getAllUsers: async (userId, hash, label) => {
      const users = [];
      let cursor = null;
      let hasNext = true;
      let totalCount = 0;
      while (hasNext) {
        const vars = encodeURIComponent(JSON.stringify({ id: userId, first: CONFIG.PAGE_SIZE, after: cursor }));
        const url = `https://www.instagram.com/graphql/query/?query_hash=${hash}&variables=${vars}`;
        const json = await API.fetchWithRetry(url);
        const userNode = json?.data?.user;
        const edge = userNode?.edge_follow || userNode?.edge_followed_by;
        if (!edge || !Array.isArray(edge.edges)) throw new Error(`Unexpected GraphQL structure while extracting ${label}. The API shape may have changed.`);
        if (totalCount === 0 && edge.count) totalCount = edge.count;
        edge.edges.forEach((edgeItem) => {
          const node = edgeItem?.node;
          const username = node?.username;
          if (!username) return;
          users.push({ id: node?.id ? String(node.id) : null, username: String(username) });
          users[users.length - 1].fullName = node?.full_name || "";
          users[users.length - 1].profilePicUrl = node?.profile_pic_url || "";
        });
        hasNext = edge.page_info?.has_next_page === true;
        cursor = edge.page_info?.end_cursor || null;
        UI.setProgress(users.length, totalCount, `Extracting ${label}...`);
        if (hasNext) await Utils.sleep(CONFIG.BASE_RATE_LIMIT_MS + Math.random() * 500);
      }
      UI.log(`Total ${label}: ${users.length} (with IDs: ${users.filter((user) => !!user.id).length})`);
      return users;
    },
    checkAccountStatus: async (username) => {
      try {
        const authRes = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
          headers: { "X-IG-App-ID": "936619743392459" },
          credentials: "include"
        });
        let authData = null;
        if (authRes.ok) {
          const json = await authRes.json();
          authData = json?.data?.user;
        }
        if (authData) return "Active";

        const anonRes = await fetch(`https://www.instagram.com/${encodeURIComponent(username)}/`, { credentials: "omit" });
        const anonText = await anonRes.text();
        const loginRedirectPath = `login/?next=%2F${username}%2F`;
        const existsPublicly = anonText.includes(loginRedirectPath) || anonText.includes(`"username":"${username}"`);
        const isErrorPage = anonText.includes("page_not_found") || anonText.includes("Sorry, this page isn't available.") || anonText.includes("Esta página no está disponible.");
        return existsPublicly && !isErrorPage ? "Blocked" : "Deactivated";
      } catch (error) {
        console.error(`Error verifying account status for "${username}". Defaulting to Active.`, error);
        return "Active";
      }
    }
  };

  const App = {
    run: async () => {
      const btnRun = document.getElementById("ig-run");
      if (btnRun) btnRun.disabled = true;
      const userConfirmed = await UI.confirmAction(
        "Safety Precaution",
        "Excessive use of automation tools may result in temporary account restrictions.<br><br>It is recommended to run this analysis <b>only once per hour</b>.",
        "Yes, Continue"
      );
      if (!userConfirmed) {
        UI.log("Analysis cancelled by user.");
        if (btnRun) btnRun.disabled = false;
        return;
      }

      UI.setStatus("Analyzing...");
      UI.log("Starting deep analysis...");
      document.querySelector('[data-target="ig-log"]')?.click();
      try {
        const userId = await Utils.getUserId();
        if (!userId) throw new Error("User ID could not be obtained. Sign in to Instagram first.");
        UI.log("Fetching 'Following'...");
        const followingDetailedRaw = await API.getAllUsers(userId, CONFIG.FOLLOWING_HASH, "following");
        UI.log("Fetching 'Followers'...");
        const followersDetailedRaw = await API.getAllUsers(userId, CONFIG.FOLLOWERS_HASH, "followers");
        const followingDetailed = Utils.toDetailedUserArray(followingDetailedRaw);
        const followersDetailed = Utils.toDetailedUserArray(followersDetailedRaw);
        const following = followingDetailed.map((user) => user.username);
        const followers = followersDetailed.map((user) => user.username);
        const followingByUsername = new Map(followingDetailed.map((user) => [user.username, user]));
        const followersByUsername = new Map(followersDetailed.map((user) => [user.username, user]));

        UI.hideProgress();
        UI.setStatus("Calculating Metrics...");
        Storage.addHistoryEntry(followers.length, following.length);
        UI.renderHistory(Storage.getHistory());

        const notFollowingBackUsernames = Utils.diff(following, followers);
        const fansUsernames = Utils.diff(followers, following);
        const mutualsUsernames = Utils.intersection(followers, following);
        const whitelist = Storage.getWhitelist();
        const filteredNotFollowing = notFollowingBackUsernames.filter((username) => !whitelist.includes(username));
        const mapToDetailed = (arr, sourceMap) => arr.map((username) => {
          const source = sourceMap.get(username) || {};
          return {
            username,
            id: source.id || null,
            userId: source.id || null,
            fullName: source.fullName || "",
            profilePicUrl: source.profilePicUrl || "",
            url: `https://www.instagram.com/${username}/`
          };
        });
        const notFollowingBackDetailed = mapToDetailed(filteredNotFollowing, followingByUsername);
        const fansDetailed = mapToDetailed(fansUsernames, followersByUsername);
        const mutualsDetailed = mapToDetailed(mutualsUsernames, followersByUsername);

        UI.log(`Not Following Back (filtered): ${notFollowingBackDetailed.length}`);
        UI.log(`Fans: ${fansDetailed.length}`);
        UI.log(`Mutuals: ${mutualsDetailed.length}`);

        const prev = Storage.load();
        if (prev) {
          await App.processPreviousSnapshot(prev, followers, following, followersDetailed, followingDetailed);
        } else {
          UI.log("First run: Initial state established.");
        }

        Storage.save({
          lastRun: Utils.now(),
          followersDetailed,
          followingDetailed
        });
        Storage.saveHistorySnapshot(Utils.now().split("T")[0], {
          savedAt: Utils.now(),
          notFollowingBack: notFollowingBackDetailed.map((user) => user.username),
          fans: fansDetailed.map((user) => user.username),
          mutuals: mutualsDetailed.map((user) => user.username)
        });
        UI.renderHistory(Storage.getHistory());
        UI.renderResults(notFollowingBackDetailed, "Not Following You Back", "ig-view-notfollowing", true);
        UI.renderResults(fansDetailed, "Fans (They follow you, you don't)", "ig-view-fans", false);
        UI.renderResults(mutualsDetailed, "Mutual Connections", "ig-view-mutuals", false);
        UI.renderNominalList(Storage.getNominalList(CONFIG.CHURN_KEY), "ig-view-unfollowers", "Recent Unfollowers");
        UI.renderNominalList(Storage.getNominalList(CONFIG.DEACTIVATED_KEY), "ig-view-deactivated", "Deactivated Accounts");
        UI.renderNominalList(Storage.getNominalList(CONFIG.BLOCKED_KEY), "ig-view-blocked", "Blocked Accounts");
        UI.renderRenamedList(Storage.getNominalList(CONFIG.RENAMED_KEY), "ig-view-renamed", "Username Changes");
        window.__igLastResults = notFollowingBackDetailed;
        await UI.pushResultsToUnfollowGrid("analyzer Not Following results");
        UI.setStatus("Completed");
        UI.log("[OK] Analysis completed successfully.");
      } catch (error) {
        UI.setStatus("Error");
        UI.hideProgress();
        Utils.logError("Failed analysis", error);
      } finally {
        if (btnRun) btnRun.disabled = false;
      }
    },
    processPreviousSnapshot: async (prev, followers, following, followersDetailed, followingDetailed) => {
      const prevFollowersDetailed = Utils.toDetailedUserArray(Array.isArray(prev.followersDetailed) ? prev.followersDetailed : prev.followers || []);
      const prevFollowingDetailed = Utils.toDetailedUserArray(Array.isArray(prev.followingDetailed) ? prev.followingDetailed : prev.following || []);
      const prevFollowers = prevFollowersDetailed.map((user) => user.username);
      const prevFollowing = prevFollowingDetailed.map((user) => user.username);
      const newFollowers = Utils.diff(followers, prevFollowers);
      UI.log(`New followers since last run: ${newFollowers.length}`);
      const lostFollowers = Utils.diff(prevFollowers, followers);
      const lostFollowing = Utils.diff(prevFollowing, following);
      const missingUsers = Utils.intersection(lostFollowers, lostFollowing);
      const prevMutualsDetailed = Utils.intersectionById(prevFollowersDetailed, prevFollowingDetailed);
      const currMutualsDetailed = Utils.intersectionById(followersDetailed, followingDetailed);
      const renamedEntries = Utils.detectRenamedMutuals(prevMutualsDetailed, currMutualsDetailed);
      const renamedOldUsernameSet = new Set(renamedEntries.map((entry) => entry.oldUsername));
      if (renamedEntries.length > 0) {
        Storage.addRenamedEntries(renamedEntries);
        UI.renderRenamedList(Storage.getNominalList(CONFIG.RENAMED_KEY), "ig-view-renamed", "Username Changes");
        UI.log(`Detected ${renamedEntries.length} confirmed username change(s) in mutuals.`);
      }

      const newDeactivated = [];
      const newBlocked = [];
      const newUnfollowers = [];
      const filteredLostFollowers = lostFollowers.filter((username) => !renamedOldUsernameSet.has(username));
      const filteredMissingUsers = missingUsers.filter((username) => !renamedOldUsernameSet.has(username));
      const accountsToVerify = Utils.unique([...filteredLostFollowers, ...filteredMissingUsers]);
      if (accountsToVerify.length > 0) {
        UI.setStatus("Verifying lost accounts...");
        for (const username of accountsToVerify) {
          const status = await API.checkAccountStatus(username);
          if (status === "Deactivated") newDeactivated.push(username);
          if (status === "Blocked") newBlocked.push(username);
          if (status === "Active" && filteredLostFollowers.includes(username)) newUnfollowers.push(username);
        }
      }
      if (newUnfollowers.length > 0) Storage.addNominalEntries(CONFIG.CHURN_KEY, newUnfollowers);
      if (newDeactivated.length > 0) Storage.addNominalEntries(CONFIG.DEACTIVATED_KEY, newDeactivated);
      if (newBlocked.length > 0) Storage.addNominalEntries(CONFIG.BLOCKED_KEY, newBlocked);
    },
    bindEvents: () => {
      const btnRun = document.getElementById("ig-run");
      if (btnRun) btnRun.onclick = App.run;
      const btnExport = document.getElementById("ig-export-csv");
      if (btnExport) btnExport.onclick = () => {
        if (window.__igLastResults) {
          const dateStr = Utils.now().split("T")[0];
          Utils.exportCSV(window.__igLastResults, `ig_no_follow_back_${dateStr}.csv`);
          UI.log("CSV Exported.");
        }
      };
      const btnReset = document.getElementById("ig-reset");
      if (btnReset) {
        btnReset.onclick = async () => {
          const confirmed = await UI.confirmAction(
            "Delete All Data",
            "This action will wipe all your history, logs, and whitelists.<br><br>Are you sure you want to proceed?",
            "Yes, Delete"
          );
          if (confirmed) {
            Storage.resetAll();
            UI.log("[INFO] Data reset.");
            document.querySelectorAll(".ig-view-container").forEach((el) => {
              if (el.id !== "ig-log") el.innerHTML = "";
            });
            if (btnExport) btnExport.disabled = true;
            window.__igLastResults = [];
            UI.init();
          }
        };
      }
      document.addEventListener("keydown", (event) => {
        const tag = document.activeElement.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement.isContentEditable) return;
        if (event.key === "F9") UI.togglePanel();
        if (event.key === "F8") UI.resetPosition();
      });
    }
  };

  const TOUR_SEEN_KEY = "ig_tour_completed_v1";

  function getTamperGuide() {
    return null;
  }

  function buildSteps() {
    return [
      { popover: { title: "Welcome to IG Analyzer!", description: "This analyzer now lives inside the extension review page." } },
      { element: "#ig-run", popover: { title: "Run Analysis", description: "Scans followers and following lists." } },
      { element: "#ig-export-csv", popover: { title: "Export CSV", description: "Exports users who do not follow you back." } },
      { element: "#ig-tabs", popover: { title: "Analyzer Views", description: "Switch between logs, history, and relationship categories." } }
    ];
  }

  function isTourCompleted() {
    return GM_getValue(TOUR_SEEN_KEY, false) === true;
  }

  function markTourCompleted() {
    GM_setValue(TOUR_SEEN_KEY, true);
  }

  function resetTour() {
    GM_deleteValue(TOUR_SEEN_KEY);
    console.log("[IG Analyzer] Tour reset.");
  }

  function startTour(options = {}) {
    const { force = false } = options;
    if (!force && isTourCompleted()) return null;
    UI.log("Analyzer tour is integrated as static page controls in this extension build.");
    markTourCompleted();
    return buildSteps();
  }

  function GM_addStyle(cssText) {
    const style = document.createElement("style");
    style.dataset.igAnalyzer = "true";
    style.textContent = cssText;
    (document.head || document.documentElement).appendChild(style);
    return style;
  }

  function GM_getValue(key, defaultValue = null) {
    try {
      const stored = window.localStorage.getItem(`ig-analyzer:${key}`);
      return stored === null ? defaultValue : JSON.parse(stored);
    } catch (_error) {
      return defaultValue;
    }
  }

  function GM_setValue(key, value) {
    window.localStorage.setItem(`ig-analyzer:${key}`, JSON.stringify(value));
  }

  function GM_deleteValue(key) {
    window.localStorage.removeItem(`ig-analyzer:${key}`);
  }

  function GM_registerMenuCommand(name, callback) {
    window.__igAnalyzerMenuCommands = window.__igAnalyzerMenuCommands || new Map();
    window.__igAnalyzerMenuCommands.set(name, callback);
    return name;
  }

  function createUserRow(username, url, meta = "") {
    const row = document.createElement("div");
    row.className = "ig-user-row";
    row.innerHTML = `
      <div class="ig-user-info">
        <div class="ig-user-avatar">${escapeHtml(username.slice(0, 1).toUpperCase())}</div>
        <div>
          <div class="ig-username">@${escapeHtml(username)}</div>
          ${meta ? `<div class="ig-table-date">${escapeHtml(meta)}</div>` : ""}
        </div>
      </div>
      <div class="ig-user-actions">
        <a class="ig-view-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open ${Icons.link}</a>
      </div>
    `;
    return row;
  }

  function createEmptyMessage(message) {
    const empty = document.createElement("div");
    empty.className = "ig-empty-msg";
    empty.textContent = message;
    return empty;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function addSharedExclusion(username) {
    if (window.InstaCleanExclusions?.add) {
      window.InstaCleanExclusions.add(username);
      return;
    }

    const exclusions = getFallbackExclusions();
    exclusions.add(String(username).toLowerCase());
    window.localStorage.setItem("instaclean_excluded_usernames_v1", JSON.stringify(Array.from(exclusions).sort()));
  }

  function clearSharedExclusions() {
    if (window.InstaCleanExclusions?.clear) {
      window.InstaCleanExclusions.clear();
      return;
    }

    window.localStorage.removeItem("instaclean_excluded_usernames_v1");
  }

  function getFallbackExclusions() {
    try {
      const stored = JSON.parse(window.localStorage.getItem("instaclean_excluded_usernames_v1") || "[]");
      return new Set((Array.isArray(stored) ? stored : []).map((username) => String(username).toLowerCase()));
    } catch (_error) {
      return new Set();
    }
  }

  window.InstagramFollowerAnalyzer = {
    CONFIG,
    Utils,
    Storage,
    Icons,
    UI,
    API,
    App,
    getTamperGuide,
    buildSteps,
    isTourCompleted,
    markTourCompleted,
    resetTour,
    startTour,
    GM_addStyle,
    GM_getValue,
    GM_setValue,
    GM_deleteValue,
    GM_registerMenuCommand,
    importCSS
  };

  UI.init();
  App.bindEvents();
  GM_registerMenuCommand("Replay IG Analyzer Tour", () => startTour({ force: true }));
  UI.log("IG Analyzer loaded inside the extension review page.");
})();
