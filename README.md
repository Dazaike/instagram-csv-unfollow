# InstaClean

![version](https://img.shields.io/badge/version-4.32-35d49c) ![manifest](https://img.shields.io/badge/manifest-v3-blue) ![browser](https://img.shields.io/badge/chrome-unpacked-lightgrey)

Every other "mass unfollow" tool lies to you. It fires a request, Instagram answers `200 OK`, the tool paints a green checkmark, and you are still following all 1,279 people. This repository is the result of refusing to accept that.

InstaClean is a Chrome extension that audits who doesn't follow you back and unfollows them **only when it can prove the unfollow actually happened.**

`zero-fluff` `no fake checkmarks` `receipts or it didn't happen`

---

## The part that matters

Instagram's `friendships/destroy` endpoint will happily return `HTTP 200 {"status":"ok"}` while doing absolutely nothing. Trusting that response is why every naive unfollow script reports flawless success and changes nothing.

InstaClean does not trust it. After every unfollow attempt it re-reads the relationship from `GET /api/v1/friendships/show/{id}/`, which returns an unambiguous boolean:

```json
{ "blocking": false, "followed_by": false, "following": true, "status": "ok" }
```

The verdict rules, in plain terms:

| What the check says | Verdict |
|---|---|
| `following: false`, explicitly | success. marked done. |
| `following: true`, explicitly | not done. cooldown, then one retry. |
| field missing / rate-limited / request failed | **unknown — never reported as success** |

That last row is the whole point. A missing field is not a "no." Treating absent data as success is exactly how `Boolean(undefined) === false` turns a dead unfollow into a green checkmark, and it is a bug this project has already been burned by and fixed.

**If InstaClean cannot prove it worked, it tells you it failed and prints the HTTP status and response body per route.** You get diagnostics instead of comfortable lies.

### Requests come from a real tab, not the extension

A `fetch()` from a background service worker carries `Origin: chrome-extension://<id>`. Mutating Instagram endpoints treat that as garbage. Every request is therefore executed inside a genuine `instagram.com` tab via `chrome.scripting.executeScript`, so it carries the page's real `Origin`, `Sec-Fetch-Site: same-origin`, and cookies — indistinguishable from you clicking the button yourself.

### It also stops wasting your time

Instagram exposes more than one unfollow route and rotates which ones it honours. InstaClean tries them in order, verifies each, and then **remembers which one worked** for the rest of the session. A dead route costs one wasted request per session, not one per account.

The verification read is immediate — a successful unfollow is visible instantly, so the happy path pays **no** artificial delay. Only a "still following" answer costs a single 600 ms re-check, to rule out replication lag before declaring a soft block.

---

## Install

No store listing. Load it unpacked like an adult.

1. Download `instaclean-v4.32.zip` from [Releases](../../releases) and extract it, or clone this repo.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the folder.
5. Be logged into `instagram.com` in the same Chrome profile. The extension reads your existing session cookies; it never asks for your password, because it does not want your password.

Click the toolbar icon to open the dashboard.

---

## How you actually use it

**Path A — let it find the freeloaders:**

Hit **Run Analysis**. It walks your followers and following lists, works out who doesn't follow you back, and loads those accounts straight into the review grid. No intermediate "now click this other button" step, because that step was pointless and has been deleted.

**Path B — bring your own list:**

Upload a CSV of handles. Blank cells, duplicates, and malformed handles are stripped before you see anything.

Then review the grid, dismiss anyone you want to keep, and run the queue:

- **Unfollow All** — works the whole list with pacing
- **Manual unfollow** — single account, per card
- **Pause / Resume / Cancel** — mid-queue, honoured between requests
- **Delay** — 1–10 s between accounts, your call
- Automatic 20 s cooldown every 35 successful unfollows, and a 60 s cooldown plus one retry whenever a soft block is detected

Everything lands in the Activity Log with the actual reason for every outcome.

---

## Exclusions

An account you dismiss is remembered permanently and filtered out of every future import. Because re-dismissing the same 40 people every week is not a workflow.

- **Add** handles manually in the exclusions editor
- **Export** to `instaclean-exclusions-YYYY-MM-DD.json`
- **Import** merges into your existing list — it never wipes it
- **Undo Exclusion** reverses the last action, including a whole bulk import
- Whitelisting in the analyzer also drops the account from the loaded grid, so the two can't disagree

Import accepts three formats, because demanding one specific shape would be obnoxious:

```json
{ "type": "instaclean-exclusions", "version": 1, "usernames": ["alice", "bob"] }
```
```json
["alice", "@bob"]
```
```text
alice
@bob
carol, dave
```

Handles are `@`-stripped, lowercased, deduplicated, and validated. URLs and malformed handles are rejected rather than silently stored as garbage.

---

## Permissions, justified

Four permissions. Each one earns its place.

| Permission | Why it exists |
|---|---|
| `cookies` | Reads `csrftoken` and `ds_user_id` from your existing session. Nothing else. |
| `storage` | Saves exclusions and the profile cache locally. |
| `scripting` | Runs requests inside a real Instagram tab so they carry a valid `Origin`. Non-negotiable — see above. |
| `host_permissions` | `instagram.com` and its CDNs, for API calls and avatar images. |

No analytics. No telemetry. No remote server. Nothing leaves your browser except requests to Instagram itself. There is no backend to leak your data because there is no backend.

---

## Known limitations

Anti-hype section. Read it.

- **Instagram can throttle you regardless of how correct this code is.** Action blocks are enforced server-side. If Instagram has flagged your account, no client can unfollow anything, and InstaClean will correctly report failures instead of pretending otherwise. Wait it out.
- **Sanity check before blaming the extension:** unfollow one account manually through Instagram's own UI. If that silently reverts too, you are action-blocked and the extension is not your problem.
- **Internal endpoints are not a stable contract.** These routes are undocumented and Instagram changes them. When that happens, the verification layer means you get an honest failure with diagnostics rather than a silent no-op.
- **Pace yourself.** The defaults are deliberately unhurried. Cranking the delay to 1 s and queueing 800 accounts is how you get rate-limited.
- Not affiliated with, endorsed by, or tolerated by Instagram or Meta. Automating your account may violate their Terms of Service. Your account, your decision, your consequences.

---

## Layout

```
manifest.json    MV3 manifest, permissions, service worker registration
background.js    unfollow queue, route chain, follow-state verification, session/cookies
review.html      dashboard markup
review.js        review grid, queue UI, exclusions, import/export, activity log
review.css       styling
analyzer.js      follower/following analysis, history snapshots, CSV export
icons/           extension icon
```

Version lives in `manifest.json` and nowhere else, so it cannot drift out of sync with itself.

---

## Changelog

### 4.32
Release packaging: README, `.gitignore`, distributable ZIP.

### 4.31
- Removed the redundant **Send to Unfollow** button; analyzer results now load into the review grid automatically, on both fresh analysis and history-snapshot load.
- Added exclusion **Export** and **Import** (own JSON, bare JSON array, or newline/comma list), merge-not-overwrite, with single-action undo for bulk imports.
- Removed the unconditional 1.2 s delay in front of every verification read. The success path now adds no delay; only a "still following" answer costs one 600 ms re-check.
- The route proven to work is tried first for the rest of the session, so a dead route costs one wasted request per session instead of one per account.
- Analyzer whitelisting now propagates into the loaded grid.

### 4.30
Fixed the bug that made every unfollow report success while changing nothing. Follow-state verification previously read `friendship_status` from `web_profile_info`, a field that endpoint does not return — so `Boolean(undefined)` evaluated to `false`, which was interpreted as "confirmed not following." Verification now reads `friendships/show`, requires an explicit boolean, and treats missing or unreadable data as unknown rather than success.

### 4.29
Multi-route unfollow chain with per-route HTTP status and response-body diagnostics in the Activity Log.

### 4.28
Requests moved out of the background service worker and into a real Instagram tab via `chrome.scripting.executeScript`, so they carry a valid same-origin `Origin` instead of `chrome-extension://<id>`.

### 4.26 – 4.27
Soft-block detection, cooldown-and-retry handling, and `x-ig-www-claim` capture and replay.

---

## License

MIT. Do what you want. If it breaks your Instagram account, that was your call, not ours.
