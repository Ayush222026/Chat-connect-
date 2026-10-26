(() => {
"use strict";

/* ====================== helpers ====================== */
const PAGE = 50;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const $ = (s, r = document) => r.querySelector(s);

// Safe DOM builder: text is always set via textContent / text nodes (no HTML injection).
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
  return e;
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const isVisible = () => document.visibilityState === "visible";
const sameDay = (a, b) => a.toDateString() === b.toDateString();
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function dayLabel(iso) {
  const d = new Date(iso), n = new Date();
  if (sameDay(d, n)) return "Today";
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (sameDay(d, y)) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}
function listTime(iso) {
  const d = new Date(iso);
  if (sameDay(d, new Date())) return fmtTime(iso);
  const l = dayLabel(iso);
  return l === "Yesterday" ? l : d.toLocaleDateString([], { day: "numeric", month: "short" });
}
function lastSeenText(iso) {
  if (!iso) return "";
  const l = dayLabel(iso);
  return "last seen " + (l === "Today" ? "today" : l === "Yesterday" ? "yesterday" : "on " + l) + " at " + fmtTime(iso);
}
const COLORS = ["#e57373", "#ba68c8", "#7986cb", "#4fc3f7", "#4db6ac", "#81c784", "#ffb74d", "#a1887f", "#f06292", "#64b5f6"];
function avatar(name, size = 48, online = false) {
  let hsh = 0; for (const ch of name) hsh = (hsh * 31 + ch.charCodeAt(0)) | 0;
  const a = h("div", { class: "avatar", text: (name[0] || "?").toUpperCase(),
    style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;background:${COLORS[Math.abs(hsh) % COLORS.length]}` });
  if (online) a.append(h("span", { class: "dot", title: "online" }));
  return a;
}
let toastT;
function toast(msg, kind = "info") {
  const t = $("#toast"); t.textContent = msg; t.className = "toast show " + kind;
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = "toast"; }, 4200);
}
function errText(err) {
  const m = (err && (err.message || err.error_description)) || "Something went wrong.";
  if (/Invalid login credentials/i.test(m)) return "Wrong email or password.";
  if (/Email not confirmed/i.test(m)) return "Please confirm your email first (check your inbox), then log in.";
  if (/already registered|already been registered/i.test(m)) return "That email is already registered. Try logging in.";
  if (/rate limit/i.test(m)) return "Too many attempts. Please wait a few minutes and try again.";
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Network problem. Check your internet connection.";
  return m;
}
function setBusy(btn, on) { btn.disabled = on; btn.classList.toggle("loading", on); }
const dn = (c) => c.name || c.username;

/* ====================== boot / config ====================== */
const cfg = window.CONNECTCHAT_CONFIG || {};
const configured = cfg.SUPABASE_URL && cfg.SUPABASE_KEY &&
  !/YOUR-PROJECT-REF/.test(cfg.SUPABASE_URL) && !/YOUR-PUBLISHABLE/.test(cfg.SUPABASE_KEY);

function showOnly(id) {
  for (const x of ["#splash", "#setup-error", "#auth", "#app"]) $(x).classList.toggle("hidden", x !== id);
}
if (!window.supabase) {
  $("#setup-msg").textContent = "The Supabase library failed to load. Check your internet connection and reload.";
  showOnly("#setup-error"); return;
}
if (!configured) {
  $("#setup-msg").textContent = "Open config.js and set SUPABASE_URL and SUPABASE_KEY to your Supabase project's values (see README step 4).";
  showOnly("#setup-error"); return;
}
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 10 } },
});

const S = {
  user: null, profile: null, booted: false,
  convs: [], pinned: null, filter: "", loadingConvs: true,
  active: null, msgs: [], hasMore: false, loading: false, selected: null,
  online: new Set(), typing: false, typingTimer: null, lastTypingSent: 0,
  tChan: null, tReady: false, dbChan: null, presChan: null, hb: null, rtDown: false,
};
const activeConv = () => S.convs.find((c) => c.id === S.active);

/* ====================== theme ====================== */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("cc-theme", t); } catch (e) { /* storage may be blocked */ }
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = t === "dark" ? "#202c33" : "#008069";
}
const toggleTheme = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
applyTheme(document.documentElement.dataset.theme || "light");

/* ====================== auth ====================== */
function selectTab(which) {
  $("#tab-login").classList.toggle("active", which === "login");
  $("#tab-signup").classList.toggle("active", which === "signup");
  $("#form-login").classList.toggle("hidden", which !== "login");
  $("#form-signup").classList.toggle("hidden", which !== "signup");
}
$("#tab-login").onclick = () => selectTab("login");
$("#tab-signup").onclick = () => selectTab("signup");

$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#login-email").value.trim(), password = $("#login-password").value, err = $("#login-error");
  err.textContent = "";
  if (!EMAIL_RE.test(email)) { err.textContent = "Enter a valid email address."; return; }
  if (!password) { err.textContent = "Enter your password."; return; }
  const btn = $("#login-btn"); setBusy(btn, true);
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  setBusy(btn, false);
  if (error) { err.textContent = errText(error); return; }
  $("#login-password").value = "";
  await boot(data.session);
});

$("#form-signup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#su-email").value.trim(), username = $("#su-username").value.trim().toLowerCase();
  const password = $("#su-password").value, err = $("#su-error"), info = $("#su-info");
  err.textContent = ""; info.textContent = "";
  if (!EMAIL_RE.test(email)) { err.textContent = "Enter a valid email address."; return; }
  if (!USERNAME_RE.test(username)) { err.textContent = "Username must be 3–20 characters: a–z, 0–9 and underscore."; return; }
  if (password.length < 8) { err.textContent = "Password must be at least 8 characters."; return; }
  const btn = $("#su-btn"); setBusy(btn, true);
  try {
    const { data: free, error: e1 } = await sb.rpc("username_available", { uname: username });
    if (e1) throw e1;
    if (!free) { err.textContent = "That username is taken. Please choose another."; return; }
    const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
    if (error) throw error;
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      err.textContent = "That email is already registered. Try logging in."; return;
    }
    if (!data.session) {
      info.textContent = "Account created. Check your email to confirm it, then log in.";
      selectTab("login"); $("#login-email").value = email; return;
    }
    await boot(data.session);
  } catch (ex) { err.textContent = errText(ex); }
  finally { setBusy(btn, false); }
});

$("#btn-logout").onclick = logout;
async function logout() {
  const { error } = await sb.auth.signOut();
  if (error) { toast(errText(error), "error"); return; }
  teardown();
}
sb.auth.onAuthStateChange((evt) => { if (evt === "SIGNED_OUT" && S.booted) teardown(); });

function teardown() {
  for (const c of [S.dbChan, S.presChan, S.tChan]) if (c) sb.removeChannel(c);
  clearInterval(S.hb); clearTimeout(S.typingTimer);
  Object.assign(S, { user: null, profile: null, booted: false, convs: [], pinned: null, filter: "", loadingConvs: true,
    active: null, msgs: [], hasMore: false, selected: null, online: new Set(), typing: false, tChan: null,
    tReady: false, dbChan: null, presChan: null, hb: null, rtDown: false });
  $("#app").classList.remove("chat-open"); $("#chat-view").classList.add("hidden"); $("#chat-empty").classList.remove("hidden");
  $("#conv-list").replaceChildren(); $("#messages").replaceChildren(); $("#list-filter").value = "";
  document.title = "ConnectChat";
  showOnly("#auth");
}

async function boot(session) {
  if (S.booted || !session) return;
  S.booted = true; S.user = session.user;
  const { data, error } = await sb.from("profiles").select("*").eq("id", S.user.id).single();
  if (error || !data) {
    S.booted = false; showOnly("#auth");
    toast("Could not load your profile. Did you run schema.sql? " + (error ? errText(error) : ""), "error");
    await sb.auth.signOut(); return;
  }
  S.profile = data;
  showOnly("#app"); renderMe(); updateBanner(); renderList();
  startRealtime(); startHeartbeat();
  await loadConvs();
}

(async () => {
  const { data } = await sb.auth.getSession();
  if (data && data.session) await boot(data.session); else showOnly("#auth");
})();

/* ====================== conversations ====================== */
async function loadConvs() {
  if (!S.user) return;
  const { data, error } = await sb.rpc("get_my_conversations");
  S.loadingConvs = false;
  if (error) { toast("Could not load chats: " + errText(error), "error"); renderList(); return; }
  S.convs = data.map((r) => ({
    id: r.conv_id, otherId: r.other_id, username: r.other_username, name: r.other_name,
    lastSeen: r.other_last_seen, lastBody: r.last_body, lastSender: r.last_sender,
    lastAt: r.last_at, lastRead: r.last_read_at, unread: r.unread_count,
  }));
  if (S.pinned) {
    if (S.convs.some((c) => c.id === S.pinned.id)) S.pinned = null;
    else if (S.active === S.pinned.id) S.convs.unshift(S.pinned);
    else S.pinned = null;
  }
  renderList(); updateChatHeader();
  const a = activeConv();
  if (a && a.unread > 0 && isVisible()) markRead();
}
const refreshConvs = debounce(loadConvs, 250);

function emptyState(title, text) { return h("li", { class: "state" }, h("b", { text: title }), h("span", { text })); }

function renderList() {
  const ul = $("#conv-list"); if (!S.user) return;
  const f = S.filter.trim().toLowerCase();
  const items = S.convs.filter((c) => !f || c.username.includes(f) || (c.name || "").toLowerCase().includes(f));
  ul.replaceChildren();
  if (S.loadingConvs) ul.append(h("li", { class: "state" }, h("div", { class: "spinner" }), "Loading chats…"));
  else if (!S.convs.length) ul.append(emptyState("No conversations yet", "Tap ✚ at the top and search for a username to start chatting."));
  else if (!items.length) ul.append(emptyState("No chats match", "Nothing matches “" + S.filter + "”."));
  for (const c of items) ul.append(convItem(c));
  const total = S.convs.reduce((n, c) => n + c.unread, 0);
  document.title = (total ? `(${total}) ` : "") + "ConnectChat";
}

function convItem(c) {
  const mine = c.lastSender === S.user.id, has = c.lastBody != null;
  const open = () => openConversation(c.id);
  return h("li", { class: "conv" + (c.id === S.active ? " active" : ""), tabindex: "0", role: "button", onclick: open,
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } } },
    avatar(dn(c), 49, S.online.has(c.otherId)),
    h("div", { class: "conv-main" },
      h("div", { class: "conv-top" },
        h("span", { class: "conv-name", text: dn(c) }),
        h("time", { class: "conv-time" + (c.unread ? " unread" : ""), text: has ? listTime(c.lastAt) : "" })),
      h("div", { class: "conv-bot" },
        h("span", { class: "conv-prev" },
          mine && has ? h("span", { class: "tick" + (c.lastRead ? " read" : ""), text: c.lastRead ? "✓✓ " : "✓ " }) : null,
          has ? c.lastBody : "Say hi 👋"),
        c.unread ? h("span", { class: "badge", text: c.unread > 99 ? "99+" : String(c.unread) }) : null)));
}

$("#list-filter").addEventListener("input", (e) => { S.filter = e.target.value; renderList(); });

function renderMe() { $("#me-btn").replaceChildren(avatar(S.profile.display_name || S.profile.username, 40)); }

/* ====================== open / close chat ====================== */
async function openConversation(id) {
  const c = S.convs.find((x) => x.id === id); if (!c) return;
  closeTyping();
  S.active = id; S.msgs = []; S.hasMore = false; S.selected = null; S.loading = true;
  $("#app").classList.add("chat-open");
  $("#chat-empty").classList.add("hidden"); $("#chat-view").classList.remove("hidden");
  if (!(history.state && history.state.chat)) history.pushState({ chat: true }, "");
  updateChatHeader(); renderList(); renderMessages("bottom"); updateComposer();
  try {
    const rows = await fetchMsgs(id);
    if (S.active !== id) return;
    S.msgs = rows; S.hasMore = rows.length === PAGE;
  } catch (err) { if (S.active === id) toast("Could not load messages: " + errText(err), "error"); }
  if (S.active !== id) return;
  S.loading = false; renderMessages("bottom");
  openTyping(id); markRead();
  if (matchMedia("(pointer:fine)").matches) $("#msg-input").focus();
}

function closeChat() {
  S.active = null; S.msgs = []; S.selected = null; S.loading = false;
  closeTyping();
  $("#app").classList.remove("chat-open");
  $("#chat-view").classList.add("hidden"); $("#chat-empty").classList.remove("hidden");
  renderList();
}
$("#btn-back").onclick = () => { if (history.state && history.state.chat) history.back(); else closeChat(); };
window.addEventListener("popstate", () => { if (S.active) closeChat(); });

function updateChatHeader() {
  const c = activeConv(); if (!c) return;
  $("#ch-avatar").replaceChildren(avatar(dn(c), 40, S.online.has(c.otherId)));
  $("#ch-name").textContent = dn(c);
  $("#ch-status").textContent = S.typing ? "typing…" : S.online.has(c.otherId) ? "online" : lastSeenText(c.lastSeen) || "@" + c.username;
}

/* ====================== messages ====================== */
async function fetchMsgs(id, before) {
  let q = sb.from("messages").select("*").eq("conversation_id", id).order("created_at", { ascending: false }).limit(PAGE);
  if (before) q = q.lt("created_at", before);
  const { data, error } = await q;
  if (error) throw error;
  return data.reverse();
}
async function loadOlder() {
  const id = S.active, first = S.msgs.find((m) => !m.sending && !m.failed); if (!id || !first) return;
  try {
    const rows = await fetchMsgs(id, first.created_at);
    if (S.active !== id) return;
    const known = new Set(S.msgs.map((m) => m.id));
    S.msgs = rows.filter((r) => !known.has(r.id)).concat(S.msgs);
    S.hasMore = rows.length === PAGE; renderMessages("keep");
  } catch (err) { toast("Could not load older messages: " + errText(err), "error"); }
}
const sortMsgs = () => S.msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

function renderMessages(mode) {
  const box = $("#messages");
  const prevH = box.scrollHeight, prevTop = box.scrollTop;
  const stick = mode === "bottom" || box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  box.replaceChildren();
  if (S.loading) { box.append(h("div", { class: "state" }, h("div", { class: "spinner" }), "Loading messages…")); return; }
  if (S.hasMore) box.append(h("button", { class: "older", type: "button", onclick: loadOlder, text: "Load older messages" }));
  if (!S.msgs.length) box.append(h("div", { class: "state", text: "No messages yet. Say hello 👋" }));
  let lastDay = "";
  for (const m of S.msgs) {
    const day = new Date(m.created_at).toDateString();
    if (day !== lastDay) { lastDay = day; box.append(h("div", { class: "day" }, h("span", { text: dayLabel(m.created_at) }))); }
    box.append(bubble(m));
  }
  if (S.typing) box.append(h("div", { class: "row theirs" }, h("div", { class: "bubble typing" }, h("i"), h("i"), h("i"))));
  if (mode === "keep") box.scrollTop = box.scrollHeight - prevH + prevTop;
  else if (stick) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop;
}

function bubble(m) {
  const mine = m.sender_id === S.user.id;
  const tick = mine ? h("span", { class: "tick" + (m.read_at ? " read" : ""),
    title: m.failed ? "Not sent" : m.sending ? "Sending" : m.read_at ? "Read" : "Sent",
    text: m.failed ? "!" : m.sending ? "🕓" : m.read_at ? "✓✓" : "✓" }) : null;
  const b = h("div", { class: "bubble" + (m.failed ? " failed" : "") },
    h("span", { class: "txt", text: m.body }),
    h("span", { class: "meta" }, h("time", { text: fmtTime(m.created_at) }), tick));
  b.addEventListener("click", () => { S.selected = S.selected === m.id ? null : m.id; renderMessages(); });
  const row = h("div", { class: "row " + (mine ? "mine" : "theirs") }, b);
  if (m.failed) {
    row.append(h("div", { class: "actions" },
      h("button", { type: "button", onclick: () => transmit(m), text: "Not sent — retry" }),
      h("button", { type: "button", class: "danger", onclick: () => { S.msgs = S.msgs.filter((x) => x.id !== m.id); renderMessages(); }, text: "Remove" })));
  } else if (S.selected === m.id) {
    const acts = h("div", { class: "actions" }, h("button", { type: "button", onclick: (e) => { e.stopPropagation(); copyMsg(m); }, text: "Copy" }));
    if (mine) acts.append(h("button", { type: "button", class: "danger", onclick: (e) => { e.stopPropagation(); deleteMsg(m); }, text: "Delete for everyone" }));
    row.append(acts);
  }
  return row;
}

async function copyMsg(m) {
  try { await navigator.clipboard.writeText(m.body); toast("Copied"); }
  catch (e) { toast("Could not copy on this browser.", "error"); }
  S.selected = null; renderMessages();
}

async function deleteMsg(m) {
  const ok = await confirmBox("Delete message?", "This removes the message for everyone in this chat. It cannot be undone.", "Delete");
  if (!ok) return;
  const { data, error } = await sb.from("messages").delete().eq("id", m.id).select("id");
  if (error) { toast("Could not delete: " + errText(error), "error"); return; }
  if (!data || !data.length) { toast("You can only delete your own messages.", "error"); return; }
  S.msgs = S.msgs.filter((x) => x.id !== m.id); S.selected = null; renderMessages(); refreshConvs();
}

/* ---- sending ---- */
const input = $("#msg-input");
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; }
function updateComposer() {
  const off = !navigator.onLine;
  input.disabled = off; $("#btn-send").disabled = off;
  input.placeholder = off ? "Offline — connect to the internet to send" : "Type a message";
}
$("#msg-form").addEventListener("submit", (e) => { e.preventDefault(); send(); });
$("#btn-send").addEventListener("mousedown", (e) => e.preventDefault()); // keep keyboard open
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && matchMedia("(pointer:fine)").matches) { e.preventDefault(); send(); }
});
input.addEventListener("input", () => {
  autosize();
  if (input.value && S.tReady && Date.now() - S.lastTypingSent > 2000) {
    S.lastTypingSent = Date.now();
    S.tChan.send({ type: "broadcast", event: "typing", payload: { from: S.user.id } });
  }
});

async function send() {
  const body = input.value.trim();
  if (!body || !S.active) return;
  if (!navigator.onLine) { toast("You're offline. Messages can only be sent while connected.", "error"); return; }
  input.value = ""; autosize();
  const m = { id: uuid(), conversation_id: S.active, sender_id: S.user.id, body,
    created_at: new Date().toISOString(), read_at: null, sending: true };
  S.msgs.push(m); S.selected = null; renderMessages("bottom");
  await transmit(m);
}

async function transmit(m) {
  m.sending = true; m.failed = false;
  if (S.active === m.conversation_id) renderMessages();
  const { data, error } = await sb.from("messages")
    .insert({ id: m.id, conversation_id: m.conversation_id, body: m.body }).select().single();
  if (error && error.code !== "23505") { m.sending = false; m.failed = true; toast("Message not sent: " + errText(error), "error"); }
  else { if (data) Object.assign(m, data); m.sending = false; m.failed = false; }
  if (S.active === m.conversation_id) { sortMsgs(); renderMessages(); }
  refreshConvs();
}

/* ---- read receipts ---- */
async function markRead() {
  const c = activeConv(); if (!c || !isVisible()) return;
  const pending = c.unread > 0 || S.msgs.some((m) => m.sender_id !== S.user.id && !m.read_at);
  if (!pending) return;
  c.unread = 0; renderList();
  const { error } = await sb.rpc("mark_read", { p_conv: c.id });
  if (error) console.warn("mark_read failed", error.message);
}

/* ====================== delete conversation ====================== */
$("#btn-delchat").onclick = async () => {
  const c = activeConv(); if (!c) return;
  const ok = await confirmBox("Delete chat?",
    `This removes the chat and its history from your account only. ${dn(c)} keeps their copy. If they message you again, the chat reappears with only the new messages.`, "Delete chat");
  if (!ok) return;
  const { error } = await sb.rpc("delete_conversation_for_me", { p_conv: c.id });
  if (error) { toast("Could not delete chat: " + errText(error), "error"); return; }
  S.convs = S.convs.filter((x) => x.id !== c.id);
  if (S.pinned && S.pinned.id === c.id) S.pinned = null;
  closeChat();
  if (history.state && history.state.chat) history.back();
  toast("Chat deleted");
};

/* ====================== realtime ====================== */
function startRealtime() {
  S.dbChan = sb.channel("db-messages")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) => onInsert(p.new))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, (p) => onUpdate(p.new))
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, (p) => onDelete(p.old))
    .subscribe((status) => {
      if (status === "SUBSCRIBED") { const was = S.rtDown; S.rtDown = false; updateBanner(); if (was) resync(); }
      else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) { S.rtDown = true; updateBanner(); }
    });

  const pc = sb.channel("presence-online", { config: { presence: { key: S.user.id } } });
  S.presChan = pc;
  pc.on("presence", { event: "sync" }, () => {
    S.online = new Set(Object.keys(pc.presenceState()));
    renderList(); updateChatHeader();
  }).subscribe(async (status) => {
    if (status === "SUBSCRIBED") await pc.track({ at: new Date().toISOString() });
  });
}

function onInsert(m) {
  if (!S.user || !m) return;
  if (m.conversation_id === S.active) {
    const ex = S.msgs.find((x) => x.id === m.id);
    if (ex) Object.assign(ex, m, { sending: false, failed: false }); else S.msgs.push(m);
    sortMsgs(); renderMessages();
    if (m.sender_id !== S.user.id) { hideTyping(); markRead(); }
  }
  refreshConvs();
}
function onUpdate(m) {
  if (!S.user || !m) return;
  const ex = S.msgs.find((x) => x.id === m.id);
  if (ex) { ex.read_at = m.read_at; renderMessages(); }
  refreshConvs();
}
function onDelete(old) {
  if (!S.user || !old || !old.id) return;
  const n = S.msgs.length; S.msgs = S.msgs.filter((x) => x.id !== old.id);
  if (S.msgs.length !== n) renderMessages();
  refreshConvs();
}

async function resync() {
  if (!S.user) return;
  await loadConvs();
  const id = S.active; if (!id) return;
  try {
    const rows = await fetchMsgs(id); if (S.active !== id) return;
    const ids = new Set(rows.map((r) => r.id));
    S.msgs = rows.concat(S.msgs.filter((m) => (m.sending || m.failed) && !ids.has(m.id)));
    S.hasMore = rows.length === PAGE; sortMsgs(); renderMessages(); markRead();
  } catch (e) { /* will retry on next resync */ }
}

/* ---- typing indicator (broadcast on a per-conversation channel) ---- */
function openTyping(id) {
  closeTyping();
  const ch = sb.channel("typing:" + id, { config: { broadcast: { self: false } } });
  ch.on("broadcast", { event: "typing" }, ({ payload }) => {
    if (payload && payload.from && payload.from !== S.user.id && S.active === id) showTyping();
  }).subscribe((st) => { if (st === "SUBSCRIBED" && S.tChan === ch) S.tReady = true; });
  S.tChan = ch;
}
function closeTyping() {
  if (S.tChan) sb.removeChannel(S.tChan);
  S.tChan = null; S.tReady = false; hideTyping();
}
function showTyping() {
  S.typing = true; clearTimeout(S.typingTimer);
  S.typingTimer = setTimeout(hideTyping, 3500);
  updateChatHeader(); renderMessages();
}
function hideTyping() {
  clearTimeout(S.typingTimer);
  if (!S.typing) return;
  S.typing = false; updateChatHeader(); if (S.active) renderMessages();
}

/* ---- last seen heartbeat ---- */
function touch() { if (S.user && isVisible() && navigator.onLine) sb.rpc("touch_last_seen").then(() => {}, () => {}); }
function startHeartbeat() { touch(); clearInterval(S.hb); S.hb = setInterval(touch, 60000); }

/* ====================== connectivity ====================== */
function updateBanner() {
  const b = $("#banner");
  let msg = "";
  if (!navigator.onLine) msg = "You're offline. Sending and receiving messages requires an internet connection.";
  else if (S.rtDown) msg = "Reconnecting to live updates…";
  b.textContent = msg; b.classList.toggle("hidden", !msg);
  updateComposer();
}
window.addEventListener("offline", updateBanner);
window.addEventListener("online", () => { updateBanner(); resync(); touch(); });
document.addEventListener("visibilitychange", () => { if (isVisible() && S.user) { touch(); resync(); } });

/* ====================== dialogs ====================== */
for (const d of document.querySelectorAll("dialog")) {
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  for (const x of d.querySelectorAll("[data-close]")) x.addEventListener("click", () => d.close());
}
function confirmBox(title, text, okLabel) {
  return new Promise((resolve) => {
    const d = $("#dlg-confirm");
    $("#cf-title").textContent = title; $("#cf-text").textContent = text; $("#cf-ok").textContent = okLabel;
    d.returnValue = "";
    d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true });
    d.showModal();
  });
}

/* ---- new chat: search users ---- */
const searchBox = $("#user-search"), results = $("#search-results");
let searchSeq = 0;
$("#btn-new").onclick = () => {
  searchBox.value = ""; results.replaceChildren(emptyState("Find someone", "Type at least 2 characters of their username."));
  $("#dlg-new").showModal(); searchBox.focus();
};
searchBox.addEventListener("input", debounce(async () => {
  const q = searchBox.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  const seq = ++searchSeq;
  if (q.length < 2) { results.replaceChildren(emptyState("Find someone", "Type at least 2 characters of their username.")); return; }
  results.replaceChildren(h("li", { class: "state" }, h("div", { class: "spinner" }), "Searching…"));
  const { data, error } = await sb.from("profiles").select("id,username,display_name,about,last_seen")
    .like("username", q.replace(/_/g, "\\_") + "%").neq("id", S.user.id).order("username").limit(20);
  if (seq !== searchSeq) return;
  if (error) { results.replaceChildren(emptyState("Search failed", errText(error))); return; }
  if (!data.length) { results.replaceChildren(emptyState("No users found", `Nobody has a username starting with “${q}”.`)); return; }
  results.replaceChildren(...data.map((u) => h("li", { class: "conv", tabindex: "0", role: "button", onclick: () => startChat(u),
      onkeydown: (e) => { if (e.key === "Enter") startChat(u); } },
    avatar(u.display_name || u.username, 44),
    h("div", { class: "conv-main" }, h("div", { class: "conv-name", text: u.display_name || u.username }),
      h("div", { class: "about", text: "@" + u.username + " · " + u.about })))));
}, 300));

async function startChat(u) {
  const { data, error } = await sb.rpc("start_conversation", { p_other: u.id });
  if (error) { toast("Could not start chat: " + errText(error), "error"); return; }
  $("#dlg-new").close();
  let c = S.convs.find((x) => x.id === data);
  if (!c) {
    c = { id: data, otherId: u.id, username: u.username, name: u.display_name, lastSeen: u.last_seen,
      lastBody: null, lastSender: null, lastAt: new Date().toISOString(), lastRead: null, unread: 0 };
    S.pinned = c; S.convs.unshift(c); renderList();
  }
  openConversation(c.id);
}

/* ---- profile ---- */
$("#me-btn").onclick = () => {
  $("#pf-email").value = S.user.email || "";
  $("#pf-username").value = S.profile.username; $("#pf-name").value = S.profile.display_name; $("#pf-about").value = S.profile.about;
  $("#pf-error").textContent = ""; $("#dlg-profile").showModal();
};
$("#btn-theme").onclick = toggleTheme;
$("#form-profile").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("#pf-username").value.trim().toLowerCase(), display_name = $("#pf-name").value.trim(),
    about = $("#pf-about").value.trim(), err = $("#pf-error");
  err.textContent = "";
  if (!USERNAME_RE.test(username)) { err.textContent = "Username must be 3–20 characters: a–z, 0–9 and underscore."; return; }
  if (!about) { err.textContent = "About cannot be empty."; return; }
  const btn = $("#pf-save"); setBusy(btn, true);
  const { data, error } = await sb.from("profiles").update({ username, display_name, about }).eq("id", S.user.id).select().single();
  setBusy(btn, false);
  if (error) { err.textContent = error.code === "23505" ? "That username is taken." : errText(error); return; }
  S.profile = data; renderMe(); $("#dlg-profile").close(); toast("Profile saved");
});

/* ====================== service worker ====================== */
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
})();
