// Scratch Colab - the extension side of the Scratch tab.
// Keeps the room in Firebase (Realtime Database, over its REST + streaming API),
// and passes changes between Firebase and page.js, which works with the editor.
(() => {
  "use strict";
  if (window.__scratchColabContent) return;
  window.__scratchColabContent = true;

  const DEFAULT_DB = "https://colab-e77ed-default-rtdb.firebaseio.com";
  const FROM_PAGE = "scratch-colab:page";
  const TO_PAGE = "scratch-colab:ext";
  const CHUNK = 4 * 1024 * 1024; // characters of base64 per Firebase value
  const COLORS = ["#4c97ff", "#9966ff", "#cf63cf", "#ffab19", "#59c059", "#ff6680", "#5cb1d6", "#ff8c1a"];

  // ---------- small helpers ----------
  const now = () => Date.now();
  const randomId = (n, abc = "abcdefghijkmnpqrstuvwxyz23456789") => {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    return Array.from(bytes, (b) => abc[b % abc.length]).join("");
  };
  const toB64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (b64) => {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out.buffer;
  };
  const dec = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
  const spriteLabel = (tk) => (tk === "_stage_" ? "the Stage" : dec(tk));
  const cleanCode = (c) => String(c || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  // ---------- settings ----------
  let settings = { db: DEFAULT_DB, name: "" };
  const loadSettings = async () => {
    const s = await chrome.storage.local.get(["db", "name"]);
    settings.db = (s.db || DEFAULT_DB).replace(/\/+$/, "");
    settings.name = s.name || "";
  };
  chrome.storage.onChanged.addListener(() => loadSettings().then(sendState));

  let scratchName = "";
  async function myName() {
    if (settings.name) return settings.name;
    if (!scratchName) {
      try {
        const r = await fetch("/session/", { headers: { "X-Requested-With": "XMLHttpRequest" }, credentials: "include" });
        const j = await r.json();
        scratchName = (j && j.user && j.user.username) || "";
      } catch (_) { /* not signed in */ }
      if (!scratchName) scratchName = "Scratcher " + randomId(3, "0123456789");
    }
    return scratchName;
  }

  // ---------- Firebase REST ----------
  // Firebase rejects some non-ASCII text ("Non-ascii character in FixedAsciiString"), so emoji
  // and accents in sprite names, costume names or block text are sent as \uXXXX escapes.
  // JSON reads them back as the same characters.
  const asciiJson = (v) => JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  async function fb(path, method = "GET", body) {
    const url = `${settings.db}/${path}.json`;
    let res;
    try {
      res = await fetch(url, { method, headers: body !== undefined ? { "Content-Type": "application/json; charset=utf-8" } : undefined, body: body !== undefined ? asciiJson(body) : undefined });
    } catch (err) {
      throw new Error("Couldn't reach Firebase. Check your connection and the database address in settings.");
    }
    if (res.status === 401 || res.status === 403) throw new Error("Firebase said no (permission denied). Check the database rules in the README.");
    if (!res.ok) throw new Error(`Firebase error ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return res.json();
  }

  // ---------- talking to page.js ----------
  let msgId = 0;
  const waiting = new Map();
  function callPage(type, data = {}, timeout = 60000) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { waiting.delete(id); reject(new Error("The Scratch editor didn't answer. Reload the page and try again.")); }, timeout);
      waiting.set(id, (r) => { clearTimeout(t); r.ok ? resolve(r) : reject(new Error(r.error || "Something went wrong in the editor.")); });
      window.postMessage({ source: TO_PAGE, id, type, ...data }, "*");
    });
  }
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (ev.source !== window || !m || m.source !== FROM_PAGE) return;
    if (m.type === "reply") { const cb = waiting.get(m.id); if (cb) { waiting.delete(m.id); cb(m); } return; }
    if (m.type === "local-changes") return void chain(() => sendLocal(m.changes));
    if (m.type === "editing") { editingName = m.name; return void heartbeat(); }
    if (m.type === "error") return void addFeed(null, m.message, true);
    if (m.type === "editor-ready") return void sendState();
  });

  // ---------- room state ----------
  let room = null;        // { code, cid, rev, color, host }
  let mirror = {};        // copy of rooms/<code>/live
  let seen = {};          // flattened entries already handled
  let es = null;          // EventSource
  let busy = "";          // what we're doing right now, for the panel
  let error = "";
  let feed = [];
  let editingName = "";
  let pendingScripts = [];
  let beatTimer = null;
  let connected = false;

  const PREV = "scratchColabRoom";
  const prevRoom = () => { try { return JSON.parse(sessionStorage.getItem(PREV) || "null"); } catch (_) { return null; } };

  // Do one thing at a time, in order.
  let queue = Promise.resolve();
  const chain = (fn) => (queue = queue.then(fn).catch((err) => { addFeed(null, String(err.message || err), true); }));

  function addFeed(who, text, bad = false) {
    feed.unshift({ who, text, bad, at: now() });
    feed = feed.slice(0, 40);
    sendState();
  }

  function people() {
    const p = mirror.people || {};
    return Object.entries(p)
      .filter(([, v]) => v && now() - (v.at || 0) < 75000)
      .map(([cid, v]) => ({ name: v.name, color: v.color, editing: v.editing || "", me: room && cid === room.cid }))
      .sort((a, b) => (b.me ? 1 : 0) - (a.me ? 1 : 0));
  }
  const nameOf = (cid) => (mirror.people && mirror.people[cid] && mirror.people[cid].name) || "A teammate";

  async function state() {
    let editor = false, codeArea = false;
    try { const r = await callPage("status", {}, 1500); editor = r.editor; codeArea = r.codeArea; } catch (_) { /* page not ready */ }
    const prev = prevRoom();
    return {
      url: location.href, editor, codeArea, busy, error, feed,
      room: room ? { code: room.code, host: room.host, connected, people: people(), title: (mirror.meta && mirror.meta.title) || "" } : null,
      rejoin: !room && prev ? prev.code : "",
      settings: { db: settings.db, name: settings.name, defaultDb: DEFAULT_DB },
    };
  }
  let stateTimer = null;
  function sendState() {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(async () => {
      try { chrome.runtime.sendMessage({ type: "colab-state", state: await state() }); } catch (_) { /* panel closed */ }
    }, 60);
  }

  // ---------- project file in Firebase ----------
  async function uploadProject(code, rev) {
    const { data, title } = await callPage("save");
    if (!data || !data.byteLength) throw new Error("Couldn't read the project from Scratch. Reload the page and try again.");
    const b64 = toB64(data);
    const chunks = Math.max(1, Math.ceil(b64.length / CHUNK));
    for (let i = 0; i < chunks; i++) {
      busy = chunks > 1 ? `Uploading the project (${i + 1} of ${chunks})...` : "Uploading the project...";
      sendState();
      await fb(`rooms/${code}/files/${rev}/${i}`, "PUT", b64.slice(i * CHUNK, (i + 1) * CHUNK));
    }
    return { chunks, title, size: data.byteLength };
  }
  async function downloadProject(code, meta) {
    let b64 = "";
    for (let i = 0; i < meta.chunks; i++) {
      busy = meta.chunks > 1 ? `Downloading the project (${i + 1} of ${meta.chunks})...` : "Downloading the project...";
      sendState();
      const part = await fb(`rooms/${code}/files/${meta.rev}/${i}`);
      if (typeof part !== "string") throw new Error("The shared project is missing. Ask the person who started the colab to press Send my version to everyone.");
      b64 += part;
    }
    if (!b64) throw new Error("The shared project is empty. Ask the person who started the colab to press Send my version to everyone.");
    return fromB64(b64);
  }

  // ---------- start / join / leave ----------
  async function start() {
    if (room) throw new Error("You're already in a colab. Leave it first.");
    const code = randomId(10);
    const cid = randomId(12);
    const rev = randomId(8);
    const name = await myName();
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    busy = "Getting the project ready..."; error = ""; sendState();
    await callPage("flush").catch(() => {});
    const up = await uploadProject(code, rev);
    await fb(`rooms/${code}/live`, "PUT", {
      meta: { rev, chunks: up.chunks, by: cid, at: { ".sv": "timestamp" }, title: up.title, created: { ".sv": "timestamp" } },
      people: { [cid]: { name, color, at: now(), editing: editingName } },
    });
    room = { code, cid, rev, color, host: true };
    await callPage("start");
    beginLive();
    addFeed(null, `You started a colab${up.title ? ` on "${up.title}"` : ""}. Share the code so others can join.`);
  }

  async function join(rawCode) {
    if (room) throw new Error("You're already in a colab. Leave it first.");
    const code = cleanCode(rawCode);
    if (code.length < 6) throw new Error("That code looks too short. Codes are 10 letters and numbers.");
    busy = "Finding the colab..."; error = ""; sendState();
    const meta = await fb(`rooms/${code}/live/meta`);
    if (!meta || !meta.rev) throw new Error("No colab with that code. Check it and try again.");
    const data = await downloadProject(code, meta);
    busy = "Opening the project..."; sendState();
    await callPage("load", { data });
    const cid = randomId(12);
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    room = { code, cid, rev: meta.rev, color, host: false };
    await callPage("start");
    await fb(`rooms/${code}/live/people/${cid}`, "PUT", { name: await myName(), color, at: now(), editing: editingName });
    beginLive();
    addFeed(null, `You joined${meta.title ? ` "${meta.title}"` : " the colab"}.`);
  }

  async function leave() {
    if (!room) return;
    const r = room;
    stopLive();
    room = null;
    sessionStorage.removeItem(PREV);
    await callPage("stop").catch(() => {});
    await fb(`rooms/${r.code}/live/people/${r.cid}`, "DELETE").catch(() => {});
    feed = [];
  }

  // Replace everyone's copy with this tab's project. Fixes anything that drifted,
  // and carries things that don't sync live (backdrops, comments).
  async function resync() {
    if (!room) return;
    await callPage("flush").catch(() => {});
    const rev = randomId(8);
    const old = room.rev;
    const up = await uploadProject(room.code, rev);
    room.rev = rev;
    await fb(`rooms/${room.code}/live`, "PATCH", {
      meta: { rev, chunks: up.chunks, by: room.cid, at: { ".sv": "timestamp" }, title: up.title, created: (mirror.meta && mirror.meta.created) || { ".sv": "timestamp" } },
      scripts: null, vars: null, sprites: null,
    });
    await fb(`rooms/${room.code}/files/${old}`, "DELETE").catch(() => {});
    await fb(`rooms/${room.code}/spritefiles`, "DELETE").catch(() => {});
    busy = "";
    addFeed(null, "You sent your version of the project to everyone.");
  }

  // ---------- live updates ----------
  function beginLive() {
    sessionStorage.setItem(PREV, JSON.stringify({ code: room.code }));
    mirror = {}; seen = {}; pendingScripts = [];
    busy = ""; error = "";
    openStream();
    clearInterval(beatTimer);
    beatTimer = setInterval(heartbeat, 20000);
    sendState();
  }
  function stopLive() {
    if (es) es.close();
    es = null; connected = false;
    clearInterval(beatTimer);
    mirror = {}; seen = {};
  }
  async function heartbeat() {
    if (!room) return;
    try {
      await fb(`rooms/${room.code}/live/people/${room.cid}`, "PATCH", { name: await myName(), color: room.color, at: now(), editing: editingName });
    } catch (_) { /* next beat will retry */ }
    sendState();
  }

  function openStream() {
    if (es) es.close();
    const code = room.code;
    es = new EventSource(`${settings.db}/rooms/${code}/live.json`);
    const onData = (kind) => (ev) => {
      if (!room || room.code !== code) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      applyToMirror(kind, msg.path, msg.data);
      connected = true;
      chain(process);
    };
    es.addEventListener("put", onData("put"));
    es.addEventListener("patch", onData("patch"));
    es.addEventListener("cancel", () => { error = "Firebase stopped the live connection (permission denied). Check the database rules."; connected = false; sendState(); });
    es.onerror = () => { connected = false; sendState(); };
    es.onopen = () => { connected = true; sendState(); };
  }

  function setAt(obj, parts, value) {
    if (!parts.length) return value;
    const [head, ...rest] = parts;
    const base = obj && typeof obj === "object" ? obj : {};
    const next = setAt(base[head], rest, value);
    if (next === null || next === undefined) delete base[head]; else base[head] = next;
    return base;
  }
  function applyToMirror(kind, path, data) {
    const parts = String(path || "/").split("/").filter(Boolean);
    if (kind === "put") mirror = setAt(mirror, parts, data) || {};
    else for (const [k, v] of Object.entries(data || {})) mirror = setAt(mirror, parts.concat(k.split("/").filter(Boolean)), v) || {};
  }

  function flatten() {
    const out = {};
    for (const [tk, list] of Object.entries(mirror.scripts || {})) for (const [id, v] of Object.entries(list || {})) out[`s/${tk}/${id}`] = v;
    for (const [tk, list] of Object.entries(mirror.vars || {})) for (const [id, v] of Object.entries(list || {})) out[`v/${tk}/${id}`] = v;
    for (const [tk, v] of Object.entries(mirror.sprites || {})) out[`p/${tk}`] = v;
    return out;
  }

  async function process() {
    if (!room) return;
    const meta = mirror.meta || {};

    // Someone sent their whole project: load it.
    if (meta.rev && meta.rev !== room.rev) {
      room.rev = meta.rev;
      if (meta.by !== room.cid) {
        const data = await downloadProject(room.code, meta);
        busy = "Opening the new version..."; sendState();
        await callPage("load", { data });
        await callPage("start");
        busy = "";
        addFeed(nameOf(meta.by), "sent their version of the project to everyone.");
      }
      seen = {};
      pendingScripts = [];
    }

    const flat = flatten();
    const changes = { scripts: [], vars: [], sprites: [] };
    const told = new Map(); // who -> Set of descriptions
    const tell = (by, text) => { if (!told.has(by)) told.set(by, new Set()); told.get(by).add(text); };

    for (const [key, v] of Object.entries(flat)) {
      const str = JSON.stringify(v);
      if (seen[key] === str) continue;
      seen[key] = str;
      if (!v || v.by === room.cid) continue;
      const [kind, tk, rawId] = key.split("/");
      if (kind === "s") {
        changes.scripts.push({ tk, id: dec(rawId), b: v.b || null });
        tell(v.by, `${v.b ? "changed" : "removed"} a script in ${spriteLabel(tk)}`);
      } else if (kind === "v") {
        changes.vars.push({ tk, id: dec(rawId), v: v.del ? null : { n: v.n, t: v.t || "", c: !!v.c } });
        const what = v.t === "list" ? "list" : v.t === "broadcast_msg" ? "message" : "variable";
        tell(v.by, `${v.del ? "deleted" : "updated"} the ${what} "${v.n}"`);
      } else if (kind === "p") {
        if (v.del) { changes.sprites.push({ tk, deleted: true }); tell(v.by, `deleted ${spriteLabel(tk)}`); continue; }
        const file = await fb(`rooms/${room.code}/spritefiles/${encodeURIComponent(tk)}`);
        if (!file || typeof file.d !== "string") continue;
        changes.sprites.push({ tk, name: v.name, data: fromB64(file.d) });
        tell(v.by, `${v.isNew ? "added" : "updated the costumes or sounds of"} ${v.name}`);
      }
    }
    for (const k of Object.keys(seen)) if (!(k in flat)) delete seen[k];

    changes.scripts = pendingScripts.concat(changes.scripts);
    pendingScripts = [];
    if (!changes.scripts.length && !changes.vars.length && !changes.sprites.length) { sendState(); return; }

    const r = await callPage("apply", { changes }, 120000);
    if (r.pending) pendingScripts = (r.pending.scripts || []);
    for (const [by, set] of told) for (const text of set) addFeed(nameOf(by), text);
  }

  // ---------- sending this tab's changes ----------
  async function sendLocal(ch) {
    if (!room) return;
    const code = room.code, cid = room.cid;
    const name = await myName();
    const at = { ".sv": "timestamp" };
    const patch = {};
    const k = (s) => encodeURIComponent(String(s)).replace(/\./g, "%2E");
    let bigSprite = "";

    for (const s of ch.sprites || []) {
      if (s.deleted) { patch[`sprites/${s.tk}`] = { del: true, by: cid, who: name, at }; continue; }
      if (!s.data) { addFeed(null, `Couldn't send ${s.name}'s costumes: ${s.error || "unknown problem"}`, true); continue; }
      const d = toB64(s.data);
      if (d.length > 9.5 * 1024 * 1024) { bigSprite = s.name; continue; }
      const v = randomId(6);
      await fb(`rooms/${code}/spritefiles/${encodeURIComponent(s.tk)}`, "PUT", { v, d });
      patch[`sprites/${s.tk}`] = { name: s.name, sig: s.sig, v, isNew: !!s.isNew, by: cid, who: name, at };
    }
    for (const v of ch.vars || []) {
      patch[`vars/${v.tk}/${k(v.id)}`] = v.v ? { n: v.v.n, t: v.v.t, c: v.v.c, by: cid, at } : { del: true, n: "", by: cid, at };
    }
    for (const s of ch.scripts || []) {
      patch[`scripts/${s.tk}/${k(s.id)}`] = { b: s.b, by: cid, at };
    }
    if (Object.keys(patch).length) await fb(`rooms/${code}/live`, "PATCH", patch);
    if (bigSprite) addFeed(null, `${bigSprite} is too big to send live. Press Send my version to everyone instead.`, true);
    if ((ch.notes || []).includes("backdrops")) addFeed(null, "Backdrop changes don't sync live. Press Send my version to everyone when you're done.");
  }

  // ---------- messages from the side panel ----------
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg || msg.type !== "colab") return;
    const run = async () => {
      try {
        if (msg.action === "state") { /* just report */ }
        else if (msg.action === "start") await start();
        else if (msg.action === "join") await join(msg.code);
        else if (msg.action === "leave") await leave();
        else if (msg.action === "resync") await resync();
        else if (msg.action === "clear-feed") feed = [];
        error = "";
      } catch (err) {
        error = String(err && err.message || err);
        if (msg.action === "start" || msg.action === "join") { stopLive(); room = null; }
      }
      busy = "";
      const s = await state();
      respond(s);
      sendState();
    };
    if (msg.action === "state") run(); else chain(run);
    return true;
  });

  window.addEventListener("pagehide", () => {
    if (!room) return;
    try { fetch(`${settings.db}/rooms/${room.code}/live/people/${room.cid}.json`, { method: "DELETE", keepalive: true }); } catch (_) { /* best effort */ }
  });

  loadSettings().then(sendState);
})();
