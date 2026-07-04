/*
 * build-core.js — the pure archive-assembly logic, with NO filesystem I/O.
 *
 * scripts/build.js handles all reading/writing (config, source files, media
 * folder, output data.js) and hands the parsed inputs to assembleConversations()
 * here. Keeping the transformation pure makes the most complex logic in the
 * project unit-testable without ever touching a real personal_data/ folder.
 *
 * See tests/build-core.test.js.
 */

const IMG = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const VID = new Set(["mp4", "mov", "webm", "m4v"]);
const kindOf = (p) => {
  const e = String(p).split(".").pop().toLowerCase();
  return IMG.has(e) ? "img" : VID.has(e) ? "vid" : "file";
};

const toMs = (iso) => (iso ? Date.parse(iso) : 0);

// a 1:1 DM id looks like "{userA}-{userB}"; a group id is a single numeric id
const isGroupId = (id) => !/^\d+-\d+$/.test(String(id));

/* ---- normalization ------------------------------------------------------- */
function rawToRec(mc) {
  const rec = { i: mc.id, s: mc.senderId, t: toMs(mc.createdAt), x: mc.text || "" };
  if (mc.urls && mc.urls.length) rec.u = mc.urls.map((u) => ({ s: u.url, e: u.expanded, d: u.display }));
  if (mc.reactions && mc.reactions.length) rec.r = mc.reactions.map((r) => ({ k: r.reactionKey, s: r.senderId }));
  return rec;
}
function toEvent(m) {
  if (m.conversationNameUpdate) { const e = m.conversationNameUpdate; return { t: toMs(e.createdAt), type: "name", s: e.initiatingUserId, name: e.name }; }
  if (m.participantsJoin) { const e = m.participantsJoin; return { t: toMs(e.createdAt), type: "join", s: e.initiatingUserId, ids: e.userIds || [] }; }
  if (m.participantsLeave) { const e = m.participantsLeave; return { t: toMs(e.createdAt), type: "leave", ids: e.userIds || [] }; }
  if (m.joinConversation) { const e = m.joinConversation; return { t: toMs(e.createdAt), type: "create", s: e.initiatingUserId }; }
  return null;
}
function eventKey(e) { return [e.type, e.t, e.name || "", (e.ids || []).join(","), e.s || ""].join("|"); }

/* ---- per-conversation accumulator ---------------------------------------- */
function makeConvo(id) {
  return { id, type: isGroupId(id) ? "group" : "dm", msgMap: new Map(), eventMap: new Map(), headerParts: new Set() };
}

/**
 * Fold parsed inputs into the final conversation index.
 *
 * @param {object}   opts
 * @param {object|null} opts.prev        previously built CHAT_DATA (new multi-conv
 *                                       shape or legacy single-conv), or null.
 * @param {Array[]}  opts.exportDatas    parsed arrays from direct-messages-group.js files.
 * @param {Array[]}  opts.headerDatas    parsed arrays from -headers.js files (metadata only).
 * @param {object}   opts.mediaIndex     { messageId -> root-relative media path }.
 * @param {string[]} opts.ignoredUsers   user ids to drop from messages + roster.
 * @param {string[]} opts.ignoredGroups  conversation ids to drop entirely.
 * @returns {{conversations: object[], totalMsgs: number, totalMedia: number, prevCount: number}}
 */
