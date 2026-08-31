const EXCLUDED_USERNAMES_KEY = "instaclean_excluded_usernames_v1";
const PROFILE_CACHE_KEY = "instaclean_profile_cache_v1";
const REMOVE_ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 47.5 47.5" aria-hidden="true" focusable="false">
  <defs>
    <clipPath id="instaclean-remove-icon-clip">
      <path d="M0 38h38V0H0v38Z"></path>
    </clipPath>
  </defs>
  <g clip-path="url(#instaclean-remove-icon-clip)" transform="matrix(1.25 0 0 -1.25 0 47.5)">
    <path fill="#dd2e44" d="M6 19c0 2.565.753 4.95 2.036 6.964L25.965 8.035A12.93 12.93 0 0 0 19 6C11.821 6 6 11.82 6 19m26 0c0-2.565-.753-4.95-2.035-6.965L12.036 29.964A12.916 12.916 0 0 0 19 32c7.18 0 13-5.821 13-13M19 37C9.059 37 1 28.941 1 19S9.059 1 19 1s18 8.059 18 18-8.059 18-18 18"></path>
  </g>
</svg>`;

const state = {
  accounts: [],
  queueRunning: false,
  queuePaused: false,
  cooldownActive: false,
  port: null,
  lookupPort: null,
  avatarBlobUrls: new Map(),
  progress: {
    completed: 0,
    total: 0,
    failed: 0
  },
  lastExclusionAction: null
};

const csvInput = document.getElementById("csvInput");
const accountGrid = document.getElementById("accountGrid");
const gridStatus = document.getElementById("gridStatus");
const validCount = document.getElementById("validCount");
const activeCount = document.getElementById("activeCount");
const removedCount = document.getElementById("removedCount");
const failedCount = document.getElementById("failedCount");
const unfollowButton = document.getElementById("unfollowButton");
const pauseButton = document.getElementById("pauseButton");
const resumeButton = document.getElementById("resumeButton");
const cancelButton = document.getElementById("cancelButton");
const undoExclusionButton = document.getElementById("undoExclusionButton");
const delayInput = document.getElementById("delayInput");
const activityLog = document.getElementById("activityLog");
const progressLabel = document.getElementById("progressLabel");
const progressNumbers = document.getElementById("progressNumbers");
const progressBar = document.getElementById("progressBar");
const sessionPill = document.getElementById("sessionPill");
const cooldownTimer = document.getElementById("cooldownTimer");
const cooldownValue = document.getElementById("cooldownValue");
const editExclusionsButton = document.getElementById("editExclusionsButton");
const exclusionsModal = document.getElementById("exclusionsModal");
const closeExclusionsButton = document.getElementById("closeExclusionsButton");
const addExclusionForm = document.getElementById("addExclusionForm");
const exclusionInput = document.getElementById("exclusionInput");
const exclusionCount = document.getElementById("exclusionCount");
const clearProfileCacheButton = document.getElementById("clearProfileCacheButton");
const clearExclusionsButton = document.getElementById("clearExclusionsButton");
const exclusionsList = document.getElementById("exclusionsList");
const exportExclusionsButton = document.getElementById("exportExclusionsButton");
const importExclusionsButton = document.getElementById("importExclusionsButton");
const importExclusionsInput = document.getElementById("importExclusionsInput");

csvInput.addEventListener("change", handleCsvUpload);
unfollowButton.addEventListener("click", () => startUnfollowQueue());
pauseButton.addEventListener("click", pauseQueue);
resumeButton.addEventListener("click", resumeQueue);
cancelButton.addEventListener("click", cancelQueue);
undoExclusionButton.addEventListener("click", undoLastExclusionAction);
editExclusionsButton.addEventListener("click", openExclusionsEditor);
closeExclusionsButton.addEventListener("click", closeExclusionsEditor);
clearProfileCacheButton.addEventListener("click", clearProfileCacheFromEditor);
clearExclusionsButton.addEventListener("click", clearExclusionsFromEditor);
addExclusionForm.addEventListener("submit", addExclusionFromEditor);
exportExclusionsButton.addEventListener("click", exportExclusions);
importExclusionsButton.addEventListener("click", () => importExclusionsInput.click());
importExclusionsInput.addEventListener("change", importExclusionsFromFile);
exclusionsModal.addEventListener("click", (event) => {
  if (event.target === exclusionsModal) {
    closeExclusionsEditor();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !exclusionsModal.hidden) {
    closeExclusionsEditor();
  }
});

checkSession();
updateUndoButton();

async function checkSession() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SESSION_STATUS" });
  if (response?.ok && response.loggedIn) {
    sessionPill.textContent = "Instagram session ready";
    sessionPill.classList.add("is-ready");
    return;
  }

  sessionPill.textContent = "Sign in to Instagram";
  sessionPill.classList.add("is-error");
  addLog("Instagram session was not detected. Sign in at instagram.com before running the queue.", "error");
}

async function handleCsvUpload(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  const text = await file.text();
  const parsed = parseUsernamesFromCsv(text);
  await loadUsernamesIntoUnfollowGrid(parsed.usernames, {
    sourceLabel: file.name,
    skippedCount: parsed.skipped.length
  });
}

async function loadUsernamesIntoUnfollowGrid(usernames, options = {}) {
  const cleaned = normalizeImportRecords(usernames);
  const exclusions = getExcludedUsernames();
  const profileCache = getProfileCache();
  const filteredRecords = cleaned.records
    .filter((record) => !exclusions.has(record.username.toLowerCase()))
    .map((record) => applyCachedProfile(record, profileCache));
  const excludedCount = cleaned.records.length - filteredRecords.length;
  resetQueueState();

  state.accounts = filteredRecords.map((record) => ({
    username: record.username,
    requestedUsername: record.username,
    removed: false,
    lookupStatus: record.userId ? "ready" : "loading",
    lookupError: "",
    queueStatus: "idle",
    queueMessage: "",
    justCompleted: false,
    userId: record.userId || "",
    profilePicUrl: record.profilePicUrl || "",
    fullName: record.fullName || ""
  }));
  state.accounts.forEach((account) => {
    if (account.userId) {
      cacheProfile(account);
    }
  });

  renderAccounts();
  updateStats();

  const sourceLabel = options.sourceLabel || "analyzer results";
  const totalSkipped = cleaned.skipped.length + (options.skippedCount || 0);
  addLog(`Loaded ${state.accounts.length} account${state.accounts.length === 1 ? "" : "s"} from ${sourceLabel}.`);
  gridStatus.textContent = `Found ${state.accounts.length} valid handle${state.accounts.length === 1 ? "" : "s"}. Resolving profile pictures now.`;
  if (totalSkipped) {
    addLog(`Skipped ${totalSkipped} invalid or duplicate entr${totalSkipped === 1 ? "y" : "ies"}.`);
  }
  if (excludedCount) {
    addLog(`Skipped ${excludedCount} saved exclusion${excludedCount === 1 ? "" : "s"}.`);
  }
  const cacheHits = filteredRecords.filter((record) => record.cacheHit).length;
  if (cacheHits) {
    addLog(`Loaded ${cacheHits} profile${cacheHits === 1 ? "" : "s"} from cache.`);
  }

  if (!state.accounts.length) {
    gridStatus.textContent = "No valid Instagram handles were found.";
    return;
  }

  const usernamesNeedingLookup = filteredRecords.filter((record) => !record.userId).map((record) => record.username);
  if (!usernamesNeedingLookup.length) {
    gridStatus.textContent = "Analyzer data loaded. Review the selected accounts before confirming.";
    addLog("Analyzer data loaded without profile lookup.");
  } else {
    await resolveProfiles(usernamesNeedingLookup);
  }
  document.getElementById("gridTitle")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function parseUsernamesFromCsv(text) {
  const rows = parseCsvRows(text);
  const values = [];
  const headerLabels = new Set(["username", "usernames", "handle", "handles", "instagram", "ig", "account", "accounts", "profile", "profiles"]);

  rows.forEach((row, rowIndex) => {
    const cells = row.map((cell) => cell.trim()).filter(Boolean);
    const isHeaderRow = rowIndex === 0 && cells.length > 0 && cells.every((cell) => headerLabels.has(cell.toLowerCase().replace(/^@/, "")));
    if (isHeaderRow) {
      return;
    }

    values.push(...cells);
  });

  return cleanUsernameList(values);
}

function cleanUsernameList(values) {
  const normalized = normalizeImportRecords(values);
  return {
    usernames: normalized.records.map((record) => record.username),
    skipped: normalized.skipped
  };
}

function normalizeImportRecords(values) {
  const records = [];
  const usernames = [];
  const seen = new Set();
  const skipped = [];

  values.forEach((value) => {
    const rawValue = typeof value === "string" ? value : value?.username || "";
    const cleaned = cleanUsername(rawValue);
    const key = cleaned.toLowerCase();

    if (!cleaned || seen.has(key)) {
      skipped.push(rawValue);
      return;
    }

    seen.add(key);
    usernames.push(cleaned);
    records.push({
      username: cleaned,
      userId: typeof value === "string" ? "" : String(value?.userId || value?.id || ""),
      fullName: typeof value === "string" ? "" : value?.fullName || "",
      profilePicUrl: typeof value === "string" ? "" : value?.profilePicUrl || ""
    });
  });

  return { records, usernames, skipped };
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

function cleanUsername(value) {
  const trimmed = value.trim().replace(/^@/, "");
  if (!trimmed || /[/?#:\\]/.test(trimmed)) {
    return "";
  }

  const username = trimmed.toLowerCase();
  const valid = /^(?!.*\.\.)(?!\.)(?!.*\.$)[a-z0-9._]{1,30}$/.test(username);
  return valid ? username : "";
}

async function resolveProfiles(usernames) {
  cleanupLookupPort();
  gridStatus.textContent = `Resolving profiles 0 / ${usernames.length}.`;

  return new Promise((resolve) => {
    state.lookupPort = chrome.runtime.connect({ name: "profile-lookup" });
    state.lookupPort.onMessage.addListener((message) => {
      if (message.type === "PROFILE_LOOKUP_STARTED") {
        gridStatus.textContent = `Resolving profiles 0 / ${message.total}.`;
        return;
      }

      if (message.type === "PROFILE_LOOKUP_ITEM") {
        applyProfileLookupResult(message.profile);
        gridStatus.textContent = `Resolving profiles ${message.completed} / ${message.total}.`;
        return;
      }

      if (message.type === "PROFILE_LOOKUP_COMPLETE") {
        finishProfileLookup();
        cleanupLookupPort();
        resolve();
        return;
      }

      if (message.type === "PROFILE_LOOKUP_CANCELLED") {
        cleanupLookupPort();
        resolve();
      }
    });

    state.lookupPort.onDisconnect.addListener(() => {
      state.lookupPort = null;
      resolve();
    });

    state.lookupPort.postMessage({ type: "START_PROFILE_LOOKUP", usernames });
  });
}

function applyProfileLookupResult(profile) {
  const index = state.accounts.findIndex((account) => account.username.toLowerCase() === profile.requestedUsername || account.username.toLowerCase() === profile.username.toLowerCase());
  if (index === -1) {
    return;
  }

  state.accounts[index] = {
    ...state.accounts[index],
    username: profile.username || state.accounts[index].username,
    lookupStatus: profile.ok ? "ready" : "error",
    lookupError: profile.ok ? "" : profile.error || "Lookup failed.",
    userId: profile.userId || "",
    profilePicUrl: profile.profilePicUrl || "",
    fullName: profile.fullName || ""
  };

  if (profile.ok && profile.userId) {
    cacheProfile(state.accounts[index]);
  }

  const existingCard = accountGrid.children[index];
  if (existingCard) {
    existingCard.replaceWith(createAccountCard(state.accounts[index], index));
  } else {
    renderAccounts();
  }
  updateStats();
}

function finishProfileLookup() {
  const failures = state.accounts.filter((account) => account.lookupStatus === "error").length;
  const rateLimited = state.accounts.filter((account) => account.lookupError.toLowerCase().includes("rate limited")).length;
  gridStatus.textContent = rateLimited
    ? `Instagram rate limited ${rateLimited} profile lookup${rateLimited === 1 ? "" : "s"}. Wait a few minutes before retrying.`
    : failures
      ? `Profile lookup finished with ${failures} account${failures === 1 ? "" : "s"} needing attention.`
      : "Profile lookup finished. Review the selected accounts before confirming.";
  addLog("Profile lookup finished.");
}

function renderAccounts() {
  accountGrid.replaceChildren(...state.accounts.map(createAccountCard));
  updateButtons();
}

function createAccountCard(account, index) {
  const card = document.createElement("article");
  card.className = [
    "account-card",
    account.removed ? "is-removed" : "",
    account.queueStatus === "running" ? "is-running" : "",
    account.queueStatus === "queued" ? "is-queued" : "",
    account.queueStatus === "succeeded" ? "is-unfollowed" : "",
    account.justCompleted ? "is-crossing" : "",
    account.queueStatus === "failed" ? "is-failed" : ""
  ].filter(Boolean).join(" ");

  const removeButton = document.createElement("button");
  removeButton.className = "remove-button";
  removeButton.type = "button";
  removeButton.innerHTML = REMOVE_ICON_SVG;
  removeButton.setAttribute("aria-label", `Dismiss ${account.username}`);
  removeButton.disabled = state.queueRunning;
  removeButton.addEventListener("click", () => {
    state.accounts[index].removed = true;
    addExcludedUsername(account.username);
    addLog(`Dismissed and saved @${account.username} as an exclusion.`);
    card.classList.add("is-removed");
    updateStats();
  });

  const avatarWrap = document.createElement("div");
  avatarWrap.className = "avatar-wrap";
  if (account.profilePicUrl) {
    const image = document.createElement("img");
    image.src = account.profilePicUrl;
    image.alt = `${account.username} profile picture`;
    image.referrerPolicy = "strict-origin-when-cross-origin";
    image.addEventListener("error", async () => {
      const blobUrl = await getAvatarBlobUrl(account.profilePicUrl);
      if (blobUrl) {
        image.src = blobUrl;
        avatarWrap.replaceChildren(image);
        return;
      }

      avatarWrap.replaceChildren(createAvatarPlaceholder(account.username));
    }, { once: true });
    avatarWrap.append(image);
  } else {
    avatarWrap.append(createAvatarPlaceholder(account.username));
  }

  const title = document.createElement("h3");
  title.textContent = account.fullName || "Instagram account";

  const name = document.createElement("p");
  name.textContent = `@${account.username}`;

  const status = document.createElement("div");
  status.className = `status-line ${getStatusClass(account)}`;
  status.textContent = getAccountStatus(account);

  const actionStack = document.createElement("div");
  actionStack.className = "card-actions";

  const profileButton = document.createElement("button");
  profileButton.className = "profile-button";
  profileButton.type = "button";
  profileButton.textContent = "Open profile";
  profileButton.addEventListener("click", () => {
    chrome.tabs.create({ url: `https://www.instagram.com/${encodeURIComponent(account.username)}/` });
  });

  const manualButton = document.createElement("button");
  manualButton.className = "manual-button";
  manualButton.type = "button";
  manualButton.textContent = account.queueStatus === "succeeded" ? "Unfollowed" : "Manual unfollow";
  manualButton.disabled = state.queueRunning || account.queueStatus === "succeeded" || account.removed;
  manualButton.addEventListener("click", () => {
    startUnfollowQueue([account], "manual");
  });

  actionStack.append(profileButton, manualButton);
  card.append(removeButton, avatarWrap, title, name, status, actionStack);
  return card;
}

