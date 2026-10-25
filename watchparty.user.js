// ==UserScript==
// @name         ChriRob Watch Party
// @namespace    https://github.com/christiancrocetti01-sys/chrirobstreaming
// @version      1.0.0
// @description  Sincronizza play, pausa e posizione di qualsiasi video HTML5 tra due (o più) PC a distanza.
// @match        *://*/*
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==

(function () {
  'use strict';

  const ID_PREFIX = 'chrirob-wp-';
  const STATE_KEY = 'chrirob-wp-session';
  const HEARTBEAT_MS = 4000;     // ogni quanto l'host invia la sua posizione
  const DRIFT_TOLERANCE = 1.5;   // secondi di scarto oltre i quali si riallinea
  const SUPPRESS_MS = 800;       // ignora gli eventi generati dai comandi remoti
  const MIN_VIDEO_WIDTH = 200;   // ignora video piccoli (pubblicità, anteprime)

  const PeerCtor = (typeof Peer !== 'undefined' && Peer) || (window.peerjs && window.peerjs.Peer);
  if (!PeerCtor) return;

  let video = null;
  let peer = null;
  let role = null;               // 'host' | 'guest'
  let code = null;
  const conns = new Set();
  let suppressUntil = 0;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let rtt = 0;                   // round-trip stimato verso l'altro PC, in ms
  let ui = null;

  // ---------- Stato persistente (sopravvive al cambio episodio / ricarica) ----------

  const loadSession = () => {
    try { return JSON.parse(GM_getValue(STATE_KEY, 'null')); } catch (e) { return null; }
  };
  const saveSession = () => GM_setValue(STATE_KEY, JSON.stringify({ role, code, at: Date.now() }));
  const clearSession = () => GM_deleteValue(STATE_KEY);

  // ---------- Ricerca del video ----------

  function findVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (r.width >= MIN_VIDEO_WIDTH && area > bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  function attachVideo(v) {
    if (video === v) return;
    if (video) detachVideo(video);
    video = v;
    for (const ev of ['play', 'pause', 'seeked']) video.addEventListener(ev, onLocalEvent);
    if (!ui) buildUI();
    updateStatus();
  }

  function detachVideo(v) {
    for (const ev of ['play', 'pause', 'seeked']) v.removeEventListener(ev, onLocalEvent);
  }

  // ---------- Eventi locali -> rete ----------

  function onLocalEvent(e) {
    if (Date.now() < suppressUntil) return;
    if (e.type === 'seeked') broadcast({ type: 'seek', t: video.currentTime, paused: video.paused });
    else broadcast({ type: e.type, t: video.currentTime });
  }

  function broadcast(msg, except) {
    for (const c of conns) if (c !== except && c.open) c.send(msg);
  }

  // ---------- Rete -> video locale ----------

  function applyRemote(msg) {
    if (!video) return;
    const lead = rtt / 2000; // compensa il ritardo di rete quando il video sta andando
    suppressUntil = Date.now() + SUPPRESS_MS;
    switch (msg.type) {
      case 'play':
        video.currentTime = msg.t + lead;
        video.play().catch(() => flash('Clicca play: il browser ha bloccato l\'avvio automatico'));
        break;
      case 'pause':
        video.pause();
        video.currentTime = msg.t;
        break;
      case 'seek':
        video.currentTime = msg.paused ? msg.t : msg.t + lead;
        break;
      case 'sync': {
        const target = msg.paused ? msg.t : msg.t + lead;
        if (Math.abs(video.currentTime - target) > DRIFT_TOLERANCE) video.currentTime = target;
        if (msg.paused && !video.paused) video.pause();
        if (!msg.paused && video.paused) video.play().catch(() => {});
        break;
      }
    }
  }

  function currentState() {
    return { type: 'sync', t: video ? video.currentTime : 0, paused: video ? video.paused : true };
  }

  // ---------- Connessioni ----------

  function setupConn(conn) {
    conn.on('open', () => {
      conns.add(conn);
      if (role === 'host' && video) conn.send(currentState());
      updateStatus();
    });
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ping') return conn.send({ type: 'pong', s: msg.s });
      if (msg.type === 'pong') { rtt = Date.now() - msg.s; return updateStatus(); }
      applyRemote(msg);
      // l'host fa da ponte se ci sono più ospiti
      if (role === 'host') broadcast(msg, conn);
    });
    conn.on('close', () => {
      conns.delete(conn);
      updateStatus();
      if (role === 'guest') scheduleReconnect();
    });
    conn.on('error', () => {});
  }

  function startHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      for (const c of conns) if (c.open) c.send({ type: 'ping', s: Date.now() });
      if (role === 'host' && video) broadcast(currentState());
    }, HEARTBEAT_MS);
  }

  function randomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function host(existingCode, attempt = 0) {
    teardown(false);
    role = 'host';
    code = existingCode || randomCode();
    saveSession();
    peer = new PeerCtor(ID_PREFIX + code);
    peer.on('open', () => updateStatus());
    peer.on('connection', setupConn);
    peer.on('error', (err) => {
      // dopo una ricarica il server può tenere occupato il vecchio ID per qualche secondo
      if (err.type === 'unavailable-id' && existingCode && attempt < 10) {
        setStatus('Riapro la stanza ' + code + '…');
        setTimeout(() => host(code, attempt + 1), 3000);
      } else {
        setStatus('Errore: ' + err.type);
      }
    });
    startHeartbeat();
    updateStatus();
  }

  function join(roomCode) {
    teardown(false);
    role = 'guest';
    code = roomCode.trim().toUpperCase();
    saveSession();
    peer = new PeerCtor();
    peer.on('open', connectToHost);
    peer.on('error', (err) => {
      setStatus(err.type === 'peer-unavailable' ? 'Stanza ' + code + ' non trovata, riprovo…' : 'Errore: ' + err.type);
      scheduleReconnect();
    });
    startHeartbeat();
    updateStatus();
  }

  function connectToHost() {
    if (!peer || peer.destroyed || role !== 'guest') return;
    setupConn(peer.connect(ID_PREFIX + code, { reliable: true }));
  }

  function scheduleReconnect() {
    if (role !== 'guest' || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (role !== 'guest' || conns.size) return;
      if (peer && peer.disconnected && !peer.destroyed) peer.reconnect();
      connectToHost();
    }, 3000);
  }

  function teardown(forget) {
    clearInterval(heartbeatTimer);
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    for (const c of conns) c.close();
    conns.clear();
    if (peer) peer.destroy();
    peer = null;
    if (forget) {
      role = null;
      code = null;
      clearSession();
    }
    updateStatus();
  }

  // ---------- Interfaccia ----------

  function buildUI() {
    const root = document.createElement('div');
    root.attachShadow({ mode: 'open' }).innerHTML = `
      <style>
        :host { all: initial; }
        .box { position: fixed; top: 12px; right: 12px; z-index: 2147483647;
          font: 13px/1.4 system-ui, sans-serif; color: #f2f2f2; background: rgba(20,20,24,.92);
          border: 1px solid #444; border-radius: 10px; padding: 10px 12px; width: 230px;
          box-shadow: 0 4px 16px rgba(0,0,0,.4); }
        .box.min { width: auto; padding: 6px 10px; }
        .box.min .body { display: none; }
        .head { display: flex; justify-content: space-between; align-items: center; gap: 8px;
          font-weight: 600; cursor: pointer; user-select: none; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #777; display: inline-block; margin-right: 6px; }
        .dot.on { background: #3ccf6e; }
        .body { margin-top: 8px; display: grid; gap: 6px; }
        button, input { font: inherit; border-radius: 6px; border: 1px solid #555; padding: 5px 8px; }
        button { background: #e50914; color: #fff; border-color: #e50914; cursor: pointer; }
        button.sec { background: transparent; color: #ddd; border-color: #555; }
        input { background: #111; color: #fff; text-transform: uppercase; letter-spacing: 2px; min-width: 0; }
        .row { display: flex; gap: 6px; }
        .row input { flex: 1; }
        .code { font-size: 20px; letter-spacing: 4px; font-weight: 700; text-align: center; user-select: all; }
        .status { color: #bbb; font-size: 12px; }
        .flash { color: #ffcc4d; font-size: 12px; }
        [hidden] { display: none !important; }
      </style>
      <div class="box">
        <div class="head"><span><span class="dot"></span>Watch Party</span><span class="toggle">–</span></div>
        <div class="body">
          <div class="idle">
            <button class="create" style="width:100%">Crea stanza</button>
            <div class="row" style="margin-top:6px">
              <input class="input" maxlength="6" placeholder="CODICE">
              <button class="join">Entra</button>
            </div>
          </div>
          <div class="active" hidden>
            <div class="code"></div>
            <div class="status"></div>
            <div class="row">
              <button class="sec resync" style="flex:1">Riallinea</button>
              <button class="sec leave" style="flex:1">Esci</button>
            </div>
          </div>
          <div class="flash" hidden></div>
        </div>
      </div>`;
    document.documentElement.appendChild(root);
    const $ = (sel) => root.shadowRoot.querySelector(sel);
    ui = { root, $, box: $('.box') };

    $('.head').addEventListener('click', () => {
      ui.box.classList.toggle('min');
      $('.toggle').textContent = ui.box.classList.contains('min') ? '+' : '–';
    });
    $('.create').addEventListener('click', () => host());
    $('.join').addEventListener('click', () => { if ($('.input').value.trim()) join($('.input').value); });
    $('.input').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') $('.join').click(); });
    $('.leave').addEventListener('click', () => teardown(true));
    $('.resync').addEventListener('click', () => {
      // l'ospite chiede la posizione dell'host; l'host la impone a tutti
      if (role === 'host') broadcast(currentState());
      else if (video) broadcast({ type: 'seek', t: video.currentTime, paused: video.paused });
    });
    updateStatus();
  }

  function setStatus(text) {
    if (ui) ui.$('.status').textContent = text;
  }

  function flash(text) {
    if (!ui) return;
    const el = ui.$('.flash');
    el.textContent = text;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 6000);
  }

  function updateStatus() {
    if (!ui) return;
    const active = !!role;
    ui.$('.idle').hidden = active;
    ui.$('.active').hidden = !active;
    ui.$('.dot').classList.toggle('on', conns.size > 0);
    if (!active) return;
    ui.$('.code').textContent = code;
    if (conns.size > 0) {
      const who = role === 'host' ? conns.size + (conns.size === 1 ? ' persona connessa' : ' persone connesse') : 'Connesso all\'host';
      setStatus(who + (rtt ? ' · ping ' + rtt + ' ms' : ''));
    } else if (role === 'host') {
      setStatus(peer && peer.open ? 'In attesa: comunica il codice' : 'Apro la stanza…');
    } else {
      setStatus('Mi collego alla stanza…');
    }
  }

  // ---------- Avvio ----------

  function scan() {
    const v = findVideo();
    if (v) attachVideo(v);
  }

  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(scan, 2000); // per i video che cambiano dimensione senza modificare il DOM
  scan();

  // rientra automaticamente nella stanza dopo un cambio episodio (entro 6 ore)
  const saved = loadSession();
  const waitForVideo = setInterval(() => {
    if (!video) return;
    clearInterval(waitForVideo);
    if (saved && saved.code && Date.now() - saved.at < 6 * 3600 * 1000 && !role) {
      if (saved.role === 'host') host(saved.code);
      else join(saved.code);
    }
  }, 500);
})();
