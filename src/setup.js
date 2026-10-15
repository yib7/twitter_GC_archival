/* setup.js — first-run wizard logic. Talks to the local server's /api/*. */
(function () {
"use strict";

// Avatar color + initials helpers shared with the viewer (src/app.js) and the
// Node build live in ONE module, loaded as a <script> before this one
// (setup.html) — see src/shared-core.js. Avatars use the viewer's hue rule
// (hueVars) without the settings.colors override, which is viewer-only.
/* global GCAShared */
const { initials, hueVars } = GCAShared;
// a person's avatar here is the same hue the viewer gives them (the
// --p / --f pair of src/shared-core.js hueVars), not a separate palette.
function paintHue(el, id) { const h = hueVars(id); el.style.setProperty("--p", h.p); el.style.setProperty("--f", h.f); }
const hueStyle = (id) => { const h = hueVars(id); return `--p:${h.p};--f:${h.f}`; };
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
function fileToDataURL(f) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); }); }
// a phone photo is 3-12 MB, an avatar needs a few hundred pixels. Shrink
// every picked photo to at most 512 px on its long side (PNG stays PNG so
// transparency survives, anything else becomes JPEG) before it is previewed,
// kept or uploaded. Small images are kept exactly as picked; a file that isn't
// an image is passed through so the preview can say so.
const AVATAR_MAX = 512;
function shrinkImage(dataURL, type) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h || Math.max(w, h) <= AVATAR_MAX) { resolve(dataURL); return; }
      const k = AVATAR_MAX / Math.max(w, h);
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
      const g = c.getContext("2d");
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
      g.drawImage(img, 0, 0, c.width, c.height);
      const out = /^image\/(png|gif)$/i.test(type || "") ? "image/png" : "image/jpeg";
      try { resolve(c.toDataURL(out, 0.9)); } catch (e) { resolve(dataURL); }
    };
    img.onerror = () => resolve(dataURL);
    img.src = dataURL;
  });
}
async function pickedPhoto(f) { return shrinkImage(await fileToDataURL(f), f.type); }

/* ---- shared image preview/confirm ---------------------------------------- */
// Before any photo is committed (group or a person), show it big and ask
// "Is this image good?" — so a wrong or broken file is caught here, not after
// it's already assigned. Resolves true to use the image, false to discard.
let imgModal = null;
function confirmImage(dataURL) {
  return new Promise((resolve) => {
    if (!imgModal) {
      imgModal = document.createElement("div");
      imgModal.className = "su-modal";
      imgModal.setAttribute("role", "dialog");
      imgModal.setAttribute("aria-modal", "true");
      imgModal.setAttribute("aria-label", "Confirm photo");
      imgModal.innerHTML =
        '<div class="su-modal-box">' +
          '<div class="su-modal-title">Is this image good?</div>' +
          '<div class="su-modal-frame"><img alt="Selected photo preview" /></div>' +
          '<div class="su-modal-msg" hidden></div>' +
          '<div class="su-modal-actions">' +
            '<button class="btn ghost" data-act="cancel">Choose another…</button>' +
            '<button class="btn primary" data-act="ok">Use this photo</button>' +
          "</div>" +
        "</div>";
      document.body.appendChild(imgModal);
    }
    const img = $("img", imgModal), msg = $(".su-modal-msg", imgModal);
    const ok = $('[data-act="ok"]', imgModal), cancel = $('[data-act="cancel"]', imgModal);
    const opener = document.activeElement;

    function close(result) {
      imgModal.classList.remove("open");
      document.removeEventListener("keydown", onKey);
      img.onload = img.onerror = null;
      try { if (opener && opener.focus) opener.focus(); } catch (e) {}
      resolve(result);
    }
    function onKey(e) { if (e.key === "Escape") { e.preventDefault(); close(false); } }

    msg.hidden = true; msg.textContent = ""; ok.disabled = false;
    img.onerror = () => {
      img.removeAttribute("src"); ok.disabled = true;
      msg.hidden = false; msg.textContent = "That file isn't a valid image — choose another.";
    };
    img.onload = () => { ok.disabled = false; };
    img.src = dataURL;

    ok.onclick = () => close(true);
    cancel.onclick = () => close(false);
    imgModal.onclick = (e) => { if (e.target === imgModal) close(false); };
    document.addEventListener("keydown", onKey);

    imgModal.classList.add("open");
    ok.focus();
  });
}

/* ---- media lightbox ------------------------------------------------------ */
// Click a person's shared-media thumbnail to see it full-size — a better look at
// what it shows helps you recognize who they are. Closes on Escape, the × button,
// or a click on the backdrop.
function viewMedia(src, kind) {
  const lb = document.createElement("div");
  lb.className = "su-lightbox";
  lb.setAttribute("role", "dialog");
  lb.setAttribute("aria-modal", "true");
  lb.setAttribute("aria-label", "Media preview");
  const closeBtn = document.createElement("button");
  closeBtn.className = "su-lightbox-close"; closeBtn.setAttribute("aria-label", "Close"); closeBtn.textContent = "×";
  const media = kind === "vid" ? document.createElement("video") : document.createElement("img");
  media.src = src;
  if (kind === "vid") { media.controls = true; media.autoplay = true; media.setAttribute("playsinline", ""); }
  else { media.alt = "Enlarged shared media"; }
  lb.appendChild(closeBtn); lb.appendChild(media);

  const opener = document.activeElement;
  function close() { document.removeEventListener("keydown", onKey); lb.remove(); try { if (opener && opener.focus) opener.focus(); } catch (e) {} }
  function onKey(e) { if (e.key === "Escape") { e.preventDefault(); close(); } }
  closeBtn.onclick = close;
  lb.onclick = (e) => { if (e.target === lb) close(); };
  document.addEventListener("keydown", onKey);
  document.body.appendChild(lb);
  closeBtn.focus();
}