function createAvatarPlaceholder(username) {
  const placeholder = document.createElement("div");
  placeholder.className = "avatar-placeholder";
  placeholder.textContent = username.slice(0, 1).toUpperCase();
  return placeholder;
}

async function getAvatarBlobUrl(url) {
  if (state.avatarBlobUrls.has(url)) {
    return state.avatarBlobUrls.get(url);
  }

  try {
    const response = await fetch(url, {
      credentials: "include",
      referrerPolicy: "strict-origin-when-cross-origin"
    });
    if (!response.ok) {
      return "";
    }

    const blobUrl = URL.createObjectURL(await response.blob());
    state.avatarBlobUrls.set(url, blobUrl);
    return blobUrl;
  } catch (_error) {
    return "";
  }
}

function getAccountStatus(account) {
  if (account.queueStatus === "running") {
    return "Unfollowing now";
  }

  if (account.queueStatus === "queued") {
    return "Waiting in queue";
  }

  if (account.queueStatus === "succeeded") {
    return account.queueMessage || "Unfollowed";
  }

  if (account.queueStatus === "failed") {
    return account.queueMessage || "Unfollow failed";
  }

  if (account.lookupStatus === "loading") {
    return "Loading profile";
  }

  if (account.lookupStatus === "error") {
    return summarizeCardMessage(account.lookupError || "Profile lookup failed");
  }

  return account.userId ? "Ready to unfollow" : "Missing user ID";
}

