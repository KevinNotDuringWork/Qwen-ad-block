// background.js — the extension's service worker.
// Receives chunks of element descriptions and asks the local LLM (llamafile) which are ads.

// llamafile (v0.10+) embeds llama.cpp's server, which exposes an OpenAI-compatible API.
const LLAMAFILE_URL = "http://localhost:8080/v1/chat/completions";
// llamafile serves exactly one model (the one bundled in the file), so this name is
// only a placeholder required by the OpenAI request schema.
const MODEL = "qwen3.5";

// Constrain the model's output to exactly {"ad_ids": [int, ...]} via grammar-based sampling.
const AD_IDS_SCHEMA = {
  type: "object",
  properties: {
    ad_ids: { type: "array", items: { type: "integer" } }
  },
  required: ["ad_ids"],
  additionalProperties: false
};

// One line describing the page. The fields come from the page itself, so they are
// untrusted. Strip quotes/newlines and cap lengths so they can't break the format.
function pageLine(page) {
  const clean = (s, n) => String(s ?? "").replace(/[\s"]+/g, " ").trim().slice(0, n);
  const host = clean(page?.host, 80);
  if (!host) return "";
  const parts = [host];
  const title = clean(page.title, 120);
  const desc = clean(page.description, 160);
  if (title) parts.push(`title="${title}"`);
  if (desc) parts.push(`description="${desc}"`);
  return `
The page: ${parts.join(" ")}
Use this as a HINT only. An element whose text has nothing to do with the page's
topic is more likely an ad, but on-topic elements can be ads and off-topic ones
(e.g. "Trending", "Related stories") are often normal content. Never flag an
element for being off-topic alone.
`;
}

function buildPrompt(lines, page) {
  return `You check web page elements that MIGHT be advertisements.
Each line starts with a numeric id in brackets. Every element was pre-selected
because of one clue, and MANY ARE FALSE ALARMS. Only flag real ads.

Fields:
- why=class-name:...  its class/id contains an ad-related word
- why=label:"..."      it contains a small label such as "Sponsored" or "Ad"
- in=                 its parent element
- links=              domains (other than this page's) its links point to
- text=               start of its visible text (or "empty")

Flag an element when:
- it is an ad slot / ad container (e.g. class "ad-slot", "ad-container",
  "sponsored-post"), even if it is currently empty
- it is a feed item, card or box marked by its label as Sponsored / Promoted / Ad,
  especially if it links to another site

Do NOT flag:
- links or buttons like "Remove ads", "Go ad-free", "Advertise with us", "Ad choices"
- articles or text that merely talk about sponsors or advertising
- the site's own navigation, menus, cookie banners, or settings
- normal content whose class only coincidentally contains an ad word

Respond ONLY with JSON in this exact shape: {"ad_ids": [<numbers>]}
If there are no ads, respond {"ad_ids": []}.
${pageLine(page)}
Elements:
${lines.join("\n")}`;
}

const TAG = "[LLM Ad Silencer]";
console.log(TAG, "service worker started");

let requestCounter = 0;

async function classify(lines, tabInfo, page) {
  const reqId = ++requestCounter;
  const prompt = buildPrompt(lines, page);
  const started = performance.now();

  // console.groupCollapsed keeps the console tidy; click a group to expand it.
  console.groupCollapsed(`${TAG} #${reqId} ${lines.length} elements from ${tabInfo}`);
  console.log("prompt:\n" + prompt);
  console.groupEnd();

  const res = await fetch(LLAMAFILE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: {           // forces valid JSON matching our schema
        type: "json_schema",
        json_schema: { name: "ad_ids", schema: AD_IDS_SCHEMA }
      },
      // Qwen3.5 is a "thinking" model; skip the reasoning step for this simple
      // classification task, since it is much faster without it.
      chat_template_kwargs: { enable_thinking: false },
      stream: false,               // one response instead of a token stream
      temperature: 0               // deterministic = more consistent results
    })
  });
  if (!res.ok) throw new Error(`llamafile returned HTTP ${res.status}: ${await res.text()}`);

  const data = await res.json();          // { choices: [{ message: { content: "..." } }], ... }
  const content = data.choices?.[0]?.message?.content ?? "";
  const ms = Math.round(performance.now() - started);
  console.log(`${TAG} #${reqId} raw reply (${ms} ms):`, content);

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`#${reqId} model reply is not valid JSON: ${content.slice(0, 200)}`);
  }
  const ids = Array.isArray(parsed.ad_ids) ? parsed.ad_ids : [];
  const valid = ids.filter(Number.isInteger);   // never trust model output blindly

  // Show which lines were flagged, so you can judge the model's choices.
  const flagged = valid.map((id) => lines.find((l) => l.startsWith(`[${id}]`)) ?? `[${id}] (not in this chunk!)`);
  console.log(`${TAG} #${reqId} flagged ${valid.length}:`, flagged.length ? "\n" + flagged.join("\n") : "none");
  return valid;
}

// --- Visual container picking ---------------------------------------------
// The content script found an ad element. We screenshot the visible tab, crop to
// the element and a few of its ancestors, draw numbered outlines (1 = innermost),
// and let the vision model pick which box is the complete ad unit.

const BOX_COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231"];
const MAX_IMAGE_SIDE = 768;      // keeps image tokens (and latency) low
const CAPTURE_GAP_MS = 600;      // captureVisibleTab is limited to ~2 calls/second