// Collected config, sent to /api/identity on finish.
//  - `gc` is per-group { convId: { name, photo } } — each group chat keeps its
//    own name + photo (the viewer shows the active group's).
//  - `names`/`pfps` stay keyed by user id (shared across groups: same person,
//    same name everywhere).
//  - `ignored` holds the ids of participants the user deleted.
const state = { me: null, names: {}, pfps: {}, ignored: {}, ignoredGroups: {}, gc: {}, group: "" };
// Display-only pfp paths ("personal_data/pfps/foo_pfp.jpg", relative to the
// project root — same shape as window.LOCAL_PFPS in app.js) loaded from a
// previous save, used ONLY to paint an avatar background on reopen. Kept
// separate from state.pfps, which holds fresh data-URLs that get decoded and
// written to disk server-side — a path string there would be posted back as
// if it were image data.
let savedPfpPaths = {};
// group photos from an earlier save, for display only — the server
// keeps a saved photo unless a new one is uploaded, so they're never re-sent.
let savedGcPhotos = {};
// What the last save (or the saved config, on reopen) already removed, so a
// save that removes MORE asks first.
const savedIgnored = { users: {}, groups: {} };
let PARTS = [];
let groups = [];          // [{ id, title, count }] from the build
let loadedGroup = null;   // which group's roster is currently rendered in #people
let built = false;
let step = 1;
// Resolves once loadStatus() has applied (or given up on) a prior save, so
// the People step never renders a roster before knowing what's already saved.
let statusReady = null;

// The per-group name+photo entry for the group currently being set up.
function gcEntry() {
  const g = state.group || "";
  // no "name" key until one is typed (or hydrated from the last save):
  // { name: "" } on Save used to wipe a group name saved in an earlier run.
  return state.gc[g] || (state.gc[g] = { photo: null });
}

// Fill both group <select>s and reveal them only when there's more than one group.
function renderGroupChoosers() {
  const opts = groups.map((g) => {
    const removed = state.ignoredGroups[String(g.id)] ? " — removed" : "";
    return `<option value="${escapeHtml(String(g.id))}">${escapeHtml(g.title || "Group " + String(g.id).slice(-4))} · ${Number(g.count).toLocaleString()}${removed}</option>`;
  }).join("");
  ["gc-group", "people-group"].forEach((id) => { const sel = $("#" + id); if (sel) { sel.innerHTML = opts; sel.value = state.group; } });
  const many = groups.length > 1;
  ["gc-grouprow", "people-grouprow"].forEach((id) => { const row = $("#" + id); if (row) row.hidden = !many; });
}

// Switch which group chat the wizard is setting up: keep both selectors in sync,
// reload step 2's name/photo fields, and force step 3 to re-fetch that roster.
function selectGroup(id) {
  state.group = String(id);
  ["#gc-group", "#people-group"].forEach((s) => { const el = $(s); if (el && el.value !== state.group) el.value = state.group; });
  refreshGroupStep();
  loadedGroup = null; PARTS = [];
  if (step === 3) loadParts();
}

