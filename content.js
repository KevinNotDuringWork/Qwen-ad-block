// content.js — runs inside every web page.
//
// Two layers:
//
//   1. RULES (no LLM). Markup that is unambiguously an ad — AdSense <ins>, Google
//      Publisher Tag slots, iframes from ad networks — is hidden directly.
//      This is cheap, precise, and covers most display ads.
//
//   2. LLM (only for the ambiguous stuff). Two kinds of "suspects" are sent to
//      the model, which decides whether each is really an ad:
//        - elements whose class/id contains an ad *word* (token, not substring:
//          "ad-slot" yes, "header"/"download"/"shadow" no)
//        - "cards" that contain a small standalone label like "Sponsored" or
//          "Promoted" (native ads in feeds — where rules are weakest)
//      Each suspect is described using only ITS OWN signals. Ancestors are never
//      sent, so one ad inside a column can't make the whole column look like an ad.
//
// Dynamic content: a MutationObserver (nodes, attributes, text), a ResizeObserver
// for slots that are still 0×0, iframe/img load events, and scrolling all trigger a
// throttled rescan. Elements are re-checked when their signature changes (e.g. an
// empty placeholder that later gets filled).

const HIGHLIGHT_ONLY = false;  // true = outline (debug), false = actually hide
const CHUNK_SIZE = 20;        // suspects per LLM request
const MIN_AREA = 2000;        // ignore tiny elements (px²)
const MAX_VIEWPORT_FRACTION = 0.6; // never treat something this big as one ad

const TAG = "[AI Ad Silencer]";

// --- Layer 1: rules ---------------------------------------------------------

const SURE_AD_SELECTORS = [
  "ins.adsbygoogle",
  "[data-ad-slot]",
  "[data-ad-client]",
  "[data-google-query-id]",       // set by Google Publisher Tag on filled slots
  "div[id^='div-gpt-ad']",
  "iframe[id^='google_ads_iframe']",
  "amp-ad",
  "[aria-label='Advertisement' i]",
].join(",");

const AD_HOSTS = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.[a-z.]+|amazon-adsystem\.com|adnxs\.com|taboola\.com|outbrain\.com|criteo\.(com|net)|pubmatic\.com|rubiconproject\.com|openx\.net|media\.net|adsrvr\.org|moatads\.com|teads\.tv|smartadserver\.com|3lift\.com|yieldmo\.com|sharethrough\.com)$/i;

// --- Layer 2: suspects ------------------------------------------------------

// Whole tokens only. Class/id are split on non-alphanumerics and camelCase.
const AD_TOKENS = new Set([
  "ad", "ads", "advert", "adverts", "advertisement", "advertisements", "advertising",
  "adslot", "adunit", "adbox", "adcontainer", "adwrapper", "dfp",
  "sponsor", "sponsored", "sponsorship", "promoted",
]);

// A short text node that is *only* an ad label.
const AD_LABEL = /^(ad|ads|advertisement|advertising|sponsored|sponsored (content|post|links?)|promoted|paid (partnership|content|post)|anzeige|publicité|publicidad)\s*[·•:|-]?\s*$/i;

// Elements that are page structure, never "an ad".
const STRUCTURAL = new Set(["HTML", "BODY", "MAIN", "HEADER", "NAV", "FOOTER"]);

// --- Helpers ----------------------------------------------------------------

function hostOf(url) {
  try { return new URL(url, location.href).hostname; } catch { return null; }
}

function area(el) {
  const r = el.getBoundingClientRect();
  return r.width * r.height;
}

function tooBig(el) {
  return area(el) > innerWidth * innerHeight * MAX_VIEWPORT_FRACTION;
}

function shortName(el) {
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  if (typeof el.className === "string" && el.className.trim()) {
    s += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
  }
  return s.slice(0, 50);
}

function adTokens(el) {
  const cls = typeof el.className === "string" ? el.className : "";
  return `${el.id} ${cls}`
    .split(/[^a-zA-Z0-9]+|(?<=[a-z])(?=[A-Z])/)
    .map((t) => t.toLowerCase())
    .filter((t) => AD_TOKENS.has(t));
}

function isHandled(el) {
  return !!el.closest("[data-llm-ad]");
}

// --- Hiding -----------------------------------------------------------------