function getStatusClass(account) {
  if (account.queueStatus === "failed" || account.lookupStatus === "error") {
    return "is-error";
  }

  if (account.queueStatus === "running" || account.queueStatus === "queued") {
    return "is-running";
  }

  if (account.queueStatus === "succeeded") {
    return "is-done";
  }

  return "is-ready";
}

function startUnfollowQueue(queueAccounts = null, mode = "bulk") {
  const accounts = queueAccounts || state.accounts.filter((account) => !account.removed && account.queueStatus !== "succeeded");
  if (!accounts.length || state.queueRunning) {
    return;
  }

  state.queueRunning = true;
  state.queuePaused = false;
  state.cooldownActive = false;
  hideCooldownTimer();
  accounts.forEach((account) => {
    const index = findAccountIndex(account);
    if (index !== -1) {
      state.accounts[index].queueStatus = "queued";
      state.accounts[index].queueMessage = "";
    }
  });
  state.progress = { completed: 0, total: accounts.length, failed: 0 };
  failedCount.textContent = "0";
  updateProgress("Starting queue");
  updateButtons();
  renderAccounts();
  addLog(mode === "manual" ? `Starting manual unfollow for @${accounts[0].username}.` : `Starting unfollow queue for ${accounts.length} account${accounts.length === 1 ? "" : "s"}.`);

  state.port = chrome.runtime.connect({ name: "unfollow-queue" });
  state.port.onMessage.addListener(handleQueueMessage);
  state.port.onDisconnect.addListener(() => {
    if (state.queueRunning) {
      state.queueRunning = false;
      updateButtons();
      addLog("Queue connection closed.", "error");
    }
  });
  state.port.postMessage({
    type: "START_UNFOLLOW",
    accounts,
    options: {
      delayMs: getSelectedDelayMs()
    }
  });
}

