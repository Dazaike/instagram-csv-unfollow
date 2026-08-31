const INSTAGRAM_WEB_ORIGIN = "https://www.instagram.com";
const WEB_PROFILE_ENDPOINT = `${INSTAGRAM_WEB_ORIGIN}/api/v1/users/web_profile_info/`;
const FRIENDSHIP_SHOW_ENDPOINT = `${INSTAGRAM_WEB_ORIGIN}/api/v1/friendships/show/`;
const IG_APP_ID = "936619743392459";
const DEFAULT_REQUEST_DELAY_MS = 1000;
const COOLDOWN_SUCCESS_INTERVAL = 35;
const COOLDOWN_MS = 20000;
const SOFT_BLOCK_COOLDOWN_MS = 60000;
// Only paid when a confirmation read reports the follow still in place, to rule out
// read-after-write lag before declaring a soft block. The success path pays nothing.
const CONFIRMATION_RECHECK_MS = 600;

let activeQueue = null;
let currentWwwClaim = "";
// Once a route is observed actually applying an unfollow, it is tried first for the rest of the
// session so the queue stops paying for a POST to a route Instagram no longer honours.
let preferredRouteLabel = null;

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("review.html") });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "RESOLVE_PROFILES") {
    resolveProfiles(message.usernames || [])
      .then((profiles) => sendResponse({ ok: true, profiles }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  if (message?.type === "GET_SESSION_STATUS") {
    getSession()
      .then((session) => sendResponse({
        ok: true,
        loggedIn: Boolean(session.csrfToken && session.viewerId),
        viewerId: session.viewerId
      }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "profile-lookup") {
    let cancelled = false;

    port.onMessage.addListener((message) => {
      if (message?.type === "START_PROFILE_LOOKUP") {
        streamProfileLookup(message.usernames || [], port, () => cancelled);
      }

      if (message?.type === "CANCEL_PROFILE_LOOKUP") {
        cancelled = true;
      }
    });

    port.onDisconnect.addListener(() => {
      cancelled = true;
    });
    return;
  }

  if (port.name !== "unfollow-queue") {
    return;
  }

  port.onMessage.addListener((message) => {
    if (message?.type === "START_UNFOLLOW") {
      if (activeQueue?.running) {
        port.postMessage({
          type: "QUEUE_ERROR",
          error: "Another unfollow queue is already running. Wait for it to finish before starting a new one."
        });
        return;
      }

      activeQueue = { running: true, paused: false, cancelRequested: false };
      runUnfollowQueue(message.accounts || [], port, activeQueue, message.options || {}).finally(() => {
        activeQueue.running = false;
        activeQueue = null;
      });
    }

    if (message?.type === "PAUSE_UNFOLLOW" && activeQueue) {
      activeQueue.paused = true;
      port.postMessage({ type: "QUEUE_PAUSED" });
    }

    if (message?.type === "RESUME_UNFOLLOW" && activeQueue) {
      activeQueue.paused = false;
      port.postMessage({ type: "QUEUE_RESUMED" });
    }

    if (message?.type === "CANCEL_UNFOLLOW" && activeQueue) {
      activeQueue.cancelRequested = true;
      activeQueue.paused = false;
    }
  });

  port.onDisconnect.addListener(() => {
    if (activeQueue) {
      activeQueue.cancelRequested = true;
    }
  });
});

async function resolveProfiles(usernames) {
  const uniqueUsernames = Array.from(new Set(usernames.map((username) => username.toLowerCase())));
  const profiles = [];

  for (const username of uniqueUsernames) {
    profiles.push(await resolveProfile(username));
  }

  return profiles;
}

async function streamProfileLookup(usernames, port, isCancelled) {
  const uniqueUsernames = Array.from(new Set(usernames.map((username) => username.toLowerCase())));
  let completed = 0;
  const total = uniqueUsernames.length;

  port.postMessage({ type: "PROFILE_LOOKUP_STARTED", total });

  for (const username of uniqueUsernames) {
    if (isCancelled()) {
      port.postMessage({ type: "PROFILE_LOOKUP_CANCELLED", completed, total });
      return;
    }

    const profile = await resolveProfile(username);
    completed += 1;
    port.postMessage({ type: "PROFILE_LOOKUP_ITEM", profile, completed, total });
  }

  port.postMessage({ type: "PROFILE_LOOKUP_COMPLETE", completed, total });
}

async function resolveProfile(username, tabId) {
  const url = `${WEB_PROFILE_ENDPOINT}?username=${encodeURIComponent(username)}`;
  const headers = {
    "Accept": "application/json",
    "X-ASBD-ID": "129477",
    "X-IG-App-ID": IG_APP_ID,
    "X-IG-WWW-Claim": currentWwwClaim || "0"
  };
  const init = { method: "GET", credentials: "include", headers };

  try {
    const fetchResult = tabId
      ? await pageFetch(tabId, url, init)
      : await backgroundFetch(url, init);

    if (fetchResult.error) {
      throw new Error(fetchResult.error);
    }

    captureWwwClaim(fetchResult.headers);
    const payload = parseBody(fetchResult.body);

    if (!fetchResult.ok) {
      return {
        username,
        ok: false,
        status: fetchResult.status,
        error: summarizePayload(payload, `Profile lookup failed with HTTP ${fetchResult.status}.`)
      };
    }

    const user = payload?.data?.user;
    if (!user?.id) {
      return {
        username,
        ok: false,
        status: fetchResult.status,
        error: "Profile lookup succeeded, but Instagram did not return a user ID."
      };
    }

    return {
      username: user.username || username,
      requestedUsername: username,
      ok: true,
      userId: user.id,
      fullName: user.full_name || "",
      profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url || "",
      isPrivate: Boolean(user.is_private),
      isVerified: Boolean(user.is_verified)
    };
  } catch (error) {
    return {
      username,
      ok: false,
      error: getErrorMessage(error)
    };
  }
}

async function runUnfollowQueue(accounts, port, queueState, options = {}) {
  const session = await getSession();
  if (!session.csrfToken || !session.viewerId) {
    port.postMessage({
      type: "QUEUE_ERROR",
      error: "Instagram session not found. Sign in at instagram.com, then reopen this review page and try again."
    });
    return;
  }

  let tabId;
  let createdTab = false;
  try {
    const tab = await getOrCreateInstagramTab();
    tabId = tab.tabId;
    createdTab = tab.created;
  } catch (error) {
    port.postMessage({
      type: "QUEUE_ERROR",
      error: `Could not open an Instagram browser tab to send unfollow requests from: ${getErrorMessage(error)}`
    });
    return;
  }

  const total = accounts.length;
  let completed = 0;
  let failed = 0;
  let successfulSinceCooldown = 0;
  const requestDelayMs = clampDelayMs(options.delayMs);
  const results = [];

  port.postMessage({ type: "QUEUE_STARTED", total });

  try {
    for (const account of accounts) {
      await waitWhilePaused(queueState, port, completed, failed, total);
      if (queueState.cancelRequested) {
        port.postMessage({ type: "QUEUE_CANCELLED", completed, failed, total, results });
        return;
      }

      const current = {
        username: account.username,
        userId: account.userId || null
      };

      port.postMessage({ type: "QUEUE_PROGRESS", phase: "running", current, completed, failed, total });

      let result;
      try {
        const userId = account.userId || (await resolveProfile(account.username, tabId)).userId;
        if (!userId) {
          throw new Error("No Instagram user ID available for this account.");
        }

        const targetAccount = { ...account, userId };
        result = await unfollowUser(targetAccount, session, tabId);

        if (!result.ok && result.softBlocked && !queueState.cancelRequested) {
          const cooledDown = await runCooldown(
            SOFT_BLOCK_COOLDOWN_MS,
            queueState,
            port,
            completed,
            failed,
            total,
            { reason: "soft-block", username: targetAccount.username }
          );
          if (cooledDown) {
            result = await unfollowUser(targetAccount, session, tabId);
          }
        }
      } catch (error) {
        result = {
          username: account.username,
          userId: account.userId || null,
          ok: false,
          error: getErrorMessage(error)
        };
      }

      completed += 1;
      if (!result.ok) {
        failed += 1;
      } else {
        successfulSinceCooldown += 1;
      }
      results.push(result);

      port.postMessage({
        type: "QUEUE_ITEM_DONE",
        result,
        completed,
        failed,
        total
      });

      const shouldCooldown = (
        completed < total &&
        !queueState.cancelRequested &&
        successfulSinceCooldown >= COOLDOWN_SUCCESS_INTERVAL
      );

      if (shouldCooldown) {
        successfulSinceCooldown = 0;
        const completedCooldown = await runCooldown(COOLDOWN_MS, queueState, port, completed, failed, total);
        if (!completedCooldown) {
          port.postMessage({ type: "QUEUE_CANCELLED", completed, failed, total, results });
          return;
        }
      }

      if (completed < total && !queueState.cancelRequested && !shouldCooldown) {
        const completedDelay = await controlledDelay(requestDelayMs, queueState, port, completed, failed, total);
        if (!completedDelay) {
          port.postMessage({ type: "QUEUE_CANCELLED", completed, failed, total, results });
          return;
        }
      }
    }

    port.postMessage({ type: "QUEUE_COMPLETE", completed, failed, total, results });
  } finally {
    if (createdTab) {
      chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

// Candidate unfollow routes, tried in order until the follow state is independently confirmed
// cleared. `/web/friendships/{id}/unfollow/` is the route instagram.com's own frontend calls;
// `/api/v1/friendships/destroy/{id}/` is the mobile/private-API route, which can answer
// HTTP 200 {"status":"ok"} on the web origin without actually applying the unfollow.
const UNFOLLOW_ROUTES = [
  {
    label: "web",
    buildUrl: (userId) => `${INSTAGRAM_WEB_ORIGIN}/web/friendships/${encodeURIComponent(userId)}/unfollow/`,
    buildBody: () => ""
  },
  {
    label: "api-v1",
    buildUrl: (userId) => `${INSTAGRAM_WEB_ORIGIN}/api/v1/friendships/destroy/${encodeURIComponent(userId)}/`,
    buildBody: (account, session) => {
      const form = new URLSearchParams();
      form.set("_csrftoken", session.csrfToken);
      form.set("_uid", session.viewerId);
      form.set("container_module", "profile");
      form.set("nav_chain", "");
      form.set("user_id", account.userId);
      return form.toString();
    }
  }
];

async function unfollowUser(account, session, tabId) {
  const attempts = [];

  for (const route of orderedRoutes()) {
    const url = route.buildUrl(account.userId);
    const init = {
      method: "POST",
      credentials: "include",
      headers: {
        "Accept": "*/*",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-ASBD-ID": "129477",
        "X-CSRFToken": session.csrfToken,
        "X-IG-App-ID": IG_APP_ID,
        "X-IG-WWW-Claim": currentWwwClaim || "0",
        "X-Instagram-AJAX": "1",
        "X-Requested-With": "XMLHttpRequest"
      },
      body: route.buildBody(account, session)
    };

    // Routed through a real Instagram tab (chrome.scripting.executeScript) so the request
    // carries the page's Origin/Sec-Fetch-Site/cookies rather than chrome-extension://<id>.
    const fetchResult = await pageFetch(tabId, url, init);
    if (fetchResult.error) {
      attempts.push({ route: route.label, status: 0, detail: fetchResult.error, confirmedFollowing: null });
      console.warn(`[InstaClean] ${account.username}: ${route.label} route transport error`, fetchResult.error);
      continue;
    }

    captureWwwClaim(fetchResult.headers);
    const payload = parseBody(fetchResult.body);
    const accepted = fetchResult.ok && !payload?.error && payload?.status !== "fail";

    // Never trust the response's own claim of success: Instagram answers 200/ok for routes it
    // silently declines to apply. Re-read the real follow state from friendships/show, which
    // returns a flat explicit `following` boolean.
    let followState = { known: false, following: null, detail: "not checked" };
    if (accepted) {
      followState = await confirmUnfollowApplied(account.userId, tabId, session);
    }

    const bodySnippet = typeof fetchResult.body === "string" ? fetchResult.body.slice(0, 300) : "";
    attempts.push({
      route: route.label,
      status: fetchResult.status,
      accepted,
      detail: summarizePayload(payload) || bodySnippet || "(empty body)",
      confirmedFollowing: followState.known ? followState.following : null,
      confirmDetail: followState.detail
    });
    console.info(
      `[InstaClean] ${account.username}: ${route.label} route -> HTTP ${fetchResult.status}, ` +
      `accepted=${accepted}, followStateKnown=${followState.known}, stillFollowing=${followState.following}, ` +
      `body=${bodySnippet || "(empty)"}, confirm=${followState.detail}`
    );

    if (accepted && followState.known && followState.following === false) {
      preferredRouteLabel = route.label;
      return {
        username: account.username,
        userId: account.userId,
        ok: true,
        status: fetchResult.status,
        softBlocked: false,
        route: route.label,
        attempts,
        response: `Unfollowed via the ${route.label} route (confirmed by friendships/show).`
      };
    }
  }

  const stillFollowing = attempts.some((attempt) => attempt.confirmedFollowing === true);
  const anyAccepted = attempts.some((attempt) => attempt.accepted);
  const diagnostic = attempts
    .map((attempt) => {
      const followNote = attempt.confirmedFollowing === true
        ? " (still following)"
        : attempt.accepted && attempt.confirmedFollowing === null
          ? ` (unverified: ${attempt.confirmDetail || "no follow-state read"})`
          : "";
      return `${attempt.route}: HTTP ${attempt.status}${followNote} — ${attempt.detail}`;
    })
    .join(" | ");

  let response;
  if (stillFollowing) {
    response = `Instagram accepted the unfollow but kept the follow in place on every route. ${diagnostic}`;
  } else if (anyAccepted) {
    response = `Unfollow was accepted but could not be confirmed, so it is not being marked done. ${diagnostic}`;
  } else {
    response = `Every unfollow route failed. ${diagnostic}`;
  }

  return {
    username: account.username,
    userId: account.userId,
    ok: false,
    status: attempts[attempts.length - 1]?.status ?? 0,
    softBlocked: stillFollowing,
    attempts,
    response
  };
}

// Tries the route already proven to work on this session first, so a route Instagram has
// stopped honouring costs one wasted POST per session instead of one per account.
function orderedRoutes() {
  if (!preferredRouteLabel) {
    return UNFOLLOW_ROUTES;
  }

  const preferred = UNFOLLOW_ROUTES.filter((route) => route.label === preferredRouteLabel);
  if (!preferred.length) {
    return UNFOLLOW_ROUTES;
  }

  return [...preferred, ...UNFOLLOW_ROUTES.filter((route) => route.label !== preferredRouteLabel)];
}

// Reads the follow state immediately: a successful unfollow is visible right away, so the
// common path pays no sleep at all. Only a "still following" answer — which may be
// read-after-write lag rather than a real soft block — costs one short re-check.
async function confirmUnfollowApplied(userId, tabId, session) {
  const first = await getFollowState(userId, tabId, session);
  if (!(first.known && first.following === true)) {
    return first;
  }

  await delay(CONFIRMATION_RECHECK_MS);
  return getFollowState(userId, tabId, session);
}

// Authoritative read of the viewer -> target follow relationship.
// `friendships/show/{id}/` returns a flat, explicit boolean:
//   {"blocking":false,"followed_by":false,"following":true,...,"status":"ok"}
// `web_profile_info` does NOT carry the viewer's follow state, so deriving it from that payload
// silently yielded `Boolean(undefined) === false` and reported unfollows that never happened.
// `known: false` means "could not determine" and MUST never be treated as "not following".
async function getFollowState(userId, tabId, session) {
  const url = `${FRIENDSHIP_SHOW_ENDPOINT}${encodeURIComponent(userId)}/`;
  const fetchResult = await pageFetch(tabId, url, {
    method: "GET",
    credentials: "include",
    headers: {
      "Accept": "*/*",
      "X-ASBD-ID": "129477",
      "X-CSRFToken": session.csrfToken,
      "X-IG-App-ID": IG_APP_ID,
      "X-IG-WWW-Claim": currentWwwClaim || "0",
      "X-Requested-With": "XMLHttpRequest"
    }
  });

  if (fetchResult.error) {
    return { known: false, following: null, detail: `transport error: ${fetchResult.error}` };
  }

  captureWwwClaim(fetchResult.headers);
  const payload = parseBody(fetchResult.body);

  if (!fetchResult.ok) {
    return {
      known: false,
      following: null,
      detail: summarizePayload(payload, `HTTP ${fetchResult.status}`)
    };
  }

  if (typeof payload?.following !== "boolean") {
    return {
      known: false,
      following: null,
      detail: `no boolean "following" field in response (${summarizePayload(payload, "empty body")})`
    };
  }

  return { known: true, following: payload.following, detail: `following=${payload.following}` };
}

async function getSession() {
  const [csrfCookie, viewerCookie] = await Promise.all([
    getCookie("csrftoken"),
    getCookie("ds_user_id")
  ]);

  return {
    csrfToken: csrfCookie?.value || "",
    viewerId: viewerCookie?.value || ""
  };
}

function getCookie(name) {
  return chrome.cookies.get({
    url: INSTAGRAM_WEB_ORIGIN,
    name
  });
}

function captureWwwClaim(headers) {
  const claim = headers.find(([key]) => key.toLowerCase() === "x-ig-set-www-claim")?.[1];
  if (claim) {
    currentWwwClaim = claim;
  }
}

function parseBody(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return text;
  }
}

async function backgroundFetch(url, init) {
  try {
    const response = await fetch(url, init);
    const body = await response.text();
    return { ok: response.ok, status: response.status, headers: Array.from(response.headers.entries()), body };
  } catch (error) {
    return { ok: false, status: 0, headers: [], body: "", error: getErrorMessage(error) };
  }
}

// Runs the fetch inside an actual Instagram tab instead of the background service worker.
// Mutating requests (e.g. friendships/destroy) sent directly from the service worker carry
// Origin: chrome-extension://<id> instead of https://www.instagram.com; Instagram silently
// accepts-but-ignores those while still returning HTTP 200, which is what made unfollows
// falsely report success. Executing the fetch inside the tab gives it the page's real Origin,
// Sec-Fetch-Site: same-origin, and cookie context, matching a genuine in-browser click.
async function pageFetch(tabId, url, init) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (fetchUrl, fetchInit) => {
      try {
        const response = await fetch(fetchUrl, fetchInit);
        const body = await response.text();
        return { ok: response.ok, status: response.status, headers: Array.from(response.headers.entries()), body };
      } catch (error) {
        return { ok: false, status: 0, headers: [], body: "", error: String(error?.message || error) };
      }
    },
    args: [url, init]
  });
  return result;
}

async function getOrCreateInstagramTab() {
  const matches = await chrome.tabs.query({ url: `${INSTAGRAM_WEB_ORIGIN}/*` });
  const existing = matches.find((tab) => typeof tab.id === "number");
  if (existing) {
    return { tabId: existing.id, created: false };
  }

  const tab = await chrome.tabs.create({ url: `${INSTAGRAM_WEB_ORIGIN}/`, active: false });
  await waitForTabComplete(tab.id);
  return { tabId: tab.id, created: true };
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for the Instagram tab to finish loading."));
    }, 20000);

    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function summarizePayload(payload, fallback = "") {
  if (!payload) {
    return fallback;
  }

  if (typeof payload === "string") {
    if (/<\/?[a-z][\s\S]*>/i.test(payload) || payload.trim().startsWith("<!DOCTYPE")) {
      return fallback || "Instagram returned an HTML error page instead of profile data.";
    }

    return stripHtml(payload).slice(0, 180) || fallback;
  }

  if (payload.message) {
    return String(payload.message);
  }

  if (payload.status) {
    return `Instagram returned status: ${payload.status}`;
  }

  try {
    return JSON.stringify(payload).slice(0, 180);
  } catch (_error) {
    return fallback || "Instagram returned an unreadable response.";
  }
}

function stripHtml(value) {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampDelayMs(delayMs) {
  const numericDelay = Number(delayMs);
  if (!Number.isFinite(numericDelay)) {
    return DEFAULT_REQUEST_DELAY_MS;
  }

  return Math.min(10000, Math.max(1000, numericDelay));
}

async function controlledDelay(ms, queueState, port, completed, failed, total) {
  const endAt = Date.now() + ms;
  while (Date.now() < endAt) {
    if (queueState.cancelRequested) {
      return false;
    }

    await waitWhilePaused(queueState, port, completed, failed, total);
    await delay(Math.min(250, endAt - Date.now()));
  }

  return !queueState.cancelRequested;
}

async function waitWhilePaused(queueState, port, completed, failed, total) {
  let announced = false;
  while (queueState.paused && !queueState.cancelRequested) {
    if (!announced) {
      port.postMessage({ type: "QUEUE_PAUSED", completed, failed, total });
      announced = true;
    }
    await delay(250);
  }

  if (announced && !queueState.cancelRequested) {
    port.postMessage({ type: "QUEUE_RESUMED", completed, failed, total });
  }
}

async function runCooldown(ms, queueState, port, completed, failed, total, meta = {}) {
  let remainingSeconds = Math.ceil(ms / 1000);
  port.postMessage({ type: "QUEUE_COOLDOWN_STARTED", remainingSeconds, completed, failed, total, ...meta });

  while (remainingSeconds > 0) {
    if (queueState.cancelRequested) {
      return false;
    }

    await waitWhilePaused(queueState, port, completed, failed, total);
    if (queueState.cancelRequested) {
      return false;
    }

    port.postMessage({ type: "QUEUE_COOLDOWN_TICK", remainingSeconds, completed, failed, total, ...meta });
    await delay(1000);
    remainingSeconds -= 1;
  }

  port.postMessage({ type: "QUEUE_COOLDOWN_ENDED", completed, failed, total, ...meta });
  return !queueState.cancelRequested;
}
