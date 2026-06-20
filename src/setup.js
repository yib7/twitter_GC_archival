/* setup.js — first-run wizard logic. Talks to the local server's /api/*. */
(function () {
"use strict";

const PALETTE = ["#3b82f6", "#22c55e", "#f59e0b", "#ec4899", "#8b5cf6", "#06b6d4", "#ef4444", "#10b981", "#f97316", "#a855f7", "#14b8a6", "#eab308"];
function hashId(id) { id = String(id); let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h; }
const colorOf = (id) => PALETTE[hashId(id) % PALETTE.length];
function initials(name) {
  const p = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "?";
  return (p.length === 1 ? p[0].slice(0, 2) : p[0][0] + p[p.length - 1][0]).toUpperCase();
}
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
function fileToDataURL(f) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); }); }

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
let PARTS = [];
let groups = [];          // [{ id, title, count }] from the build
let loadedGroup = null;   // which group's roster is currently rendered in #people
let built = false;
let step = 1;

// The per-group name+photo entry for the group currently being set up.
function gcEntry() {
  const g = state.group || "";
  return state.gc[g] || (state.gc[g] = { name: "", photo: null });
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
  if (pv) {
    if (e.photo) { pv.textContent = ""; pv.style.backgroundImage = `url('${e.photo}')`; }
    else { pv.style.backgroundImage = ""; pv.textContent = "💬"; }
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
  flash(host,
    "This page is open as a <b>local file</b>, but the setup wizard must run " +
    "<b>through the local server</b>. Start it and reopen this page there:" +
    "<br><br>1. <code>node scripts/server.js</code>" +
    "<br>2. open <code>http://localhost:8765/setup.html</code>", "err");
}
if (!SERVED) needServer($("#src-result"));

/* ---- step 1: native pickers + build -------------------------------------- */
async function pick(kind, fill, which) {
  if (!SERVED) { needServer($("#src-result")); return; }
  flash($("#src-result"), "Opening the file browser… (check for a dialog window)", "");
  try {
    const url = kind === "file" ? "/api/pick-file?for=" + (which || "group") : "/api/pick-folder";
    const r = await fetch(url);
    const j = await r.json();
    if (!j.supported) { flash($("#src-result"), "The native file browser is only available on Windows — please paste the path instead.", "err"); return; }
    if (!j.path) { $("#src-result").hidden = true; return; }   // cancelled
    fill(j.path);
    $("#src-result").hidden = true;
  } catch (e) {
    flash($("#src-result"), "✗ " + e.message + " — is the server running? (node scripts/server.js)", "err");
  }
}
$("#group-browse").onclick = () => pick("file", (p) => { $("#src-group").value = p; }, "group");
$("#headers-browse").onclick = () => pick("file", (p) => { $("#src-headers").value = p; }, "headers");
$("#media-browse").onclick = () => pick("folder", (p) => { $("#src-media").value = p; });

$("#btn-build").onclick = async () => {
  if (!SERVED) { needServer($("#src-result")); return; }
  const groupJs = $("#src-group").value.trim();
  const headersJs = $("#src-headers").value.trim();
  const mediaDir = $("#src-media").value.trim();
  if (!groupJs) { flash($("#src-result"), "Choose your direct-messages-group.js file.", "err"); return; }
  if (!headersJs) { flash($("#src-result"), "Choose your direct-message-group-headers.js file.", "err"); return; }
  if (!mediaDir) { flash($("#src-result"), "Choose your direct_messages_group_media folder — it's required.", "err"); return; }
  flash($("#src-result"), "Building… (copying media can take a moment)", "");
  try {
    const r = await fetch("/api/source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupJs, headersJs, mediaDir }) });
    const j = await r.json();
    if (!r.ok) { flash($("#src-result"), "✗ " + (j.error || "Build failed"), "err"); return; }
    built = true;
    groups = j.groups || [];
    state.group = groups[0] ? String(groups[0].id) : "";
    renderGroupChoosers();
    refreshGroupStep();
    const groupList = groups.map((g) => `<li>${escapeHtml(g.title || "Group " + String(g.id).slice(-4))} — ${Number(g.count).toLocaleString()} messages</li>`).join("");
    flash($("#src-result"),
      `✓ Built <b>${j.totalMsgs.toLocaleString()}</b> messages across <b>${groups.length}</b> group(s)` +
      (j.mediaCopied ? `, copied <b>${j.mediaCopied.toLocaleString()}</b> media files` : "") +
      `.<ul>${groupList}</ul>`, "ok");
    go(2);
  } catch (e) {
    flash($("#src-result"), "✗ " + e.message + " — is the server running? (node scripts/server.js)", "err");
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
  const url = await fileToDataURL(f);
  if (!(await confirmImage(url))) return;
  gcEntry().photo = url;
  const pv = $("#gc-preview"); pv.textContent = ""; pv.style.backgroundImage = `url('${url}')`;
};

/* ---- step 3: people ------------------------------------------------------ */
async function loadParts() {
  const host = $("#people");
  if (state.ignoredGroups[state.group]) {
    PARTS = []; loadedGroup = null;
    host.innerHTML = `<div class="setup-result">This group chat is marked for removal, so there's no one to name here. Un-check &ldquo;Remove this group chat&rdquo; on the previous step to keep it.</div>`;
    return;
  }
  if (loadedGroup === state.group && PARTS.length) return;
  host.innerHTML = `<div class="setup-result">Loading participants…</div>`;
  try {
    const r = await fetch("/api/parts?group=" + encodeURIComponent(state.group));
    const j = await r.json();
    if (!r.ok) { host.innerHTML = `<div class="setup-result err">✗ ${escapeHtml(j.error || "Could not load participants")}</div>`; return; }
    PARTS = j.parts || [];
    loadedGroup = state.group;
    host.innerHTML = "";
    PARTS.forEach((p) => host.appendChild(personCard(p)));
  } catch (e) {
    host.innerHTML = `<div class="setup-result err">✗ ${escapeHtml(e.message)}</div>`;
  }
}

function personCard(p) {
  const card = document.createElement("div"); card.className = "su-person";

  const left = document.createElement("div"); left.className = "su-left";
  const av = document.createElement("div"); av.className = "su-av";
  av.style.background = colorOf(p.id); av.textContent = initials("User " + String(p.id).slice(-4));
  const file = document.createElement("input"); file.type = "file"; file.accept = "image/*"; file.style.display = "none";
  const pick = document.createElement("button"); pick.className = "btn ghost su-pick"; pick.textContent = "Add photo";
  pick.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files && file.files[0]; if (!f) return;
    file.value = "";   // let the same file be re-picked after a cancel
    const url = await fileToDataURL(f);
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
  name.oninput = () => { const v = name.value.trim(); if (v) { state.names[p.id] = v; av.dataset.named = "1"; if (!state.pfps[p.id]) av.textContent = initials(v); } else { delete state.names[p.id]; if (!state.pfps[p.id]) av.textContent = initials("User " + String(p.id).slice(-4)); } };
  main.appendChild(name);

  const meta = document.createElement("div"); meta.className = "su-meta";
  meta.innerHTML = `${p.count.toLocaleString()} messages · id ${escapeHtml(String(p.id))}`;
  main.appendChild(meta);

  const me = document.createElement("label"); me.className = "su-me";
  const radio = document.createElement("input"); radio.type = "radio"; radio.name = "su-me"; radio.value = p.id;
  radio.onchange = () => { if (radio.checked) state.me = p.id; };
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
  rm.onclick = () => {
    const removing = !state.ignored[p.id];
    if (removing) { state.ignored[p.id] = true; if (state.me === p.id) { state.me = null; radio.checked = false; } }
    else delete state.ignored[p.id];
    card.classList.toggle("removed", removing);
    rm.textContent = removing ? "Undo" : "Remove";
    name.disabled = pick.disabled = radio.disabled = removing;
  };
  left.appendChild(rm);
  return card;
}

/* ---- step 4: save -------------------------------------------------------- */
$("#btn-save").onclick = async () => {
  flash($("#finish-result"), "Saving…", "");
  // Removed participants don't need a name or photo — drop them from the payload.
  const ignoredUsers = Object.keys(state.ignored);
  const names = Object.assign({}, state.names), pfps = Object.assign({}, state.pfps);
  ignoredUsers.forEach((id) => { delete names[id]; delete pfps[id]; });
  try {
    const r = await fetch("/api/identity", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ me: state.me, gc: state.gc, names, pfps, ignoredUsers, ignoredGroups: Object.keys(state.ignoredGroups) }),
    });
    const j = await r.json();
    if (!r.ok) { flash($("#finish-result"), "✗ " + (j.error || "Save failed"), "err"); return; }
    flash($("#finish-result"),
      `✓ Saved <b>${j.names}</b> name(s) and <b>${j.pfps}</b> photo(s)` +
      (j.ignored ? ` and removed <b>${j.ignored}</b> user(s)` : "") +
      `. <a href="index.html">Open your archive →</a>`, "ok");
  } catch (e) {
    flash($("#finish-result"), "✗ " + e.message, "err");
  }
};

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

go(1);
})();