function pauseQueue() {
  if (state.port && state.queueRunning && !state.queuePaused) {
    state.queuePaused = true;
    state.port.postMessage({ type: "PAUSE_UNFOLLOW" });
    updateProgress(`Paused after ${state.progress.completed} of ${state.progress.total}`);
    addLog("Pause requested. The current request may finish first.");
    updateButtons();
  }
}

function resumeQueue() {
  if (state.port && state.queueRunning && state.queuePaused) {
    state.queuePaused = false;
    state.port.postMessage({ type: "RESUME_UNFOLLOW" });
    updateProgress("Resuming queue");
    addLog("Queue resumed.");
    updateButtons();
  }
}

function cancelQueue() {
  if (state.port && state.queueRunning) {
    state.port.postMessage({ type: "CANCEL_UNFOLLOW" });
    state.queuePaused = false;
    addLog("Cancel requested. The current request may finish first.");
    updateButtons();
  }
}

function handleQueueMessage(message) {
  if (message.type === "QUEUE_STARTED") {
    state.progress.total = message.total;
    updateProgress("Queue running");
    return;
  }

  if (message.type === "QUEUE_PAUSED") {
    state.queuePaused = true;
    updateProgress(`Paused after ${message.completed ?? state.progress.completed} of ${message.total ?? state.progress.total}`);
    updateButtons();
    return;
  }

  if (message.type === "QUEUE_RESUMED") {
    state.queuePaused = false;
    updateProgress("Queue running");
    updateButtons();
    return;
  }

  if (message.type === "QUEUE_PROGRESS") {
    markAccountRunning(message.current);
    updateProgress(`Unfollowing @${message.current.username}`);
    renderAccounts();
    return;
  }

  if (message.type === "QUEUE_ITEM_DONE") {
    state.progress.completed = message.completed;
    state.progress.failed = message.failed;
    markAccountDone(message.result);
    failedCount.textContent = String(message.failed);
    updateProgress(message.result.ok ? `Unfollowed @${message.result.username}` : `Failed @${message.result.username}`);
    addLog(formatResult(message.result), message.result.ok ? "success" : "error");
    renderAccounts();
    updateStats();
    return;
  }

  if (message.type === "QUEUE_COMPLETE") {
    state.queueRunning = false;
    state.queuePaused = false;
    state.cooldownActive = false;
    state.progress.completed = message.completed;
    state.progress.failed = message.failed;
    failedCount.textContent = String(message.failed);
    updateProgress(`Complete: ${message.completed - message.failed} succeeded, ${message.failed} failed`);
    addLog("Queue complete.");
    hideCooldownTimer();
    cleanupPort();
    updateButtons();
    renderAccounts();
    return;
  }

  if (message.type === "QUEUE_CANCELLED") {
    state.queueRunning = false;
    state.queuePaused = false;
    state.cooldownActive = false;
    clearRunningStates("Cancelled");
    updateProgress(`Cancelled after ${message.completed} of ${message.total}`);
    addLog("Queue cancelled.");
    hideCooldownTimer();
    cleanupPort();
    updateButtons();
    renderAccounts();
    return;
  }

  if (message.type === "QUEUE_ERROR") {
    state.queueRunning = false;
    state.queuePaused = false;
    state.cooldownActive = false;
    clearRunningStates(message.error);
    updateProgress("Queue stopped");
    addLog(message.error, "error");
    hideCooldownTimer();
    cleanupPort();
    updateButtons();
    renderAccounts();
  }

  if (message.type === "QUEUE_COOLDOWN_STARTED") {
    state.cooldownActive = true;
    showCooldownTimer(message.remainingSeconds);
    updateProgress(`Cooldown: ${message.remainingSeconds}s`);
    addLog(
      message.reason === "soft-block"
        ? `Instagram accepted the unfollow for @${message.username} without applying it. Cooling down ${message.remainingSeconds}s before retrying.`
        : "Cooldown started after 35 successful unfollows.",
      message.reason === "soft-block" ? "error" : "info"
    );
    return;
  }

  if (message.type === "QUEUE_COOLDOWN_TICK") {
    state.cooldownActive = true;
    showCooldownTimer(message.remainingSeconds);
    updateProgress(`Cooldown: ${message.remainingSeconds}s`);
    return;
  }

  if (message.type === "QUEUE_COOLDOWN_ENDED") {
    state.cooldownActive = false;
    hideCooldownTimer();
    updateProgress("Queue running");
    addLog("Cooldown complete. Queue resumed.");
  }
}