// Reflect the selected group's saved name + photo in step 2's fields.
function refreshGroupStep() {
  const e = gcEntry();
  const removed = !!state.ignoredGroups[state.group];
  const nameEl = $("#gc-name"); if (nameEl) { nameEl.value = e.name || ""; nameEl.disabled = removed; }
  const pick = $("#gc-pick"); if (pick) pick.disabled = removed;
  const rm = $("#gc-remove"); if (rm) rm.checked = removed;
  const pane = $('.setup-pane[data-pane="2"]'); if (pane) pane.classList.toggle("group-removed", removed);
  const pv = $("#gc-preview");
  const photo = e.photo || savedGcPhotos[state.group];
  if (pv) {
    if (photo) { pv.textContent = ""; pv.style.backgroundImage = `url('${photo}')`; }
    else { pv.style.backgroundImage = ""; pv.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H8l-4 3z"/><path d="M8 9h8M8 12.5h5"/></svg>'; }
  }
}

/* ---- step navigation ----------------------------------------------------- */
function go(n) {
  step = n;
  $$(".setup-pane").forEach((p) => { const on = +p.dataset.pane === n; p.classList.toggle("active", on); p.hidden = !on; });
  $$("#steps li").forEach((li) => {
    const s = +li.dataset.step;
    li.classList.toggle("active", s === n);
    li.classList.toggle("done", s < n);
  });
  if (n === 3) loadParts();
  if (n === 4) renderFinishReceipt();
}

// Presentation-only summary card on the Finish step (mock-setup .receipt).
// Reads only state the wizard already holds: `groups` from the build, the
// active group's roster (PARTS, when step 3 loaded it), and saved names/pfps.
function renderFinishReceipt() {
  const host = $("#fin-receipt");
  if (!host) return;
  if (!groups.length) { host.hidden = true; return; }
  const kept = groups.filter((g) => !state.ignoredGroups[String(g.id)]);
  const removed = groups.length - kept.length;
  const total = kept.reduce((a, g) => a + Number(g.count || 0), 0);
  const g = groups.find((x) => String(x.id) === state.group) || groups[0];
  const e = state.gc[String(g.id)] || {};
  const nm = e.name || g.title || "Group " + String(g.id).slice(-4);
  const gcPhoto = e.photo || savedGcPhotos[String(g.id)];
  const markStyle = gcPhoto ? ` style="background-image:url('${gcPhoto}')"` : "";

  const keptParts = PARTS.filter((p) => !state.ignored[p.id]);
  const stack = keptParts.slice(0, 6).map((p) => {
    const pfp = state.pfps[p.id] || savedPfpPaths[p.id];
    const style = pfp
      ? `background-image:url('${pfp}')`
      : hueStyle(p.id);
    const txt = pfp ? "" : escapeHtml(initials(state.names[p.id] || "User " + String(p.id).slice(-4)));
    return `<span class="fr-av" style="${style}">${txt}</span>`;
  }).join("");
  const more = keptParts.length > 6 ? `<span class="fr-more">+${keptParts.length - 6} more</span>` : "";

  host.innerHTML =
    `<div class="fr-head"><span class="fr-mark"${markStyle}></span>` +
    `<div><div class="fr-name">${escapeHtml(nm)}</div>` +
    `<div class="fr-sub">${groups.length > 1 ? escapeHtml(String(kept.length)) + " group chats kept" : "group chat"}</div></div>` +
    `<span class="fr-tag">Ready</span></div>` +
    `<div class="fr-lines">` +
    `<div class="fr-line"><span class="rl">Messages</span><span class="rv blue">${total.toLocaleString()}</span></div>` +
    (keptParts.length ? `<div class="fr-line"><span class="rl">People</span><span class="rv">${keptParts.length}</span></div>` : "") +
    (removed ? `<div class="fr-line"><span class="rl">Groups excluded</span><span class="rv">${removed}</span></div>` : "") +
    `</div>` +
    (stack ? `<div class="fr-people">${stack}${more}</div>` : "");
  host.hidden = false;
}
$$("[data-next]").forEach((b) => b.onclick = () => {
  if (step === 1 && !built) { flash($("#src-result"), "Build the archive before continuing.", "err"); return; }
  go(Math.min(4, step + 1));
});
$$("[data-back]").forEach((b) => b.onclick = () => go(Math.max(1, step - 1)));

function flash(host, html, cls) { host.hidden = false; host.className = "setup-result " + (cls || ""); host.innerHTML = html; }

// The wizard needs the Node server (writing files / copying media / native
// dialogs all require it). Opened as a file://, every fetch fails with the
// cryptic "Failed to fetch" — so detect that and say exactly what to do.
const SERVED = location.protocol === "http:" || location.protocol === "https:";
function needServer(host) {
  const setupUrl = window.GCA_SERVER_URL
    ? window.GCA_SERVER_URL + "/setup.html"
    : "http://localhost:8765/setup.html";
  flash(host,
    "This page is open as a <b>local file</b>, but the setup wizard must run " +
    "<b>through the local server</b>. Start it and reopen this page there:" +
    "<br><br>1. <code>node scripts/server.js</code>" +
    "<br>2. open <code>" + setupUrl + "</code>", "err");
}
if (!SERVED) needServer($("#src-result"));

/* ---- step 1: native pickers + build -------------------------------------- */
async function pick(kind, fill, which) {
  if (!SERVED) { needServer($("#src-result")); return; }
  flash($("#src-result"), "Opening the file browser… (check for a dialog window)", "");
  try {
    const url = kind === "file" ? "/api/pick-file?for=" + (which || "group") : "/api/pick-folder" + (which === "root" ? "?for=root" : "");
    // the server only opens a dialog for a request carrying its token
    const r = await fetch(url, { headers: { "X-GCA-Token": String(window.GCA_TOKEN || "") } });
    // tell "refused" / "failed to open" apart from "not on Windows"
    if (r.status === 403) { flash($("#src-result"), "The server didn't accept this request — it may have been restarted. Reload this page and try again.", "err"); return; }
    const j = await r.json();
    if (j.error) { flash($("#src-result"), "✗ " + escapeHtml(j.error) + " Paste the full path into the box instead.", "err"); return; }
    if (!j.supported) { flash($("#src-result"), "The native file browser is only available on Windows — please paste the path instead.", "err"); return; }
    if (!j.path) { $("#src-result").hidden = true; return; }   // cancelled
    fill(j.path);
    $("#src-result").hidden = true;
  } catch (e) {
    flash($("#src-result"), "✗ " + escapeHtml(e.message) + " — is the server running? (node scripts/server.js)", "err");
  }
}
$("#group-browse").onclick = () => pick("file", (p) => { $("#src-group").value = p; hidePreflight(); }, "group");
$("#headers-browse").onclick = () => pick("file", (p) => { $("#src-headers").value = p; hidePreflight(); }, "headers");
$("#media-browse").onclick = () => pick("folder", (p) => { $("#src-media").value = p; hidePreflight(); });
$("#root-browse").onclick = () => pick("folder", (p) => { $("#src-root").value = p; hidePreflight(); }, "root");

/* ---- source lock + status ------------------------------------------------ */
// Once an archive is built, lock the source files so the user can't corrupt the
// archive by adding mismatched files — only "Start over" clears it.
function lockSource(locked) {
  ["#src-root", "#root-browse", "#src-group", "#src-headers", "#src-media", "#group-browse", "#headers-browse", "#media-browse", "#btn-build"]
    .forEach((s) => { const el = $(s); if (el) el.disabled = locked; });
  const banner = $("#src-locked"); if (banner) banner.hidden = !locked;
  if (locked) { merging = false; const m = $("#src-merge"); if (m) m.hidden = true; }
}
// "Add a newer export" — unlock the fields to pick a newer
// download; its preview shows what merging adds, and the build merges it into
// the archive (the existing data.js is the baseline; removals and identity stay).
let merging = false;
$("#src-add").onclick = () => {
  lockSource(false);
  merging = true;
  $("#src-merge").hidden = false;
  $("#src-result").hidden = true;
  $("#src-root").focus();
};
$("#src-add-cancel").onclick = () => {
  hidePreflight();
  $("#src-result").hidden = true;
  lockSource(true);
  $("#src-add").focus();
};
function loadStatus() {
  statusReady = (async () => {
    if (!SERVED) return;
    try {
      const r = await fetch("/api/status");
      const j = await r.json();
      // Prefill previously saved identity regardless of `built` — a reopened
      // wizard should show prior names/me/photos even before this run's build.
      state.me = j && j.me != null ? String(j.me) : null;
      state.names = Object.assign({}, j && j.names || {});
      savedPfpPaths = Object.assign({}, j && j.pfps || {});
      // group names (editable, and re-sent unchanged on Save) and photos
      // (display only) from the last save
      savedGcPhotos = {};
      const gc = j && j.gc && typeof j.gc === "object" ? j.gc : {};
      Object.keys(gc).forEach((cid) => {
        const e = gc[cid];
        if (cid === "__proto__" || !e || typeof e !== "object") return;
        const entry = state.gc[cid] || (state.gc[cid] = { photo: null });
        if (typeof e.name === "string" && entry.name == null) entry.name = e.name;
        if (typeof e.photo === "string" && e.photo) savedGcPhotos[cid] = e.photo;
      });
      if (j && j.built) {
        built = true;
        groups = j.groups || [];
        state.group = groups[0] ? String(groups[0].id) : "";
        (j.ignoredGroups || []).forEach((id) => { state.ignoredGroups[String(id)] = true; savedIgnored.groups[String(id)] = true; });
        // People removed in an earlier save stay removed —
        // without this, the next save sent ignoredUsers: [] and un-removed them.
        (j.ignoredUsers || []).forEach((id) => { state.ignored[String(id)] = true; savedIgnored.users[String(id)] = true; });
        renderGroupChoosers();
        refreshGroupStep();
        lockSource(true);
      }
    } catch (e) { /* no server / fresh setup — leave unlocked */ }
  })();
}

// The build's own output, one click away (collapsed so it never crowds the result).
function buildLogHtml(log) {
  const s = String(log || "").trim();
  return s ? `<details class="build-log"><summary>Build log</summary><pre>${escapeHtml(s)}</pre></details>` : "";
}

// Things the server fixed up on its own, so nothing is a surprise.
function buildNotesHtml(j) {
  const n = [];
  if (j.via === "manifest") n.push("Found your group chat files through the archive's <code>data/manifest.js</code>.");
  if (j.swapped) n.push("Your messages and headers files were picked the other way round — they were swapped back automatically.");
  if (j.mediaDescended) n.push(`Used the <code>${escapeHtml(j.mediaDescended)}</code> folder inside the folder you picked for media.`);
  (j.notes || []).forEach((x) => { if (x && x.text) n.push(escapeHtml(x.text)); });   // worded by the server
  return n.length ? `<ul class="build-notes">${n.map((l) => `<li>${l}</li>`).join("")}</ul>` : "";
}
// "Warning: …" lines from the build, plus skipped media, surfaced on success.
function buildWarningsHtml(j) {
  const w = String(j.log || "").split(/\r?\n/).filter((l) => /^Warning:/.test(l)).map((l) => l.replace(/^Warning:\s*/, ""));
  if (j.mediaUnmatched > 0) w.push(`${Number(j.mediaUnmatched).toLocaleString()} item(s) in the media folder weren't message photos or videos and were left out.`);
  return w.length ? `<ul class="build-warnings">${w.map((l) => `<li>Warning: ${escapeHtml(l)}</li>`).join("")}</ul>` : "";
}

let building = false;
// what the pre-flight preview was made for. Build sends exactly this, and
// any change to the fields drops it (the preview no longer describes them).
let pendingSource = null;
// What the preview allows: a build needs messages; an export older than the
// archive needs the extra confirm ticked first.
const pf = { canBuild: false, older: false };
function updateConfirm() {
  const ok = $("#pf-older-ok");
  $("#btn-confirm").disabled = !pf.canBuild || (pf.older && !(ok && ok.checked));
}
function hidePreflight() { pendingSource = null; const pf = $("#preflight"); if (pf) pf.hidden = true; }
["#src-root", "#src-group", "#src-headers", "#src-media"].forEach((s) => $(s).addEventListener("input", hidePreflight));
$("#pf-older-ok").onchange = updateConfirm;
$("#btn-pf-cancel").onclick = () => { hidePreflight(); $("#btn-build").focus(); };
const fmtDay = (ms) => (ms == null ? "?" : new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }));
const fmtSpan = (a, b) => (a == null ? "no dates" : fmtDay(a) === fmtDay(b) ? fmtDay(a) : fmtDay(a) + " – " + fmtDay(b));
function fmtBytes(n) {
  if (!(n > 0)) return "0 MB";
  if (n < 1024) return n + " B";
  return n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0) + " MB";
}
// while a build runs, ask the server how far the media
// copy is and show it — a big media folder used to look frozen for minutes.
function showProgress(p) {
  let html;
  if (p.phase === "copy" && p.totalFiles) {
    html = escapeHtml(`Copying photos & videos… ${Number(p.files).toLocaleString()} of ${plural(p.totalFiles, "file", "files")} (${fmtBytes(p.bytes)} of ${fmtBytes(p.totalBytes)})`) +
      `<progress class="build-progress" max="${Math.max(1, p.totalBytes || p.totalFiles)}" value="${p.totalBytes ? p.bytes : p.files}"></progress>`;
  } else if (p.phase === "build") html = "Building your archive… (big archives take a minute)";
  else html = "Copying your export…";
  flash($("#src-result"), html, "");
}
function watchProgress() {
  let stopped = false, timer = null;
  const tick = async () => {
    try {
      const p = await (await fetch("/api/progress")).json();
      if (!stopped && p && p.running) showProgress(p);
    } catch (e) { /* the build's own reply will say what happened */ }
    if (!stopped) timer = setTimeout(tick, 400);
  };
  timer = setTimeout(tick, 200);
  return () => { stopped = true; clearTimeout(timer); };
}
const VIA = { manifest: "Found through the archive's data/manifest.js", scan: "Found by file name in the archive folder", files: "The files you picked" };
function renderPreflight(j) {
  const t = j.totals || {}, m = j.merge, md = j.media;
  const merging = !!(m && !m.unreadable);
  $("#pf-title").textContent = merging ? "Add this export to your archive" : "Ready to build";
  const files = (j.files && j.files.messages || []).length;
  $("#pf-sub").textContent = (VIA[j.via] || VIA.files) + " · " + plural(files, "messages file", "messages files");
  const line = (label, value, blue) => `<div class="fr-line"><span class="rl">${escapeHtml(label)}</span><span class="rv${blue ? " blue" : ""}">${escapeHtml(value)}</span></div>`;
  let lines = line("Group chats", Number(t.groups || 0).toLocaleString()) +
    line("Messages", Number(t.messages || 0).toLocaleString(), true) +
    line("People", Number(t.participants || 0).toLocaleString()) +
    line("Dates", fmtSpan(t.first, t.last)) +
    line("Photos & videos", md ? Number(md.files).toLocaleString() + " (" + fmtBytes(md.bytes) + ")" : "none");
  if (merging) {
    lines += line("Already in your archive", plural(m.existingMsgs, "message", "messages")) +
      line("New messages to add", Number(m.added).toLocaleString(), true) +
      line("New group chats", Number(m.newGroups || 0).toLocaleString()) +
      (m.keptGroups ? line("Group chats kept from your archive", Number(m.keptGroups).toLocaleString()) : "");
  }
  $("#pf-lines").innerHTML = lines;
  $("#pf-groups").innerHTML = (j.groups || []).map((g) => {
    const name = g.title || "Group …" + String(g.id).slice(-4);
    if (g.removed) return `<li class="pf-removed"><b>${escapeHtml(name)}</b> — removed, stays out</li>`;
    return `<li><b>${escapeHtml(name)}</b> — ${plural(g.count, "message", "messages")} · ${escapeHtml(fmtSpan(g.first, g.last))} · ${plural(g.participants, "person", "people")}</li>`;
  }).join("");
  const w = j.warnings || [];
  $("#pf-warnings").innerHTML = w.length
    ? w.map((x) => `<li data-code="${escapeHtml(x.code)}">${escapeHtml(x.text)}</li>`).join("")
    : `<li class="pf-ok">✓ No problems found.</li>`;
  const confirm = $("#btn-confirm");
  confirm.textContent = merging ? "Merge into archive" : "Build archive";
  // no group messages, nothing to build or merge (a
  // merge whose messages are all removed ones still goes: they are kept aside)
  pf.canBuild = t.messages > 0 || (merging && w.some((x) => x.code === "removed"));
  pf.older = merging && w.some((x) => x.code === "older-export");
  $("#pf-older").hidden = !pf.older;
  // an export the archive already has is re-added, not "older"
  const olderThan = m && Number.isFinite(m.exportNewest) && Number.isFinite(m.archiveNewest) && m.exportNewest < m.archiveNewest;
  $("#pf-older-text").textContent = olderThan
    ? "This export is older than my archive — merge it anyway (my archive keeps its newer messages)"
    : "Re-add anyway (nothing new will be added)";
  $("#pf-older-ok").checked = false;
  updateConfirm();
  $("#preflight").hidden = false;
}
// Step 1, part 1: read the export and show what a build would bring in. Read-only.
$("#btn-build").onclick = async () => {
  if (!SERVED) { needServer($("#src-result")); return; }
  if (building) return;   // one request at a time (a double-click used to run two)
  const archiveRoot = $("#src-root").value.trim();
  const groupJs = $("#src-group").value.trim();
  const headersJs = $("#src-headers").value.trim();
  const mediaDir = $("#src-media").value.trim();
  if (!archiveRoot && !groupJs && !headersJs && !mediaDir) { flash($("#src-result"), "Choose your archive folder — or the three files below it.", "err"); return; }
  // an archive folder is enough: the server finds the three pieces inside it
  if (!archiveRoot) {
    if (!groupJs) { flash($("#src-result"), "Choose your direct-messages-group.js file.", "err"); return; }
    if (!headersJs) { flash($("#src-result"), "Choose your direct-message-group-headers.js file.", "err"); return; }
    if (!mediaDir) { flash($("#src-result"), "Choose your direct_messages_group_media folder — it's required.", "err"); return; }
  }
  const body = archiveRoot ? { archiveRoot } : { groupJs, headersJs, mediaDir };
  hidePreflight();
  flash($("#src-result"), "Checking your export… (nothing is copied yet)", "");
  building = true;
  $("#btn-build").disabled = true;
  try {
    const r = await fetch("/api/preflight", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) { flash($("#src-result"), "✗ " + escapeHtml(j.error || "The export couldn't be read."), "err"); return; }
    $("#src-result").hidden = true;
    renderPreflight(j);
    pendingSource = body;
    $("#btn-confirm").focus();
  } catch (e) {
    flash($("#src-result"), "✗ " + escapeHtml(e.message) + " — is the server running? (node scripts/server.js)", "err");
  } finally {
    building = false;
    if (!built || merging) $("#btn-build").disabled = false;
  }
};
// Step 1, part 2: the user saw the preview and confirmed — copy + build.
$("#btn-confirm").onclick = async () => {
  if (!SERVED) { needServer($("#src-result")); return; }
  if (building || !pendingSource) return;   // one build at a time
  const body = pendingSource;
  flash($("#src-result"), "Building… (copying media can take a moment)", "");
  building = true;
  $("#btn-build").disabled = true;
  $("#btn-confirm").disabled = true;
  const stopWatching = watchProgress();
  try {
    const r = await fetch("/api/source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).finally(stopWatching);
    const j = await r.json();
    // a failed build shows the server's plain-language sentence
    // plus the build log (collapsed), and leaves step 1 unlocked to fix it.
    if (!r.ok) { flash($("#src-result"), "✗ " + escapeHtml(j.error || "Build failed") + buildLogHtml(j.log), "err"); return; }
    built = true;
    groups = j.groups || [];
    state.group = groups[0] ? String(groups[0].id) : "";
    renderGroupChoosers();
    refreshGroupStep();
    const groupList = groups.map((g) => `<li>${escapeHtml(g.title || "Group " + String(g.id).slice(-4))} — ${Number(g.count).toLocaleString()} messages</li>`).join("");
    flash($("#src-result"),
      (j.merged
        ? `✓ Merged: <b>${Math.max(0, Number(j.added) || 0).toLocaleString()}</b> new messages added — your archive now has <b>${j.totalMsgs.toLocaleString()}</b> messages across <b>${groups.length}</b> group(s)`
        : `✓ Built <b>${j.totalMsgs.toLocaleString()}</b> messages across <b>${groups.length}</b> group(s)`) +
      (j.partFiles > 1 ? ` from <b>${Number(j.partFiles)}</b> message part files` : "") +
      (j.mediaCopied ? `, copied <b>${j.mediaCopied.toLocaleString()}</b> media files` : "") +
      `.<ul>${groupList}</ul>` + buildNotesHtml(j) + buildWarningsHtml(j) + buildLogHtml(j.log), "ok");
    hidePreflight();
    lockSource(true);
    go(2);
  } catch (e) {
    flash($("#src-result"), "✗ " + escapeHtml(e.message) + " — is the server running? (node scripts/server.js)", "err");
  } finally {
    building = false;
    if (!built || merging) { $("#btn-build").disabled = false; updateConfirm(); }   // after a success the source stays locked
  }
};

/* ---- step 2: per-group name + photo -------------------------------------- */
$("#gc-group").onchange = (e) => selectGroup(e.target.value);
$("#people-group").onchange = (e) => selectGroup(e.target.value);
$("#gc-name").oninput = (e) => { gcEntry().name = e.target.value; };
$("#gc-remove").onchange = (e) => {
  const id = state.group;
  if (e.target.checked) state.ignoredGroups[id] = true; else delete state.ignoredGroups[id];
  renderGroupChoosers();   // refresh the "— removed" option labels
  refreshGroupStep();
};
$("#gc-pick").onclick = () => $("#gc-photo").click();
$("#gc-photo").onchange = async (e) => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  e.target.value = "";   // let the same file be re-picked after a cancel
  const url = await pickedPhoto(f);
  if (!(await confirmImage(url))) return;
  gcEntry().photo = url;
  const pv = $("#gc-preview"); pv.textContent = ""; pv.style.backgroundImage = `url('${url}')`;
};