let pickChain = Promise.resolve(); // serializes picks (one screenshot at a time)
let lastCapture = 0;

function enqueuePick(job) {
  const result = pickChain.then(job);
  pickChain = result.catch(() => {});
  return result;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// Crop the screenshot around the outermost box (+ margin) and draw the marks.
async function cropAndMark(screenshotUrl, m) {
  const bmp = await createImageBitmap(await (await fetch(screenshotUrl)).blob());
  const scale = bmp.width / m.vw; // screenshot px per CSS px (device pixel ratio)

  const outer = m.boxes[m.boxes.length - 1];
  const margin = 40;
  const ux = Math.max(0, outer.x - margin);
  const uy = Math.max(0, outer.y - margin);
  const uw = Math.min(m.vw, outer.x + outer.w + margin) - ux;
  const uh = Math.min(m.vh, outer.y + outer.h + margin) - uy;

  const k = Math.min(scale, MAX_IMAGE_SIDE / Math.max(uw, uh)); // output px per CSS px
  const canvas = new OffscreenCanvas(Math.round(uw * k), Math.round(uh * k));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, ux * scale, uy * scale, uw * scale, uh * scale, 0, 0, canvas.width, canvas.height);

  ctx.font = "bold 16px sans-serif";
  ctx.textBaseline = "top";
  m.boxes.forEach((b, i) => {
    const x = (b.x - ux) * k, y = (b.y - uy) * k;
    ctx.strokeStyle = BOX_COLORS[i];
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, b.w * k, b.h * k);
    // Number tag: above the box's top-left corner if there's room, shifted
    // sideways per box so nested boxes sharing a corner don't overlap.
    const lx = Math.max(0, x) + i * 24, ly = y >= 20 ? y - 20 : Math.max(0, y);
    ctx.fillStyle = BOX_COLORS[i];
    ctx.fillRect(lx, ly, 20, 20);
    ctx.fillStyle = "#fff";
    ctx.fillText(String(i + 1), lx + 5, ly + 2);
  });

  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return "data:image/jpeg;base64," + toBase64(await blob.arrayBuffer());
}

async function askVision(imageUrl, n, reqId) {
  const text = `This is a cropped screenshot of a web page. Colored numbered outlines mark ${n} nested boxes: box 1 is the innermost, each higher number contains the previous one.
Something inside box 1 was detected as an advertisement.
Which box is the COMPLETE ad unit: it should include everything belonging to the ad (its "Sponsored"/"Ad" label, advertiser name, image, headline, link and button), but NOTHING unrelated (other posts, articles, navigation).
Answer with JSON: {"box": <number>}`;

  const started = performance.now();
  const res = await fetch(LLAMAFILE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: imageUrl } },
        { type: "text", text }
      ] }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "pick", schema: {
          type: "object",
          properties: { box: { type: "integer", enum: [...Array(n)].map((_, i) => i + 1) } },
          required: ["box"],
          additionalProperties: false
        } }
      },
      chat_template_kwargs: { enable_thinking: false },
      stream: false,
      temperature: 0
    })
  });
  if (!res.ok) throw new Error(`llamafile returned HTTP ${res.status}: ${await res.text()}`);
  const content = (await res.json()).choices?.[0]?.message?.content ?? "";
  console.log(`${TAG} pick #${reqId} raw reply (${Math.round(performance.now() - started)} ms):`, content);

  const box = JSON.parse(content).box;
  if (!Number.isInteger(box) || box < 1 || box > n) throw new Error(`bad box: ${content}`);
  return box - 1; // index into the chain
}

async function pickContainer(tab, token) {
  const reqId = ++requestCounter;

  // Measure *now*, right before the screenshot, so the boxes match the pixels.
  const m = await chrome.tabs.sendMessage(tab.id, { type: "measure", token }, { frameId: 0 });
  if (!m || m.retry) return m ?? { skip: true };
  if (m.boxes.length === 1) return { index: 0 };

  const current = await chrome.tabs.get(tab.id);
  if (!current.active) return { retry: true }; // can only screenshot the visible tab

  const wait = lastCapture + CAPTURE_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const shot = await chrome.tabs.captureVisibleTab(current.windowId, { format: "png" });
  lastCapture = Date.now();

  const image = await cropAndMark(shot, m);
  // Shows the exact image sent to the model, right in the console.
  console.log(`${TAG} pick #${reqId}: ${m.boxes.length} boxes (${m.desc})\n%c `,
    `font-size:1px;padding:120px 160px;background:url(${image}) no-repeat center/contain`);

  return { index: await askVision(image, m.boxes.length, reqId) };
}

// --- Messages --------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "pickContainer") {
    enqueuePick(() => pickContainer(sender.tab, msg.token))
      .then(sendResponse)
      .catch((err) => {
        console.error(TAG, "pick failed:", err);
        sendResponse({ error: String(err) });
      });
    return true;
  }

  if (msg.type !== "classify") return;

  const tabInfo = sender.tab?.url ? new URL(sender.tab.url).hostname : "unknown tab";

  classify(msg.lines, tabInfo, msg.page)
    .then((adIds) => sendResponse({ adIds }))
    .catch((err) => {
      console.error(TAG, err);
      sendResponse({ error: String(err) });
    });

  return true; // tells Chrome we'll call sendResponse asynchronously
});
