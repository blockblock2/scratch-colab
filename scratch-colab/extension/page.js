// Scratch Colab - runs inside the Scratch editor page (main world).
// Watches the project for changes, sends them out, and puts teammates' changes in.
// Talks to content.js (the extension side) with window.postMessage.
//
// Code goes in the same way Scratchity adds blocks: through the editor's own code area
// (like pasting or dropping from the backpack), so the editor stays in charge of the project.
(() => {
  "use strict";
  if (window.__scratchColab) return;
  window.__scratchColab = true;

  const FROM_PAGE = "scratch-colab:page";
  const TO_PAGE = "scratch-colab:ext";
  const STAGE_KEY = "_stage_";

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => {
    await new Promise((r) => requestAnimationFrame(() => r()));
    await wait(250);
  };
  const post = (type, data = {}) => window.postMessage({ source: FROM_PAGE, type, ...data }, "*");

  // ---------- finding the editor (same approach as Scratchity) ----------
  function findEditor() {
    const node = document.querySelector('[class*="blocks_blocks"]');
    let vm = null;
    if (node) {
      const key = Object.keys(node).find((k) => k.startsWith("__reactInternalInstance$") || k.startsWith("__reactFiber$"));
      let f = key && node[key], hops = 0;
      while (f && hops++ < 300) {
        const st = f.stateNode;
        if (st && st.workspace && st.ScratchBlocks && st.props && st.props.vm) return { vm: st.props.vm, ws: st.workspace, SB: st.ScratchBlocks };
        const p = f.memoizedProps;
        if (!vm && p && p.vm && p.vm.runtime) vm = p.vm;
        f = f.return;
      }
    }
    return vm ? { vm, ws: null, SB: null } : null;
  }

  let ed = null;
  const editor = () => {
    if (!ed || !ed.ws || !document.contains(ed.ws.getParentSvg ? ed.ws.getParentSvg() : document.body)) ed = findEditor();
    return ed;
  };

  // ---------- keys ----------
  // Firebase keys can't contain . $ # [ ] /, and Scratch block ids often do.
  const enc = (s) => encodeURIComponent(String(s)).replace(/\./g, "%2E");
  const dec = (s) => decodeURIComponent(s);
  const targetKey = (t) => (t.isStage ? STAGE_KEY : enc(t.getName()));
  const originals = (vm) => vm.runtime.targets.filter((t) => t.isOriginal);
  const targetByKey = (vm, tk) => originals(vm).find((t) => targetKey(t) === tk) || null;

  // ---------- reading the project ----------
  const BLOCK_FIELDS = ["id", "opcode", "next", "parent", "inputs", "fields", "shadow", "topLevel", "x", "y", "mutation"];
  function scriptBlocks(target, topId) {
    const all = target.blocks._blocks;
    const out = [];
    const seen = new Set();
    const walk = (id) => {
      if (!id || seen.has(id) || !all[id]) return;
      seen.add(id);
      const b = all[id];
      const copy = {};
      for (const k of BLOCK_FIELDS) if (b[k] !== undefined) copy[k] = b[k];
      if (copy.x !== undefined) copy.x = Math.round(copy.x);
      if (copy.y !== undefined) copy.y = Math.round(copy.y);
      out.push(JSON.parse(JSON.stringify(copy)));
      for (const name in b.inputs) {
        walk(b.inputs[name].block);
        walk(b.inputs[name].shadow);
      }
      walk(b.next);
    };
    walk(topId);
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }
  const readScripts = (target) => {
    const map = {};
    for (const id of target.blocks.getScripts()) {
      const b = target.blocks.getBlock(id);
      if (!b || b.parent) continue;
      map[id] = JSON.stringify(scriptBlocks(target, id));
    }
    return map;
  };
  const readVars = (target) => {
    const map = {};
    for (const [id, v] of Object.entries(target.variables)) map[id] = JSON.stringify({ n: v.name, t: v.type || "", c: !!v.isCloud });
    return map;
  };
  const artSig = (target) => JSON.stringify({
    c: target.getCostumes().map((c) => [c.name, c.assetId, c.rotationCenterX, c.rotationCenterY]),
    s: target.getSounds().map((s) => [s.name, s.assetId]),
  });

  // What this tab last sent or received, so we only send real changes.
  // known.scripts[tk][topId] = json, known.vars[tk][id] = json, known.art[tk] = sig
  let known = { scripts: {}, vars: {}, art: {} };
  function baselineTarget(t) {
    const tk = targetKey(t);
    known.scripts[tk] = readScripts(t);
    known.vars[tk] = readVars(t);
    known.art[tk] = artSig(t);
  }
  function baselineAll() {
    const e = editor();
    known = { scripts: {}, vars: {}, art: {} };
    if (e) for (const t of originals(e.vm)) baselineTarget(t);
  }

  // ---------- sending local changes ----------
  let live = false;       // in a room and ready
  // Other extensions (Scratchity) can see whether a colab is going: <html data-scratch-colab="live">.
  const setLive = (on) => {
    live = on;
    if (on) document.documentElement.dataset.scratchColab = "live";
    else delete document.documentElement.dataset.scratchColab;
  };
  let applying = 0;       // while > 0, our own edits are teammates' changes, not ours
  let scanTimer = null;

  // ---------- Scratchity [BOT] ----------
  // Scratchity adds blocks with a function named scratchityInsert, through the same code area.
  // While that function is running (and a moment after, while the editor catches up), changes
  // are Scratchity's, so teammates see them as Scratchity [BOT].
  let botDepth = 0, botUntil = 0, botPending = false;
  const botBusy = () => botDepth > 0 || Date.now() < botUntil;
  const calledByScratchity = () => /scratchityInsert/.test(String(new Error().stack || ""));
  let botPosted = 0;
  function botStart() {
    botDepth++; botPending = true;
    if (Date.now() - botPosted > 1000) { botPosted = Date.now(); post("bot-active", {}); }
  }
  function botEnd() { botDepth = Math.max(0, botDepth - 1); botUntil = Date.now() + 2500; }
  function wrapForBot(obj, name) {
    const orig = obj && obj[name];
    if (typeof orig !== "function" || orig.__colabBot) return;
    const wrapped = function (...args) {
      const bot = calledByScratchity();
      if (bot) botStart();
      let out;
      try { out = orig.apply(this, args); } catch (err) { if (bot) botEnd(); throw err; }
      if (bot) { if (out && typeof out.then === "function") out.then(botEnd, botEnd); else botEnd(); }
      return out;
    };
    wrapped.__colabBot = true;
    try { obj[name] = wrapped; } catch (_) { /* locked object: the other hooks still catch it */ }
  }
  function hookBot(e) {
    if (e.SB && e.SB.Xml) wrapForBot(e.SB.Xml, "domToWorkspace");
    for (const fn of ["addSprite", "shareBlocksToTarget"]) wrapForBot(e.vm, fn);
    // Scratchity turns its blocks into XML with the VM's own blockToXML just before adding them.
    const stage = e.vm.runtime.getTargetForStage && e.vm.runtime.getTargetForStage();
    if (stage && stage.blocks) wrapForBot(Object.getPrototypeOf(stage.blocks), "blockToXML");
  }
  // A future Scratchity can also say so directly.
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (ev.source !== window || !m || m.source !== "scratchity") return;
    if (m.type === "bot-start") botStart();
    else if (m.type === "bot-end") botEnd();
  });

  const queueScan = (ms = 450) => {
    if (!live) return;
    if (botBusy()) botPending = true;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, ms);
  };

  async function scan() {
    const e = editor();
    if (!live || !e) return;
    if (applying || botDepth > 0) { queueScan(300); return; }
    const vm = e.vm;
    const bot = botPending || botBusy();
    botPending = false;
    const changes = { scripts: [], vars: [], sprites: [], notes: [], bot };
    const seenTks = new Set();

    for (const t of originals(vm)) {
      const tk = targetKey(t);
      seenTks.add(tk);
      const isNew = !(tk in known.art);

      // New sprite, or its costumes/sounds changed: send the whole sprite.
      const sig = artSig(t);
      if (isNew || known.art[tk] !== sig) {
        if (t.isStage) {
          if (!isNew) changes.notes.push("backdrops");
        } else {
          changes.sprites.push({ tk, name: t.getName(), sig, isNew });
        }
        known.art[tk] = sig;
      }

      const vars = readVars(t), oldVars = known.vars[tk] || {};
      for (const id in vars) if (vars[id] !== oldVars[id]) changes.vars.push({ tk, id, v: JSON.parse(vars[id]) });
      for (const id in oldVars) if (!(id in vars)) changes.vars.push({ tk, id, v: null });
      known.vars[tk] = vars;

      const scripts = readScripts(t), oldScripts = known.scripts[tk] || {};
      for (const id in scripts) if (scripts[id] !== oldScripts[id]) changes.scripts.push({ tk, id, b: scripts[id] });
      for (const id in oldScripts) if (!(id in scripts)) changes.scripts.push({ tk, id, b: null });
      known.scripts[tk] = scripts;
    }
    for (const tk in known.art) {
      if (!seenTks.has(tk)) {
        changes.sprites.push({ tk, deleted: true });
        delete known.art[tk]; delete known.scripts[tk]; delete known.vars[tk];
      }
    }

    // Sprite files are sent separately (they can be big).
    for (const s of changes.sprites) {
      if (s.deleted) continue;
      const t = targetByKey(vm, s.tk);
      try {
        const out = await vm.exportSprite(t.id, "arraybuffer");
        s.data = out instanceof ArrayBuffer ? out : await new Response(out).arrayBuffer();
      } catch (err) {
        s.error = String(err && err.message || err);
      }
    }
    if (changes.scripts.length || changes.vars.length || changes.sprites.length || changes.notes.length) post("local-changes", { changes });
  }

  // ---------- putting teammates' changes in ----------
  const textToDom = (SB, x) => (SB.utils && SB.utils.xml && SB.utils.xml.textToDom ? SB.utils.xml.textToDom(x) : SB.Xml.textToDom(x));
  function withQuietUndo(SB, fn) {
    const ev = SB.Events;
    const hadSetter = typeof ev.setRecordUndo === "function";
    const before = hadSetter ? ev.getRecordUndo() : ev.recordUndo;
    if (hadSetter) ev.setRecordUndo(false); else ev.recordUndo = false;
    if (typeof ev.setGroup === "function") ev.setGroup(true);
    try { return fn(); } finally {
      if (typeof ev.setGroup === "function") ev.setGroup(false);
      if (hadSetter) ev.setRecordUndo(before); else ev.recordUndo = before;
    }
  }

  // Take a block (and everything under it) out of the VM's copy of a sprite that isn't on screen.
  function vmDetachAndDelete(target, id) {
    const blocks = target.blocks;
    const b = blocks.getBlock(id);
    if (!b) return;
    if (b.parent) {
      const parent = blocks.getBlock(b.parent);
      let oldInput;
      if (parent) for (const name in parent.inputs) if (parent.inputs[name].block === id) oldInput = name;
      blocks.moveBlock({ id, oldParent: b.parent, oldInput, newCoordinate: { x: 0, y: 0 } });
      if (parent && oldInput && parent.inputs[oldInput] && parent.inputs[oldInput].shadow && !parent.inputs[oldInput].block) {
        parent.inputs[oldInput].block = parent.inputs[oldInput].shadow;
      }
    }
    blocks.deleteBlock(id);
  }

  function applyVar(e, target, id, v) {
    const vm = e.vm;
    const onScreen = e.ws && (target === vm.editingTarget || target.isStage);
    const existing = target.variables[id];
    if (!v) {
      if (!existing) return;
      if (onScreen) { try { e.ws.deleteVariableById(id); } catch (_) { /* fine */ } }
      if (target.variables[id]) target.deleteVariable(id);
      return;
    }
    if (existing) {
      if (existing.name !== v.n) {
        target.renameVariable(id, v.n);
        if (onScreen) { try { e.ws.renameVariableById(id, v.n); } catch (_) { /* fine */ } }
      }
      return;
    }
    target.createVariable(id, v.n, v.t, v.c);
    if (onScreen) {
      try { e.ws.createVariable(v.n, v.t, id, !target.isStage, v.c); } catch (_) { /* palette catches up on next refresh */ }
    }
  }

  function applyScriptsVm(target, list) {
    for (const s of list) vmDetachAndDelete(target, s.id);
    for (const s of list) {
      if (!s.b) continue;
      const blocks = JSON.parse(s.b);
      for (const b of blocks) vmDetachAndDelete(target, b.id);
      for (const b of blocks) {
        target.blocks.createBlock(Object.assign({ comment: undefined }, b));
      }
      // Keep the script list right: only the top block is a script.
      for (const b of blocks) if (!b.topLevel) target.blocks._deleteScript(b.id);
    }
  }

  function applyScriptsWorkspace(e, target, list) {
    const { ws, SB, vm } = e;
    const stage = vm.runtime.getTargetForStage();
    const BlocksContainer = stage.blocks.constructor;
    withQuietUndo(SB, () => {
      for (const s of list) {
        const blk = ws.getBlockById(s.id);
        if (blk) blk.dispose(false);
      }
      for (const s of list) {
        if (!s.b) continue;
        const blocks = JSON.parse(s.b);
        // If a teammate moved blocks from another script into this one, take them out first.
        for (const b of blocks) {
          const other = ws.getBlockById(b.id);
          if (other && !other.isShadow()) other.dispose(false);
        }
        const temp = new BlocksContainer(vm.runtime, true);
        for (const b of blocks) temp.createBlock(JSON.parse(JSON.stringify(b)));
        const xml = `<xml xmlns="http://www.w3.org/1999/xhtml">${temp.blockToXML(s.id, {})}</xml>`;
        (SB.Xml.domToWorkspace)(textToDom(SB, xml), ws);
      }
    });
  }

  async function addSpriteFile(vm, data, name, oldTarget) {
    const wasEditing = oldTarget && vm.editingTarget === oldTarget;
    const before = vm.editingTarget;
    const layer = oldTarget ? oldTarget.getLayerOrder() : null;
    if (oldTarget) vm.deleteSprite(oldTarget.id);
    const ids = new Set(vm.runtime.targets.map((x) => x.id));
    await vm.addSprite(data);
    const t = vm.runtime.targets.find((x) => x.isOriginal && !ids.has(x.id));
    // Adding a sprite switches the editor to it; put the person back where they were.
    if (!wasEditing && before && vm.runtime.getTargetById(before.id) && vm.editingTarget !== before) vm.setEditingTarget(before.id);
    if (t && t.getName() !== name) vm.renameSprite(t.id, name);
    if (t && layer !== null && t.getLayerOrder) {
      const diff = t.getLayerOrder() - layer;
      if (diff > 0) t.goBackwardLayers(diff);
    }
    if (t && wasEditing) vm.setEditingTarget(t.id);
    return t;
  }

  // changes: { scripts:[{tk,id,b}], vars:[{tk,id,v}], sprites:[{tk,name,data?,deleted}] }
  // Returns what couldn't go in yet (scripts for sprites that haven't arrived).
  async function applyRemote(changes) {
    const e = editor();
    if (!e) return { pending: changes };
    if (scanTimer) { clearTimeout(scanTimer); await scan(); } // send our own edits first
    applying++;
    const pending = { scripts: [], vars: [], sprites: [] };
    const touched = new Set();
    try {
      const vm = e.vm;

      for (const s of changes.sprites || []) {
        const old = targetByKey(vm, s.tk);
        if (s.deleted) { if (old) { vm.deleteSprite(old.id); delete known.art[s.tk]; delete known.scripts[s.tk]; delete known.vars[s.tk]; } continue; }
        if (!s.data) continue;
        const t = await addSpriteFile(vm, s.data, s.name, old);
        if (t) touched.add(t);
        await settle();
      }

      const byTarget = new Map();
      for (const v of changes.vars || []) {
        const t = targetByKey(vm, v.tk);
        if (!t) { pending.vars.push(v); continue; }
        applyVar(e, t, v.id, v.v);
        touched.add(t);
      }
      for (const s of changes.scripts || []) {
        const t = targetByKey(vm, s.tk);
        if (!t) { pending.scripts.push(s); continue; }
        if (!byTarget.has(t)) byTarget.set(t, []);
        byTarget.get(t).push(s);
      }
      for (const [t, list] of byTarget) {
        // Deletions first, then new and changed scripts.
        list.sort((a, b) => (a.b ? 1 : 0) - (b.b ? 1 : 0));
        const e2 = editor();
        if (e2.ws && t === vm.editingTarget) applyScriptsWorkspace(e2, t, list);
        else applyScriptsVm(t, list);
        touched.add(t);
      }
      await settle();
      if (e.ws && e.ws.refreshToolboxSelection_) { try { e.ws.refreshToolboxSelection_(); } catch (_) { /* optional */ } }
      if (vm.runtime.emitProjectChanged) vm.runtime.emitProjectChanged();
    } catch (err) {
      post("error", { message: "Couldn't add a teammate's change: " + (err && err.message || err) });
    } finally {
      for (const t of touched) if (t && t.blocks) baselineTarget(t);
      applying--;
    }
    return { pending };
  }

  // ---------- whole project ----------
  async function saveProject() {
    const e = editor();
    if (!e) throw new Error("Open the project in the Scratch editor first (click See inside).");
    // Scratch's saveProjectSb3 always gives back a Blob, whatever type is asked for.
    const out = await e.vm.saveProjectSb3("arraybuffer");
    const data = out instanceof ArrayBuffer ? out : await new Response(out).arrayBuffer();
    if (!data || !data.byteLength) throw new Error("Scratch gave back an empty project. Reload the page and try again.");
    const title = (document.querySelector('[class*="project-title-input"]') || {}).value || "";
    return { data, title };
  }
  async function loadProject(data) {
    const e = editor();
    if (!e) throw new Error("Open a project in the Scratch editor first.");
    if (!data || !data.byteLength) throw new Error("The shared project came through empty. Ask the person who started the colab to press Send my version to everyone.");
    applying++;
    try {
      await e.vm.loadProject(data);
      await settle();
      await settle();
      ed = null;
      baselineAll();
    } finally {
      applying--;
    }
  }

  // ---------- presence: which sprite am I looking at ----------
  let lastEditing = "";
  setInterval(() => {
    const e = editor();
    if (!live || !e || !e.vm.editingTarget) return;
    const name = e.vm.editingTarget.isStage ? "Stage" : e.vm.editingTarget.getName();
    if (name !== lastEditing) { lastEditing = name; post("editing", { name }); }
  }, 1000);

  // Watch for changes. Project changes fire on every edit; the timer is a backstop.
  let hookedVm = null;
  setInterval(() => {
    const e = editor();
    if (e && e.vm !== hookedVm) {
      hookedVm = e.vm;
      e.vm.runtime.on("PROJECT_CHANGED", () => queueScan());
      e.vm.on("targetsUpdate", () => queueScan());
      post("editor-ready", {});
    }
    if (e) hookBot(e);
    if (live && !applying) queueScan(0);
  }, 2000);

  // ---------- messages from the extension ----------
  window.addEventListener("message", async (ev) => {
    const m = ev.data;
    if (ev.source !== window || !m || m.source !== TO_PAGE) return;
    const reply = (data) => post("reply", { id: m.id, ...data });
    try {
      if (m.type === "status") {
        const e = editor();
        reply({ ok: true, editor: !!e, codeArea: !!(e && e.ws) });
      } else if (m.type === "save") {
        const r = await saveProject();
        reply({ ok: true, data: r.data, title: r.title });
      } else if (m.type === "load") {
        setLive(false);
        await loadProject(m.data);
        reply({ ok: true });
      } else if (m.type === "start") {
        baselineAll();
        setLive(true);
        reply({ ok: true });
      } else if (m.type === "stop") {
        setLive(false);
        reply({ ok: true });
      } else if (m.type === "apply") {
        const r = await applyRemote(m.changes);
        reply({ ok: true, pending: r.pending });
      } else if (m.type === "flush") {
        clearTimeout(scanTimer);
        await scan();
        reply({ ok: true });
      }
    } catch (err) {
      reply({ ok: false, error: String(err && err.message || err) });
    }
  });

  // For tests.
  window.__scratchColabDebug = { findEditor, readScripts, scan, applyRemote, baselineAll, known: () => known, dec };
})();