/* ---- step 3: people ------------------------------------------------------ */
// un-mark "This is YOU" (a radio can't be unchecked by clicking it).
$("#me-clear").onclick = () => {
  state.me = "";
  $$('.su-me input[type="radio"]').forEach((r) => { r.checked = false; });
};
async function loadParts() {
  const host = $("#people");
  if (state.ignoredGroups[state.group]) {
    PARTS = []; loadedGroup = null;
    host.innerHTML = `<div class="setup-result">This group chat is marked for removal, so there's no one to name here. Un-check &ldquo;Remove this group chat&rdquo; on the previous step to keep it.</div>`;
    return;
  }
  if (loadedGroup === state.group && PARTS.length) return;
  host.innerHTML = `<div class="setup-result">Loading participants…</div>`;
  if (statusReady) await statusReady;   // don't render cards before saved identity is known
  try {
    const r = await fetch("/api/parts?group=" + encodeURIComponent(state.group));
    const j = await r.json();
    if (!r.ok) { host.innerHTML = `<div class="setup-result err">✗ ${escapeHtml(j.error || "Could not load participants")}</div>`; return; }
    PARTS = j.parts || [];
    loadedGroup = state.group;
    host.innerHTML = "";
    PARTS.forEach((p) => host.appendChild(personCard(p)));
    renderRemovedPeople();
  } catch (e) {
    host.innerHTML = `<div class="setup-result err">✗ ${escapeHtml(e.message)}</div>`;
  }
}