function assembleConversations(opts) {
  opts = opts || {};
  const prev = opts.prev || null;
  const exportDatas = opts.exportDatas || [];
  const headerDatas = opts.headerDatas || [];
  const mediaIndex = opts.mediaIndex || {};
  const IGNORED = new Set((Array.isArray(opts.ignoredUsers) ? opts.ignoredUsers : []).map(String));
  // whole group chats the user removed in the wizard — excluded entirely (their
  // messages aren't assembled and their media is never referenced in the output)
  const IGNORED_GROUPS = new Set((Array.isArray(opts.ignoredGroups) ? opts.ignoredGroups : []).map(String));

  const convos = new Map();
  const getConvo = (id) => {
    let c = convos.get(id);
    if (!c) { c = makeConvo(id); convos.set(id, c); }
    return c;
  };

  // 1) baseline = previously built data (so history is never lost)
  let prevCount = 0;
  if (prev) {
    const prevConvos = Array.isArray(prev.conversations)
      ? prev.conversations
      : (prev.conversationId ? [{ id: prev.conversationId, type: isGroupId(prev.conversationId) ? "group" : "dm", msgs: prev.msgs || [], events: prev.events || [] }] : []);
    prevConvos.forEach((pc) => {
      const c = getConvo(pc.id);
      if (pc.type) c.type = pc.type;
      (pc.msgs || []).forEach((m) => c.msgMap.set(m.i, m));
      (pc.events || []).forEach((e) => c.eventMap.set(eventKey(e), e));
      prevCount += (pc.msgs || []).length;
    });
  }

  // 2) fold every export (full message bodies)
  for (const data of exportDatas) {
    (data || []).forEach((d) => {
      const conv = d.dmConversation; if (!conv || !conv.conversationId) return;
      const c = getConvo(conv.conversationId);
      (conv.messages || []).forEach((m) => {
        if (m.messageCreate) { const r = rawToRec(m.messageCreate); if (r.i) c.msgMap.set(r.i, r); }
        else { const e = toEvent(m); if (e) c.eventMap.set(eventKey(e), e); }
      });
    });
  }

  // 2c) fold the group headers (metadata-only): no message bodies, so they never
  // add messages — only complete the participant roster + join/leave/name events.
  for (const data of headerDatas) {
    (data || []).forEach((d) => {
      const conv = d.dmConversation; if (!conv || !conv.conversationId) return;
      const c = getConvo(conv.conversationId);
      (conv.messages || []).forEach((m) => {
        if (m.messageCreate) {
          const mc = m.messageCreate;
          if (mc.senderId) c.headerParts.add(mc.senderId);
          if (mc.recipientId) c.headerParts.add(mc.recipientId);
        } else {
          const e = toEvent(m);
          if (e) {
            c.eventMap.set(eventKey(e), e);
            if (e.s) c.headerParts.add(e.s);
            (e.ids || []).forEach((id) => c.headerParts.add(id));
          }
        }
      });
    });
  }

  // 3) resolve local media + assemble final conversation index
  const conversations = [];
  let totalMsgs = 0, totalMedia = 0;
  for (const c of convos.values()) {
    if (IGNORED_GROUPS.has(String(c.id))) continue;   // removed group chat — skip wholesale
    let withMedia = 0;
    const msgVals = [...c.msgMap.values()].filter((m) => !IGNORED.has(String(m.s)));
    for (const rec of msgVals) {
      const mp = mediaIndex[rec.i];
      if (mp) { rec.m = mp; rec.k = kindOf(mp); withMedia++; }
      else if (rec.m) withMedia++;
    }
    const msgs = msgVals.sort((a, b) => a.t - b.t || (a.i < b.i ? -1 : 1));
    const events = [...c.eventMap.values()].sort((a, b) => a.t - b.t);
    if (!msgs.length || c.type !== "group") continue;   // group chats only; drop empty + 1:1 DMs

    const headerParts = [...(c.headerParts || [])].filter((id) => !IGNORED.has(String(id)));
    const participants = [...new Set([...msgs.map((m) => m.s), ...headerParts])];
    const nameEv = events.filter((e) => e.type === "name");
    const title = nameEv.length ? nameEv[nameEv.length - 1].name
      : (c.type === "group" ? "Group " + String(c.id).slice(-4) : null);

    conversations.push({ id: c.id, type: c.type, title, participants, count: msgs.length, msgs, events });
    totalMsgs += msgs.length;
    totalMedia += withMedia;
  }

  // biggest conversation first, so the UI opens on the most active chat
  conversations.sort((a, b) => b.count - a.count);

  return { conversations, totalMsgs, totalMedia, prevCount };
}

/* ---- wizard participant roster ------------------------------------------- */
// kept in sync with src/app.js:X_LINK — update both.
const X_LINK = /(?:https?:\/\/)?(?:t\.co|(?:[\w-]+\.)?twitter\.com|(?:[\w-]+\.)?x\.com)\//i;

/**
 * Build the setup wizard's participant list from already-built CHAT_DATA:
 * per-person message count, a few link-free sample messages, and up to 6 shared
 * media items (memory jogs for naming). Pass a `groupId` to scope to a single
 * conversation; omit (or pass a falsy value) to merge everyone across all groups.
 *
 * @param {object} data        built CHAT_DATA ({ conversations: [...] }).
 * @param {string} [groupId]   conversation id to scope to; falsy = all groups.
 * @returns {Array<{id, count, samples: string[], media: Array}>}
 */
function collectParticipants(data, groupId) {
  const convs = (data && data.conversations) || [];
  const scoped = groupId != null && groupId !== "";
  const map = new Map();
  for (const c of convs) {
    if (scoped && String(c.id) !== String(groupId)) continue;
    for (const m of (c.msgs || [])) {
      let p = map.get(m.s);
      if (!p) { p = { id: m.s, count: 0, samples: [], _seen: new Set(), media: [] }; map.set(m.s, p); }
      p.count++;
      const t = (m.x || "").trim();
      if (t.length > 14 && !/^https?:/.test(t) && !X_LINK.test(t) && p.samples.length < 40) {
        const k = t.toLowerCase();
        if (!p._seen.has(k)) { p._seen.add(k); p.samples.push(t); }
      }
      if (m.m && p.media.length < 6) p.media.push({ m: m.m, k: m.k || kindOf(m.m) });
    }
  }
  return [...map.values()]
    .sort((a, b) => b.count - a.count)
    .map((p) => ({ id: p.id, count: p.count, samples: p.samples.sort((a, b) => b.length - a.length).slice(0, 10), media: p.media }));
}

module.exports = { assembleConversations, collectParticipants, rawToRec, toEvent, eventKey, isGroupId, kindOf };