// Climb from an ad to the box that visually wraps it: parents that hold nothing
// but this element (plus maybe an "Advertisement" label) and aren't much bigger.
function expandToContainer(el) {
  let cur = el;
  for (let depth = 0; depth < 6; depth++) {
    const p = cur.parentElement;
    if (!p || STRUCTURAL.has(p.tagName)) break;

    const otherText = (p.innerText || "")
      .replace(cur.innerText || "", "")
      .replace(/\s+/g, " ")
      .trim();
    const onlyAdStuff = otherText === "" || AD_LABEL.test(otherText);
    const ratio = area(p) / Math.max(area(cur), 1);
    const sizeOk = ratio <= (otherText ? 2.5 : 1.6);

    if (!onlyAdStuff || !sizeOk || tooBig(p)) break;
    cur = p;
  }
  return cur;
}

const DONE = '[data-llm-ad="rule"], [data-llm-ad="llm"]';

function hide(el, source, reason) {
  if (el.closest(DONE)) return; // already inside a hidden ad
  el.dataset.llmAd = source;

  // mute media elements
  const mediaElements = el.querySelectorAll('video, audio');
  mediaElements.forEach(media => {
    media.muted = true;
  });

  if (HIGHLIGHT_ONLY) {
    el.style.setProperty("outline", `3px solid ${source === "rule" ? "red" : "orange"}`, "important");
    el.style.setProperty("outline-offset", "-3px", "important");
  } else {
    // Fade out smoothly, then remove from layout.
    el.style.setProperty("transition", "opacity 0.3s ease-out", "important");
    el.style.setProperty("opacity", "0", "important");

    const finish = (e) => {
      if (e && e.target !== el) return;
      el.removeEventListener("transitionend", finish);
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
      el.style.removeProperty("transition");
      el.style.removeProperty("opacity");
    };
    el.addEventListener("transitionend", finish);
    setTimeout(finish, 600); // fallback if transition doesn't fire
  }
  console.log(`${TAG} hid (${source}: ${reason})`, el);
}

// --- Picking the container visually ----------------------------------------
// When something is confirmed as an ad, we don't hide it right away. We wait
// until it's on screen, then the background worker screenshots it plus a few
// ancestors (numbered outlines) and the vision model picks the box that is the
// complete ad unit, e.g. the whole "Sponsored" card rather than just its image.

const MAX_BOXES = 4;
const pendingSource = new WeakMap(); // el -> { source, reason }
const picks = new Map();             // token -> { el, chain }
let nextToken = 0;

function sameBox(a, b) {
  return Math.abs(a.left - b.left) < 6 && Math.abs(a.top - b.top) < 6 &&
         Math.abs(a.right - b.right) < 6 && Math.abs(a.bottom - b.bottom) < 6;
}

// The element plus ancestors that are *visibly* different boxes, innermost first.
// Wrappers with the same box as their child are collapsed into the outer one.
function ancestorChain(el) {
  const chain = [el];
  let rect = el.getBoundingClientRect();
  for (let p = el.parentElement; p && chain.length < MAX_BOXES; p = p.parentElement) {
    if (STRUCTURAL.has(p.tagName) || tooBig(p)) break;
    const r = p.getBoundingClientRect();
    if (sameBox(r, rect)) chain[chain.length - 1] = p;
    else chain.push(p);
    rect = r;
  }
  return chain;
}

const waiting = new Set();         // confirmed ads waiting to be on screen
const notBefore = new WeakMap();   // el -> timestamp (retry cooldown)

// On screen enough to be judged: has a size, and at least half of it (or half
// the viewport, for very tall elements) is visible.
function visibleEnough(el) {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const visW = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
  const visH = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
  return visW > 0 && visH >= Math.min(r.height, innerHeight) * 0.5;
}

function markAd(el, source, reason) {
  if (isHandled(el)) return; // already hidden or pending
  el.dataset.llmAd = "pending";
  pendingSource.set(el, { source, reason });
  waiting.add(el);
  checkWaiting();
}

// Called on every scan (scroll, mutations, loads...) and when ads are confirmed.
function checkWaiting() {
  if (document.hidden) return; // screenshots need the tab visible
  const now = Date.now();
  for (const el of waiting) {
    if (!el.isConnected || el.parentElement?.closest(DONE)) { waiting.delete(el); continue; }
    if ((notBefore.get(el) ?? 0) > now || !visibleEnough(el)) continue;
    waiting.delete(el);
    requestPick(el);
  }
}

function retryLater(el) {
  notBefore.set(el, Date.now() + 1500);
  waiting.add(el);
  setTimeout(scheduleScan, 1600);
}