function markAccountRunning(current) {
  const index = findAccountIndex(current);
  if (index === -1) {
    return;
  }

  state.accounts[index].queueStatus = "running";
  state.accounts[index].queueMessage = "Unfollowing now";
  state.accounts[index].justCompleted = false;
}

function markAccountDone(result) {
  const index = findAccountIndex(result);
  if (index === -1) {
    return;
  }

  state.accounts[index].queueStatus = result.ok ? "succeeded" : "failed";
  state.accounts[index].queueMessage = result.ok ? "Unfollowed" : result.error || result.response || "Unfollow failed";
  state.accounts[index].justCompleted = Boolean(result.ok);
  if (result.userId) {
    state.accounts[index].userId = result.userId;
  }

  if (result.ok) {
    window.setTimeout(() => {
      const currentIndex = findAccountIndex(result);
      if (currentIndex !== -1) {
        state.accounts[currentIndex].justCompleted = false;
      }
    }, 700);
  }
}

function clearRunningStates(message) {
  state.accounts = state.accounts.map((account) => {
    if (account.queueStatus !== "running" && account.queueStatus !== "queued") {
      return account;
    }

    return {
      ...account,
      queueStatus: "idle",
      queueMessage: message || ""
    };
  });
}

function findAccountIndex(candidate) {
  return state.accounts.findIndex((account) => {
    if (candidate.userId && account.userId && String(candidate.userId) === String(account.userId)) {
      return true;
    }

    return account.username.toLowerCase() === String(candidate.username || "").toLowerCase();
  });
}