// People removed in an earlier save have no card (the archive no longer has
// them), so list them here with a way to bring them back.
function renderRemovedPeople() {
  const host = $("#removed-people");
  if (!host) return;
  const shown = new Set(PARTS.map((p) => String(p.id)));
  const ids = Object.keys(state.ignored).filter((id) => !shown.has(id));
  host.hidden = !ids.length;
  if (!ids.length) { host.textContent = ""; return; }
  host.innerHTML = "Removed from your archive (in every group chat):<ul>" + ids.map((id) => {
    const nm = state.names[id] || "User " + id.slice(-4);
    return `<li><span>${escapeHtml(nm)}</span><button type="button" class="btn ghost" data-bring-back="${escapeHtml(id)}" aria-label="Bring back ${escapeHtml(nm)}">Bring back</button></li>`;
  }).join("") + "</ul>";
  $$("[data-bring-back]", host).forEach((b) => b.onclick = () => { delete state.ignored[b.dataset.bringBack]; renderRemovedPeople(); });
}

function personCard(p) {
  const card = document.createElement("div"); card.className = "su-person";
  const savedName = state.names[p.id];
  // Display-only: paint the avatar from a path saved in an earlier run (already
  // "personal_data/pfps/…", same as window.LOCAL_PFPS in app.js — served as-is,
  // relative to setup.html at the project root). Never written into state.pfps —
  // that map holds fresh data-URLs to be decoded and saved server-side, and a
  // path string there would be posted back as if it were image data.
  const savedPfp = savedPfpPaths[p.id];

  const left = document.createElement("div"); left.className = "su-left";
  const av = document.createElement("div"); av.className = "su-av";
  paintHue(av, p.id);
  if (savedPfp) { av.style.backgroundImage = `url('${savedPfp}')`; av.style.backgroundSize = "cover"; av.style.backgroundPosition = "center"; }
  else av.textContent = initials(savedName || "User " + String(p.id).slice(-4));
  const file = document.createElement("input"); file.type = "file"; file.accept = "image/*"; file.style.display = "none";
  const pick = document.createElement("button"); pick.className = "btn ghost su-pick"; pick.textContent = savedPfp ? "Change photo" : "Add photo";
  pick.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files && file.files[0]; if (!f) return;
    file.value = "";   // let the same file be re-picked after a cancel
    const url = await pickedPhoto(f);
    if (!(await confirmImage(url))) return;
    state.pfps[p.id] = url;
    av.textContent = ""; av.style.backgroundImage = `url('${url}')`; av.style.backgroundSize = "cover"; av.style.backgroundPosition = "center";
    pick.textContent = "Change photo";
  };
  left.appendChild(av); left.appendChild(pick); left.appendChild(file);
  card.appendChild(left);

  const main = document.createElement("div"); main.className = "su-main";
  const name = document.createElement("input");
  name.className = "setup-input su-name"; name.type = "text"; name.placeholder = "User " + String(p.id).slice(-4);
  if (savedName) name.value = savedName;
  // emptying a name keeps the id with "" — the server's signal to forget it.
  name.oninput = () => { const v = name.value.trim(); if (v) { state.names[p.id] = v; av.dataset.named = "1"; if (!state.pfps[p.id]) av.textContent = initials(v); } else { state.names[p.id] = ""; if (!state.pfps[p.id]) av.textContent = initials("User " + String(p.id).slice(-4)); } };
  main.appendChild(name);

  const meta = document.createElement("div"); meta.className = "su-meta";
  // members who never posted still get a card; say so, and when they
  // joined / left the group, as a memory jog for who they are.
  const when = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
  const bits = [p.count ? `${p.count.toLocaleString()} messages` : "No messages"];
  if (p.joined != null && isFinite(p.joined)) bits.push("joined " + when(p.joined));
  if (p.left != null && isFinite(p.left)) bits.push("left " + when(p.left));
  bits.push("id " + String(p.id));
  meta.textContent = bits.join(" · ");
  main.appendChild(meta);

  const me = document.createElement("label"); me.className = "su-me";
  const radio = document.createElement("input"); radio.type = "radio"; radio.name = "su-me"; radio.value = p.id;
  if (state.me != null && String(state.me) === String(p.id)) radio.checked = true;
  radio.onchange = () => { if (radio.checked) state.me = String(p.id); };
  me.appendChild(radio); me.appendChild(document.createTextNode(" This is YOU"));
  main.appendChild(me);

  if (p.samples && p.samples.length) {
    const sw = document.createElement("div"); sw.className = "su-samples";
    p.samples.forEach((s) => { const d = document.createElement("div"); d.className = "su-sample"; d.textContent = s; sw.appendChild(d); });
    main.appendChild(sw);
  }
  if (p.media && p.media.length) {
    const mw = document.createElement("div"); mw.className = "su-media";
    p.media.forEach((it) => {
      if (it.k === "vid") { const v = document.createElement("video"); v.className = "su-thumb"; v.src = it.m; v.muted = true; v.preload = "metadata"; v.title = "Click to enlarge"; v.onclick = () => viewMedia(it.m, "vid"); mw.appendChild(v); }
      else { const img = document.createElement("img"); img.className = "su-thumb"; img.src = it.m; img.loading = "lazy"; img.alt = ""; img.title = "Click to enlarge"; img.onclick = () => viewMedia(it.m, "img"); mw.appendChild(img); }
    });
    main.appendChild(mw);
  }
  card.appendChild(main);

  // Delete a participant (a bot, someone you'd rather not keep). It greys the
  // card, disables its inputs, and flags the id to be dropped on save. Undo-able.
  const rm = document.createElement("button");
  rm.type = "button"; rm.className = "btn ghost su-remove"; rm.textContent = "Remove";
  const showRemoved = (removing) => {
    card.classList.toggle("removed", removing);
    rm.textContent = removing ? "Undo" : "Remove";
    name.disabled = pick.disabled = radio.disabled = removing;
  };
  rm.onclick = () => {
    const removing = !state.ignored[p.id];
    // removing your own card clears "This is YOU" ("" = clear on the server)
    if (removing) { state.ignored[p.id] = true; if (state.me != null && String(state.me) === String(p.id)) { state.me = ""; radio.checked = false; } }
    else delete state.ignored[p.id];
    showRemoved(removing);
  };
  if (state.ignored[p.id]) showRemoved(true);   // removed in an earlier save
  left.appendChild(rm);
  return card;
}