async function requestPick(el) {
  const { source, reason } = pendingSource.get(el) ?? { source: "llm", reason: "?" };

  const token = nextToken++;
  picks.set(token, { el, chain: null });
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "pickContainer", token });
  } catch (err) {
    res = { error: String(err) };
  }
  const { chain } = picks.get(token);
  picks.delete(token);

  if (res?.retry) { retryLater(el); return; } // scrolled away / tab not active
  if (res?.skip || !el.isConnected) return;

  if (chain && Number.isInteger(res?.index) && chain[res.index]) {
    hide(chain[res.index], source, `${reason}, box ${res.index + 1}/${chain.length}`);
  } else {
    if (res?.error) console.warn(TAG, "visual pick failed, using heuristic:", res.error);
    hide(expandToContainer(el), source, `${reason}, heuristic`);
  }
}

// The background asks for fresh measurements right before taking the screenshot.
chrome.runtime.onMessage?.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "measure") return;
  const entry = picks.get(msg.token);
  if (!entry || !entry.el.isConnected) return sendResponse(null);

  if (!visibleEnough(entry.el)) return sendResponse({ retry: true }); // scrolled away

  entry.chain = ancestorChain(entry.el);
  sendResponse({
    boxes: entry.chain.map((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    }),
    desc: entry.chain.map(shortName).join(" < "),
    vw: innerWidth,
    vh: innerHeight,
  });
});

// --- Layer 1 ----------------------------------------------------------------

function applyRules() {
  for (const el of document.querySelectorAll(SURE_AD_SELECTORS)) {
    if (!isHandled(el)) markAd(el, "rule", shortName(el));
  }
  for (const frame of document.querySelectorAll("iframe[src]")) {
    if (isHandled(frame)) continue;
    const host = hostOf(frame.src);
    if (host && AD_HOSTS.test(host)) markAd(frame, "rule", host);
  }
}

// --- Layer 2: collecting suspects ------------------------------------------

let nextId = 0;
const lastSig = new WeakMap(); // element -> signature it was last judged with

// Watches suspects that are too small *for now* (lazy slots, display:none).
const resizeWatcher = new ResizeObserver((entries) => {
  for (const e of entries) {
    if (e.contentRect.width * e.contentRect.height >= MIN_AREA) {
      resizeWatcher.unobserve(e.target);
      scheduleScan();
    }
  }
});

// The "card" a label belongs to: the nearest ancestor that is one of several
// similar siblings (a feed item), else the first reasonably-sized ancestor.
function findCard(labelEl) {
  let el = labelEl;
  for (let depth = 0; depth < 10; depth++) {
    const p = el.parentElement;
    if (!p || STRUCTURAL.has(p.tagName) || tooBig(p)) break;
    el = p;
    const siblings = p.parentElement ? [...p.parentElement.children] : [];
    const similar = siblings.filter((s) => s.tagName === p.tagName && s.className === p.className);
    if (similar.length >= 3 && area(p) >= MIN_AREA) return p;
  }
  // Fallback: first ancestor of at least ~300×130 px.
  el = labelEl.parentElement;
  for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
    if (STRUCTURAL.has(el.tagName) || tooBig(el)) return null;
    if (area(el) >= 40000) return el;
  }
  return null;
}

function collectSuspects() {
  const suspects = new Map(); // element -> why

  // a) Class/id contains an ad token.
  for (const el of document.querySelectorAll("[class], [id]")) {
    if (STRUCTURAL.has(el.tagName) || isHandled(el)) continue;
    const tokens = adTokens(el);
    if (tokens.length) suspects.set(el, `class-name:${tokens.join(",")}`);
  }

  // b) Cards containing a standalone ad label.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode()); ) {
    const text = node.nodeValue.trim();
    if (!text || text.length > 30 || !AD_LABEL.test(text)) continue;
    const labelEl = node.parentElement;
    if (!labelEl || isHandled(labelEl)) continue;
    const card = findCard(labelEl);
    if (card && !isHandled(card)) suspects.set(card, `label:"${text}"`);
  }

  // Keep only the outermost suspect in each nest — but drop ones too big to be an ad.
  const result = [];
  for (const [el, why] of suspects) {
    if (tooBig(el)) continue;
    let p = el.parentElement, nested = false;
    while (p) {
      if (suspects.has(p) && !tooBig(p)) { nested = true; break; }
      p = p.parentElement;
    }
    if (nested) continue;

    if (area(el) < MIN_AREA) {        // not rendered yet — check again when it grows
      resizeWatcher.observe(el);
      continue;
    }
    result.push({ el, why });
  }
  return result;
}

