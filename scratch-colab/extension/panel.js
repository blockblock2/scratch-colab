// Scratch Colab side panel. Talks to content.js in the active Scratch tab.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const view = $("view");
  const EDITOR_URL = "https://scratch.mit.edu/projects/editor/";
  const DEFAULT_DB = "https://colab-e77ed-default-rtdb.firebaseio.com";

  let tabId = null;
  let last = null;
  let working = false;
  let codeDraft = "";

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 45) return "now";
    if (s < 3600) return Math.round(s / 60) + "m";
    return Math.round(s / 3600) + "h";
  };
  // A little robot face for Scratchity's dot.
  const BOT_FACE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="2" y="4" width="12" height="9" rx="2.5" fill="#fff"/><rect x="7.25" y="1" width="1.5" height="3" fill="#fff"/><circle cx="5.5" cy="8.5" r="1.4" fill="#855cd6"/><circle cx="10.5" cy="8.5" r="1.4" fill="#855cd6"/></svg>';
  const isScratchProject = (url) => /^https:\/\/scratch\.mit\.edu\/projects\//.test(url || "");

  function setBusy(text) {
    $("busy").hidden = !text;
    $("busy-text").textContent = text || "";
  }
  function setBanner(text, info = false) {
    const b = $("banner");
    b.hidden = !text;
    b.textContent = text || "";
    b.classList.toggle("info", info);
  }

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  function send(action, extra = {}) {
    return new Promise((resolve) => {
      if (tabId === null) return resolve(null);
      chrome.tabs.sendMessage(tabId, { type: "colab", action, ...extra }, (res) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(res || null);
      });
    });
  }

  async function refresh() {
    const tab = await activeTab();
    tabId = tab ? tab.id : null;
    if (!tab || !isScratchProject(tab.url)) return render({ notScratch: true });
    const s = await send("state");
    if (!s) return render({ noScript: true });
    render(s);
  }

  async function act(action, extra) {
    if (working) return;
    working = true;
    setBanner("");
    setBusy(action === "start" ? "Starting the colab..." : action === "join" ? "Joining..." : action === "resync" ? "Sending your version..." : "");
    disableAll(true);
    const s = await send(action, extra);
    working = false;
    if (!s) { render({ noScript: true }); return; }
    render(s);
  }
  const disableAll = (on) => view.querySelectorAll("button, input").forEach((el) => { el.disabled = on; });

  // ---------- rendering ----------
  function render(s) {
    last = s;
    if (!working) setBusy(s.busy || "");
    setBanner(s.error || "");

    if (s.notScratch) {
      view.innerHTML = `
        <section class="card hat">
          <h2>Open a Scratch project</h2>
          <p>Go to a project on Scratch and click <b>See inside</b>, or start a new one. Then come back here to start or join a colab.</p>
          <button class="act primary" id="open-editor">Open the Scratch editor</button>
        </section>
        ${howItWorks()}`;
      $("open-editor").onclick = () => chrome.tabs.create({ url: EDITOR_URL });
      return;
    }
    if (s.noScript) {
      view.innerHTML = `
        <section class="card hat">
          <h2>Reload this Scratch tab</h2>
          <p>Scratch Colab can't see this tab yet. That happens when the tab was open before the extension was installed or updated.</p>
          <button class="act primary" id="reload-tab">Reload the tab</button>
        </section>`;
      $("reload-tab").onclick = () => { chrome.tabs.reload(tabId); setTimeout(refresh, 2500); };
      return;
    }
    if (s.room) return renderRoom(s);
    renderLobby(s);
  }

  function renderLobby(s) {
    const editorNote = s.editor ? "" : `<p class="banner info">Click <b>See inside</b> on this project to open the editor first.</p>`;
    view.innerHTML = `
      ${editorNote}
      ${s.rejoin ? `
      <section class="card motion">
        <h2>Rejoin your colab?</h2>
        <p>This tab was in colab <b>${esc(s.rejoin)}</b> before it reloaded.</p>
        <button class="act primary" id="rejoin">Rejoin</button>
      </section>` : ""}
      <section class="card hat">
        <h2>Start a colab</h2>
        <p>Shares the project open in this tab with anyone you give the code to. It stays unshared on Scratch.</p>
        <button class="act event wide" id="start" ${s.editor ? "" : "disabled"}>Start a colab</button>
      </section>
      <section class="card motion">
        <h2>Join a colab</h2>
        <label for="code">Colab code</label>
        <input id="code" class="code-input" type="text" maxlength="20" autocomplete="off" spellcheck="false" placeholder="e.g. k7m2xq9pda" value="${esc(codeDraft)}">
        <p class="hint">Joining replaces the project in this tab. Click <b>Create</b> on Scratch first, so you don't overwrite one of your own projects.</p>
        <button class="act primary wide" id="join" ${s.editor ? "" : "disabled"}>Join</button>
      </section>
      ${howItWorks()}`;
    $("start").onclick = () => act("start");
    const input = $("code");
    input.oninput = () => { codeDraft = input.value; };
    input.onkeydown = (e) => { if (e.key === "Enter") $("join").click(); };
    $("join").onclick = () => {
      const code = input.value.trim();
      if (!code) { input.focus(); return; }
      act("join", { code });
    };
    if ($("rejoin")) $("rejoin").onclick = () => act("join", { code: s.rejoin });
  }

  function renderRoom(s) {
    const r = s.room;
    const people = r.people.length ? r.people : [];
    view.innerHTML = `
      <section class="card hat">
        <div class="row" style="justify-content:space-between">
          <h2>${r.title ? esc(r.title) : "Your colab"}</h2>
          <span class="live ${r.connected ? "" : "off"}">${r.connected ? "Live" : "Reconnecting..."}</span>
        </div>
        <p>Give this code to the people you want to build with. They paste it in Scratch Colab and press Join.</p>
        <div class="code-box"><code id="room-code">${esc(r.code)}</code><button class="act" id="copy">Copy</button></div>
        <ul class="people">
          ${people.map((p) => `
            <li>
              <span class="dot${p.bot ? " bot" : ""}" style="background:${esc(p.color || "#4c97ff")}">${p.bot ? BOT_FACE : esc((p.name || "?").slice(0, 1).toUpperCase())}</span>
              <span>${esc(p.name || "Someone")}${p.bot ? ` <span class="bot-tag">BOT</span>` : ""}${p.me ? " (you)" : ""}</span>
              <span class="where">${p.bot ? (p.via ? "with " + esc(p.via) : "") : p.editing ? "in " + esc(p.editing) : ""}</span>
            </li>`).join("")}
        </ul>
      </section>
      <section class="card bot-card">
        <div class="row" style="justify-content:space-between">
          <h2>Scratchity <span class="bot-tag">BOT</span></h2>
          ${r.botInvited
            ? `<button class="act" id="bot-remove">Remove</button>`
            : `<button class="act event" id="bot-invite">Invite</button>`}
        </div>
        <p>${r.botInvited
          ? "Scratchity is in the colab. Open Scratchity's side panel and ask for something: the blocks it adds show up for everyone as Scratchity [BOT]."
          : "Bring Scratchity in as a teammate. Anything Scratchity adds to this project shows up for everyone as Scratchity [BOT], even if you don't invite it first."}</p>
        <a class="act ghost" href="https://scratchity.pages.dev" target="_blank" rel="noopener">Don't have Scratchity?</a>
      </section>
      <section class="card">
        <div class="row" style="justify-content:space-between">
          <h2>What's happening</h2>
          ${s.feed.length ? `<button class="act ghost" id="clear">Clear</button>` : ""}
        </div>
        ${s.feed.length ? `<ul class="feed">${s.feed.map((f) => `
          <li class="${f.bad ? "bad" : ""}"><time>${ago(f.at)}</time>${f.who ? `<b>${esc(f.who)}</b> ` : ""}${esc(f.text)}</li>`).join("")}</ul>`
          : `<p class="empty">Changes from your teammates show up here, and in your project right away.</p>`}
      </section>
      <section class="card">
        <h2>Out of sync?</h2>
        <p>Sends the project in this tab to everyone, replacing their copy. Use it after changing backdrops, or if something looks different on someone's screen.</p>
        <div class="row">
          <button class="act" id="resync">Send my version to everyone</button>
          <button class="act danger" id="leave">Leave colab</button>
        </div>
      </section>`;
    $("copy").onclick = async () => {
      try { await navigator.clipboard.writeText(r.code); $("copy").textContent = "Copied"; } catch (_) { $("copy").textContent = "Select it"; }
      setTimeout(() => { if ($("copy")) $("copy").textContent = "Copy"; }, 1500);
    };
    $("resync").onclick = () => {
      if (confirm("Replace everyone's copy of the project with yours?")) act("resync");
    };
    $("leave").onclick = () => {
      if (confirm("Leave this colab? Your project stays in this tab, but stops syncing.")) act("leave");
    };
    if ($("clear")) $("clear").onclick = () => act("clear-feed");
    if ($("bot-invite")) $("bot-invite").onclick = () => act("invite-bot");
    if ($("bot-remove")) $("bot-remove").onclick = () => act("remove-bot");
  }

  const howItWorks = () => `
    <section class="card">
      <h2>How it works</h2>
      <p>Everyone works in their own Scratch tab. When someone changes a script, a variable or a sprite, it shows up for everyone else in a second or two. Nothing gets shared on Scratch. When you're done, anyone can save a copy with <b>File \u2192 Save to your computer</b>, or save it to their own account.</p>
    </section>`;

  // ---------- settings ----------
  $("gear").onclick = async () => {
    const st = await chrome.storage.local.get(["db", "name"]);
    $("set-name").value = st.name || "";
    $("set-db").value = st.db || DEFAULT_DB;
    $("settings").hidden = false;
    $("set-name").focus();
  };
  $("set-close").onclick = () => { $("settings").hidden = true; };
  $("set-reset").onclick = () => { $("set-db").value = DEFAULT_DB; };
  $("set-save").onclick = async () => {
    const db = $("set-db").value.trim().replace(/\/+$/, "") || DEFAULT_DB;
    if (!/^https:\/\/[^/]+\.(firebaseio\.com|firebasedatabase\.app)$/.test(db)) {
      setBanner("The database address should look like https://your-project-default-rtdb.firebaseio.com");
      return;
    }
    await chrome.storage.local.set({ db, name: $("set-name").value.trim() });
    $("settings").hidden = true;
    setBanner("Saved.", true);
    setTimeout(() => { if ($("banner").textContent === "Saved.") setBanner(""); }, 1500);
  };

  // ---------- keep in step with the tab ----------
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== "colab-state" || !sender.tab || sender.tab.id !== tabId || working) return;
    const typing = document.activeElement && document.activeElement.id === "code";
    if (typing && !msg.state.room) return; // don't redraw under someone typing a code
    render(msg.state);
  });
  chrome.tabs.onActivated.addListener(refresh);
  chrome.tabs.onUpdated.addListener((id, info) => { if (id === tabId && (info.status === "complete" || info.url)) refresh(); });
  setInterval(() => { if (last && last.room && !working) refresh(); }, 15000);
  refresh();
})();