/* ---- step 4: save -------------------------------------------------------- */
// Removing rebuilds the archive without those messages (they are kept in
// personal_data/.removed until un-removed or Start over), so a save that
// removes more than before asks first, with real counts from the server.
// Resolves true to go ahead.
const removeModal = $("#remove-modal");
function plural(n, one, many) { return Number(n).toLocaleString() + " " + (n === 1 ? one : many); }
async function confirmRemoval(ignoredGroups, ignoredUsers, newGroups, newPeople) {
  let p = null;
  try {
    const r = await fetch("/api/removal-preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ignoredGroups, ignoredUsers }),
    });
    if (r.ok) p = await r.json();
  } catch (e) { /* counts unknown: still ask */ }
  const what = p
    ? "Takes " + plural(p.messages, "message", "messages") + " and their " + plural(p.media, "media file", "media files") + " out of your archive"
    : "Takes the messages and media of what you marked for removal out of your archive";
  const scope = newPeople
    ? ", in every group (removing a person applies to every group chat they're in)."
    : " (" + plural(newGroups, "group chat", "group chats") + ").";
  $("#remove-msg").textContent = what + scope;
  removeModal.hidden = false;
  $("#remove-cancel").focus();
  return new Promise((resolve) => {
    const done = (ok) => {
      removeModal.hidden = true;
      document.removeEventListener("keydown", onKey, true);
      $("#remove-go").onclick = $("#remove-cancel").onclick = removeModal.onclick = null;
      resolve(ok);   // the Save click handler puts focus back on Save
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); done(false); }
      else if (e.key === "Tab") {   // keep focus inside the dialog
        const a = $("#remove-cancel"), b = $("#remove-go");
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
        else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    $("#remove-go").onclick = () => done(true);
    $("#remove-cancel").onclick = () => done(false);
    removeModal.onclick = (e) => { if (e.target === removeModal) done(false); };
  });
}
// One save at a time: Save stays disabled until the whole flow ends (the
// removal count, the dialog, the save), so a double-click can't open a second
// dialog whose leftover Escape handler later reports "Nothing was saved".
let saving = false;
$("#btn-save").onclick = async () => {
  if (saving) return;
  saving = true;
  const btn = $("#btn-save");
  btn.disabled = true;
  try { await saveAll(); }
  finally {
    saving = false;
    btn.disabled = false;
    if (!document.activeElement || document.activeElement === document.body) btn.focus();
  }
};
async function saveAll() {
  // Removed participants don't need a name or photo — drop them from the payload.
  const ignoredUsers = Object.keys(state.ignored);
  const ignoredGroups = Object.keys(state.ignoredGroups);
  const newPeople = ignoredUsers.filter((id) => !savedIgnored.users[id]).length;
  const newGroups = ignoredGroups.filter((id) => !savedIgnored.groups[id]).length;
  if (newPeople || newGroups) flash($("#finish-result"), "Checking what this removes…", "");
  if ((newPeople || newGroups) && !(await confirmRemoval(ignoredGroups, ignoredUsers, newGroups, newPeople))) {
    flash($("#finish-result"), "Nothing was saved. Undo the removals you don't want, then save again.", "");
    return;
  }
  flash($("#finish-result"), "Saving…", "");
  const names = Object.assign({}, state.names), pfps = Object.assign({}, state.pfps);
  ignoredUsers.forEach((id) => { delete names[id]; delete pfps[id]; });
  try {
    const r = await fetch("/api/identity", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ me: state.me, gc: state.gc, names, pfps, ignoredUsers, ignoredGroups }),
    });
    const j = await r.json();
    if (!r.ok) { flash($("#finish-result"), "✗ " + escapeHtml(j.error || "Save failed"), "err"); return; }
    savedIgnored.users = {}; savedIgnored.groups = {};
    ignoredUsers.forEach((id) => { savedIgnored.users[id] = true; });
    ignoredGroups.forEach((id) => { savedIgnored.groups[id] = true; });
    flash($("#finish-result"),
      `✓ Saved <b>${j.names}</b> name(s) and <b>${j.pfps}</b> photo(s)` +
      (j.ignored ? ` and removed <b>${j.ignored}</b> user(s)` : "") + "." +
      // removals are applied to the archive itself, not just hidden
      (j.rebuilt ? ` Rebuilt the archive without the removed chats/people` +
        (j.mediaRemoved ? ` and set aside <b>${Number(j.mediaRemoved).toLocaleString()}</b> of their media files (in personal_data/.removed, so un-removing can bring them back)` : "") + "." : "") +
      ` <a href="index.html">Open your archive →</a>` + buildNotesHtml(j), "ok");
  } catch (e) {
    flash($("#finish-result"), "✗ " + escapeHtml(e.message), "err");
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/* ---- reset / start over -------------------------------------------------- */
// Wipe personal_data/ (server-side) so the user can redo setup from scratch.
// Guarded by a typed "RESET" confirmation because it's destructive + irreversible.
const resetModal = $("#reset-modal");
function openReset() {
  if (!SERVED) { needServer($("#src-result")); return; }
  const inp = $("#reset-confirm");
  inp.value = ""; $("#reset-go").disabled = true; $("#reset-result").hidden = true;
  resetModal.hidden = false; inp.focus();
}
function closeReset() { resetModal.hidden = true; }
$("#btn-reset").onclick = openReset;
$("#reset-cancel").onclick = closeReset;
$("#reset-confirm").oninput = (e) => { $("#reset-go").disabled = e.target.value.trim() !== "RESET"; };
resetModal.onclick = (e) => { if (e.target === resetModal) closeReset(); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !resetModal.hidden) { e.preventDefault(); closeReset(); } });
$("#reset-go").onclick = async () => {
  const out = $("#reset-result");
  flash(out, "Erasing…", "");
  try {
    const r = await fetch("/api/reset", { method: "POST" });
    const j = await r.json();
    if (!r.ok) { flash(out, "✗ " + escapeHtml(j.error || "Reset failed"), "err"); return; }
    flash(out, "✓ Erased. Restarting setup…", "ok");
    setTimeout(() => location.reload(), 600);
  } catch (e) {
    flash(out, "✗ " + escapeHtml(e.message), "err");
  }
};

/* ---- theme switch (mirrors app.js: key gca.theme, default lightsout) ------ */
(function initTheme() {
  const KEY = "gca.theme", THEMES = ["light", "dim", "lightsout"];
  function get() { try { const t = localStorage.getItem(KEY); if (THEMES.indexOf(t) !== -1) return t; } catch (e) { /* ignore */ } return "lightsout"; }
  function set(t) {
    if (THEMES.indexOf(t) === -1) t = "lightsout";
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem(KEY, t); } catch (e) { /* ignore */ }
    $$(".theme-switch button").forEach((b) => b.classList.toggle("on", b.dataset.set === t));
  }
  set(get());
  $$(".theme-switch button").forEach((b) => b.addEventListener("click", () => set(b.dataset.set)));
})();

go(1);
loadStatus();
})();