function formatResult(result) {
  if (result.ok) {
    return result.route
      ? `Unfollowed @${result.username} (${result.route} route).`
      : `Unfollowed @${result.username}.`;
  }

  return `Failed @${result.username}: ${result.error || result.response || `HTTP ${result.status || "unknown"}`}`;
}

function updateStats() {
  const active = state.accounts.filter((account) => !account.removed && account.queueStatus !== "succeeded").length;
  const removed = state.accounts.filter((account) => account.removed).length;
  validCount.textContent = String(state.accounts.length);
  activeCount.textContent = String(active);
  removedCount.textContent = String(removed);
  updateButtons();
}

function updateProgress(label) {
  progressLabel.textContent = label;
  progressNumbers.textContent = `${state.progress.completed} / ${state.progress.total}`;
  const percent = state.progress.total ? Math.round((state.progress.completed / state.progress.total) * 100) : 0;
  progressBar.style.width = `${percent}%`;
}

function updateButtons() {
  const hasActiveAccounts = state.accounts.some((account) => !account.removed && account.queueStatus !== "succeeded");
  unfollowButton.disabled = !hasActiveAccounts || state.queueRunning;
  pauseButton.disabled = !state.queueRunning || state.queuePaused;
  resumeButton.disabled = !state.queueRunning || !state.queuePaused;
  cancelButton.disabled = !state.queueRunning;
  csvInput.disabled = state.queueRunning;
  delayInput.disabled = state.queueRunning;
}

function resetQueueState() {
  state.avatarBlobUrls.forEach((url) => URL.revokeObjectURL(url));
  state.avatarBlobUrls.clear();
  cleanupLookupPort();
  state.queueRunning = false;
  state.queuePaused = false;
  state.cooldownActive = false;
  state.progress = { completed: 0, total: 0, failed: 0 };
  cleanupPort();
  accountGrid.replaceChildren();
  activityLog.replaceChildren();
  failedCount.textContent = "0";
  hideCooldownTimer();
  updateProgress("No queue running");
}

function cleanupLookupPort() {
  if (state.lookupPort) {
    try {
      state.lookupPort.postMessage({ type: "CANCEL_PROFILE_LOOKUP" });
      state.lookupPort.disconnect();
    } catch (_error) {
      // The profile lookup port may already be closed by the service worker.
    }
    state.lookupPort = null;
  }
}

function cleanupPort() {
  if (state.port) {
    try {
      state.port.disconnect();
    } catch (_error) {
      // The port may already be disconnected by the service worker.
    }
    state.port = null;
  }
}

function addLog(message, kind = "info") {
  const item = document.createElement("li");
  const prefix = kind === "error" ? "Error" : kind === "success" ? "Done" : "Info";
  item.innerHTML = `<strong>${escapeHtml(prefix)}:</strong> ${escapeHtml(message)}`;
  activityLog.prepend(item);
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

function summarizeCardMessage(value) {
  const text = String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return "Profile lookup failed";
  }

  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}

function getSelectedDelayMs() {
  const seconds = Number(delayInput.value);
  const clampedSeconds = Math.min(10, Math.max(1, Number.isFinite(seconds) ? seconds : 1));
  delayInput.value = String(clampedSeconds);
  return clampedSeconds * 1000;
}

function showCooldownTimer(seconds) {
  cooldownValue.textContent = `${seconds}s`;
  cooldownTimer.hidden = false;
}

function hideCooldownTimer() {
  cooldownTimer.hidden = true;
  cooldownValue.textContent = "20s";
}

function getExcludedUsernames() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(EXCLUDED_USERNAMES_KEY) || "[]");
    return new Set((Array.isArray(stored) ? stored : []).map((username) => String(username).toLowerCase()));
  } catch (_error) {
    return new Set();
  }
}