function describe(el, id, why) {
  const parts = [`[${id}] <${el.tagName.toLowerCase()}`];
  if (el.id) parts.push(`id="${el.id.slice(0, 40)}"`);
  if (typeof el.className === "string" && el.className.trim()) {
    parts.push(`class="${el.className.trim().slice(0, 60)}"`);
  }
  parts.push(`why=${why}`);
  if (el.parentElement) parts.push(`in=${shortName(el.parentElement)}`);

  const links = new Set();
  for (const a of el.querySelectorAll("a[href]")) {
    const h = hostOf(a.getAttribute("href"));
    if (h && h !== location.hostname) links.add(h);
    if (links.size >= 2) break;
  }
  if (links.size) parts.push(`links=${[...links].join(",")}`);

  const text = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80);
  parts.push(text ? `text="${text}"` : "empty");
  return parts.join(" ") + ">";
}

// Changes when the element's content changes, so a filled placeholder is re-judged.
function signature(el, why) {
  return `${why}|${el.className}|${el.childElementCount}|${(el.innerText || "").slice(0, 80)}`;
}

// --- Layer 2: asking the LLM -----------------------------------------------

const queue = []; // { id, line }
let working = false;

function enqueueSuspects() {
  let added = 0;
  for (const { el, why } of collectSuspects()) {
    const sig = signature(el, why);
    if (lastSig.get(el) === sig) continue; // already judged in this state
    lastSig.set(el, sig);

    if (!el.dataset.llmId) el.dataset.llmId = String(nextId++);
    queue.push({ id: el.dataset.llmId, line: describe(el, el.dataset.llmId, why) });
    added++;
  }
  if (added) console.log(`${TAG} ${added} new suspects queued (${queue.length} waiting)`);
  if (!working) drainQueue();
}

// Short summary of what the page is about, so the model can notice elements that
// don't fit the page's topic. Read on every request because SPAs change the title.
function pageContext() {
  const clean = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
  return {
    host: location.hostname,
    title: clean(document.title, 120),
    description: clean(meta?.getAttribute("content"), 160)
  };
}

async function drainQueue() {
  working = true;
  try {
    // Requests run one after another so the laptop's LLM isn't overloaded.
    while (queue.length) {
      const part = queue.splice(0, CHUNK_SIZE);
      const response = await chrome.runtime.sendMessage({
        type: "classify",
        lines: part.map((p) => p.line),
        page: pageContext()
      });
      if (response?.error) {
        console.warn(TAG, response.error);
        continue;
      }
      const allowed = new Set(part.map((p) => p.id));
      for (const id of response.adIds) {
        if (!allowed.has(String(id))) continue; // model must only pick from this chunk
        const el = document.querySelector(`[data-llm-id="${Number(id)}"]`);
        if (el && el.isConnected) markAd(el, "llm", `id ${id}`);
      }
    }
  } catch (err) {
    console.warn(TAG, err);
  } finally {
    working = false;
  }
}

// --- Scanning & triggers ----------------------------------------------------

function scan() {
  applyRules();      // instant
  enqueueSuspects(); // async, queued
  checkWaiting();    // confirmed ads that are now on screen -> pick container
}

// Throttled debounce: waits for a quiet 500 ms, but never longer than 2 s, so
// pages that change constantly (carousels, timers, infinite scroll) still get scanned.
let debounceTimer = null;
let firstRequest = 0;
function scheduleScan() {
  const now = Date.now();
  if (!debounceTimer) firstRequest = now;
  clearTimeout(debounceTimer);
  const wait = Math.max(0, Math.min(500, firstRequest + 2000 - now));
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    scan();
  }, wait);
}

new MutationObserver((mutations) => {
  // Ignore attribute changes we made ourselves (data-llm-*, our outline/visibility).
  const relevant = mutations.some((m) =>
    m.type !== "attributes" || !(m.target instanceof Element) || !m.target.hasAttribute("data-llm-ad"));
  if (relevant) scheduleScan();
}).observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,                                   // labels set via text changes
  attributes: true,
  attributeFilter: ["class", "id", "style", "hidden", "src"], // slots revealed / filled
});

// Ad iframes/images often get their size only once loaded ("load" doesn't bubble,
// but it can be caught in the capture phase).
document.addEventListener("load", (e) => {
  if (e.target instanceof HTMLIFrameElement || e.target instanceof HTMLImageElement) scheduleScan();
}, true);

// Lazy loaders often key off scrolling; a cheap safety net.
addEventListener("scroll", scheduleScan, { passive: true });

// Pending ads in a background tab get resolved once you switch to it.
document.addEventListener("visibilitychange", scheduleScan);

scan();