function getProfileCache() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PROFILE_CACHE_KEY) || "{}");
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  } catch (_error) {
    return {};
  }
}

function saveProfileCache(cache) {
  window.localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(cache));
}

function clearProfileCache() {
  window.localStorage.removeItem(PROFILE_CACHE_KEY);
}

function applyCachedProfile(record, cache = getProfileCache()) {
  if (record.userId) {
    return record;
  }

  const cached = cache[record.username.toLowerCase()];
  if (!cached?.userId) {
    return record;
  }

  return {
    ...record,
    userId: cached.userId,
    fullName: record.fullName || cached.fullName || "",
    profilePicUrl: record.profilePicUrl || cached.profilePicUrl || "",
    cacheHit: true
  };
}

function cacheProfile(account) {
  if (!account?.username || !account?.userId) {
    return;
  }

  const cache = getProfileCache();
  cache[account.username.toLowerCase()] = {
    username: account.username,
    userId: String(account.userId),
    fullName: account.fullName || "",
    profilePicUrl: account.profilePicUrl || "",
    cachedAt: new Date().toISOString()
  };
  saveProfileCache(cache);
}

function saveExcludedUsernames(exclusions) {
  window.localStorage.setItem(EXCLUDED_USERNAMES_KEY, JSON.stringify(Array.from(exclusions).sort()));
}

function addExcludedUsername(username, options = {}) {
  const cleaned = cleanUsername(username);
  if (!cleaned) {
    return false;
  }

  const exclusions = getExcludedUsernames();
  if (exclusions.has(cleaned.toLowerCase())) {
    return false;
  }
  exclusions.add(cleaned.toLowerCase());
  saveExcludedUsernames(exclusions);
  if (options.record !== false) {
    state.lastExclusionAction = { type: "add", usernames: [cleaned.toLowerCase()] };
    updateUndoButton();
  }
  return true;
}

function clearExcludedUsernames(options = {}) {
  const existing = Array.from(getExcludedUsernames());
  window.localStorage.removeItem(EXCLUDED_USERNAMES_KEY);
  if (options.record !== false && existing.length) {
    state.lastExclusionAction = { type: "clear", usernames: existing };
    updateUndoButton();
  }
}

function openExclusionsEditor() {
  renderExclusionsEditor();
  exclusionsModal.hidden = false;
  exclusionInput.focus();
}

function closeExclusionsEditor() {
  exclusionsModal.hidden = true;
  exclusionInput.value = "";
}

function addExclusionFromEditor(event) {
  event.preventDefault();
  const cleaned = cleanUsername(exclusionInput.value);
  if (!cleaned) {
    addLog("Enter a valid Instagram username before adding an exclusion.", "error");
    return;
  }

  if (!addExcludedUsername(cleaned)) {
    addLog(`@${cleaned} is already excluded.`);
    return;
  }
  exclusionInput.value = "";
  renderExclusionsEditor();
  addLog(`Saved @${cleaned} as an exclusion.`);
}

function removeExcludedUsername(username, options = {}) {
  const exclusions = getExcludedUsernames();
  const normalized = String(username).toLowerCase();
  if (!exclusions.delete(normalized)) {
    return false;
  }
  saveExcludedUsernames(exclusions);
  if (options.record !== false) {
    state.lastExclusionAction = { type: "remove", usernames: [normalized] };
    updateUndoButton();
  }
  return true;
}

function clearExclusionsFromEditor() {
  const exclusions = getExcludedUsernames();
  if (!exclusions.size) {
    return;
  }

  const confirmed = window.confirm(`Clear all ${exclusions.size} saved exclusions?`);
  if (!confirmed) {
    return;
  }

  clearExcludedUsernames();
  renderExclusionsEditor();
  addLog("Cleared all saved exclusions.");
}

function exportExclusions() {
  const usernames = Array.from(getExcludedUsernames()).sort();
  if (!usernames.length) {
    addLog("There are no saved exclusions to export.", "error");
    return;
  }

  const payload = {
    type: "instaclean-exclusions",
    version: 1,
    exportedAt: new Date().toISOString(),
    usernames
  };

  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `instaclean-exclusions-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  addLog(`Exported ${usernames.length} exclusion${usernames.length === 1 ? "" : "s"}.`, "success");
}

async function importExclusionsFromFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) {
    return;
  }

  let candidates;
  try {
    candidates = parseExclusionsFile(await file.text());
  } catch (error) {
    addLog(`Could not read ${file.name}: ${error.message}`, "error");
    return;
  }

  if (!candidates.length) {
    addLog(`No usernames found in ${file.name}.`, "error");
    return;
  }

  const added = [];
  let skipped = 0;
  candidates.forEach((username) => {
    if (addExcludedUsername(username, { record: false })) {
      added.push(username.toLowerCase());
    } else {
      skipped += 1;
    }
  });

  if (added.length) {
    state.lastExclusionAction = { type: "add", usernames: added };
    updateUndoButton();
  }

  renderExclusionsEditor();
  addLog(
    `Imported ${added.length} exclusion${added.length === 1 ? "" : "s"} from ${file.name}` +
    (skipped ? ` (${skipped} already saved or invalid).` : "."),
    added.length ? "success" : "info"
  );
}

// Accepts this tool's own JSON export, a bare JSON array, or a plain newline/comma list so a
// CSV of handles can be reused as an exclusion list without reformatting.
function parseExclusionsFile(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  let rawValues;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : parsed?.usernames;
    if (!Array.isArray(list)) {
      throw new Error('expected an array of usernames or a "usernames" array');
    }
    rawValues = list;
  } else {
    rawValues = trimmed.split(/[\r\n,]+/);
  }

  const seen = new Set();
  const usernames = [];
  rawValues.forEach((value) => {
    const cleaned = cleanUsername(String(value ?? ""));
    const key = cleaned.toLowerCase();
    if (cleaned && !seen.has(key)) {
      seen.add(key);
      usernames.push(cleaned);
    }
  });
  return usernames;
}

// Keeps the loaded grid honest when the analyzer whitelists an account after auto-load.
function excludeAccount(username) {
  const cleaned = cleanUsername(String(username ?? ""));
  if (!cleaned) {
    return false;
  }

  const added = addExcludedUsername(cleaned);
  const index = findAccountIndex({ username: cleaned });
  if (index !== -1 && !state.accounts[index].removed) {
    state.accounts[index].removed = true;
    renderAccounts();
    updateStats();
  }

  if (!exclusionsModal.hidden) {
    renderExclusionsEditor();
  }
  return added;
}

function undoLastExclusionAction() {
  const action = state.lastExclusionAction;
  if (!action) {
    return;
  }

  if (action.type === "add") {
    action.usernames.forEach((username) => removeExcludedUsername(username, { record: false }));
    addLog(`Undid exclusion for ${formatUndoUsernames(action.usernames)}.`);
  } else if (action.type === "remove") {
    action.usernames.forEach((username) => addExcludedUsername(username, { record: false }));
    addLog(`Restored exclusion for ${formatUndoUsernames(action.usernames)}.`);
  } else if (action.type === "clear") {
    action.usernames.forEach((username) => addExcludedUsername(username, { record: false }));
    addLog(`Restored ${action.usernames.length} cleared exclusion${action.usernames.length === 1 ? "" : "s"}.`);
  }

  state.lastExclusionAction = null;
  updateUndoButton();
  if (!exclusionsModal.hidden) {
    renderExclusionsEditor();
  }
}

function updateUndoButton() {
  undoExclusionButton.disabled = !state.lastExclusionAction;
}

function formatUndoUsernames(usernames) {
  return usernames.length === 1 ? `@${usernames[0]}` : `${usernames.length} usernames`;
}

function clearProfileCacheFromEditor() {
  const cacheSize = Object.keys(getProfileCache()).length;
  if (!cacheSize) {
    addLog("Profile cache is already empty.");
    return;
  }

  const confirmed = window.confirm(`Clear ${cacheSize} cached profile${cacheSize === 1 ? "" : "s"}?`);
  if (!confirmed) {
    return;
  }

  clearProfileCache();
  addLog(`Cleared ${cacheSize} cached profile${cacheSize === 1 ? "" : "s"}.`);
}

function renderExclusionsEditor() {
  const exclusions = Array.from(getExcludedUsernames()).sort();
  exclusionCount.textContent = `${exclusions.length} saved exclusion${exclusions.length === 1 ? "" : "s"}`;
  clearExclusionsButton.disabled = exclusions.length === 0;
  exclusionsList.replaceChildren();

  if (!exclusions.length) {
    const empty = document.createElement("div");
    empty.className = "exclusions-empty";
    empty.textContent = "No saved exclusions yet.";
    exclusionsList.append(empty);
    return;
  }

  exclusions.forEach((username) => {
    const row = document.createElement("div");
    row.className = "exclusion-row";

    const label = document.createElement("span");
    label.textContent = `@${username}`;

    const removeButton = document.createElement("button");
    removeButton.className = "secondary-button";
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => {
      removeExcludedUsername(username);
      renderExclusionsEditor();
      addLog(`Removed @${username} from saved exclusions.`);
    });

    row.append(label, removeButton);
    exclusionsList.append(row);
  });
}

window.InstagramCsvUnfollow = {
  loadUsernamesIntoUnfollowGrid,
  excludeAccount
};

window.InstaCleanExclusions = {
  add: addExcludedUsername,
  clear: clearExcludedUsernames,
  get: getExcludedUsernames
};
