/* TRANS — client. Nessun framework: stato singolo, render idempotente. */
(() => {
  "use strict";

  // \uFE0E forza la resa testuale: senza, ♥ e ♦ escono come emoji e non si
  // lasciano colorare di rosso.
  const SUITS = { H: "♥\uFE0E", D: "♦\uFE0E", C: "♣\uFE0E", S: "♠\uFE0E" };
  const RED = new Set(["H", "D"]);
  const TRICK_HOLD_MS = 1700;   // quanto resta visibile la presa appena chiusa
  const RECONNECT_MAX = 8000;

  const $ = (id) => document.getElementById(id);

  const store = {
    get(key, fallback = "") {
      try { return localStorage.getItem("trans." + key) || fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("trans." + key, value); } catch { /* modalita' privata */ }
    },
  };

  const app = {
    ws: null,
    state: null,
    playerId: store.get("pid"),
    name: store.get("name"),
    room: "",
    wantConnection: false,
    retry: 500,
    heldSignature: "",
    heldUntil: 0,
    holdTimer: null,
  };

  /* ------------------------------------------------------------ carte -- */

  function parseCode(code) {
    return { rank: code.slice(0, -1), suit: code.slice(-1) };
  }

  function cardEl(code, classes = "") {
    const { rank, suit } = parseCode(code);
    const el = document.createElement("div");
    el.className = "card " + (RED.has(suit) ? "red " : "") + classes;
    el.dataset.card = code;
    const symbol = SUITS[suit] || "?";
    el.innerHTML =
      `<span class="corner"><span>${rank}</span><span>${symbol}</span></span>` +
      `<span class="pip-big">${symbol}</span>` +
      `<span class="corner br"><span>${rank}</span><span>${symbol}</span></span>`;
    return el;
  }

  function suitHtml(code) {
    const symbol = SUITS[code] || "?";
    return `<span class="suit${RED.has(code) ? " red" : ""}">${symbol}</span>`;
  }

  function backEl() {
    const el = document.createElement("div");
    el.className = "card back";
    return el;
  }

  /* ----------------------------------------------------------- socket -- */

  function connect(room, name) {
    app.wantConnection = true;
    app.room = room || "";
    app.name = name || app.name;
    store.set("name", app.name);

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    app.ws = ws;

    ws.onopen = () => {
      app.retry = 500;
      $("connBanner").hidden = true;
      ws.send(JSON.stringify({
        type: "join",
        room: app.room || null,
        name: app.name,
        player_id: app.playerId || null,
      }));
    };

    ws.onmessage = (event) => handleMessage(JSON.parse(event.data));

    ws.onclose = () => {
      app.ws = null;
      if (!app.wantConnection) return;
      $("connBanner").hidden = false;
      setTimeout(() => {
        if (app.wantConnection) connect(app.room, app.name);
      }, app.retry);
      app.retry = Math.min(app.retry * 2, RECONNECT_MAX);
    };
  }

  function send(message) {
    if (app.ws && app.ws.readyState === WebSocket.OPEN) {
      app.ws.send(JSON.stringify(message));
    }
  }

  function handleMessage(msg) {
    if (msg.type === "welcome") {
      app.playerId = msg.player_id;
      app.room = msg.room;
      app.name = msg.name;
      store.set("pid", msg.player_id);
      store.set("name", msg.name);
      history.replaceState(null, "", "#" + msg.room);
      return;
    }
    if (msg.type === "error") { toast(msg.message); showHomeError(msg.message); return; }
    if (msg.type === "state") { app.state = msg; render(); return; }
  }

  /* ------------------------------------------------------------ render -- */

  function render() {
    const state = app.state;
    if (!state) { showScreen("home"); return; }
    showScreen(state.screen);
    $("btnLeave").hidden = false;
    if (state.screen === "lobby") renderLobby(state);
    else renderGame(state);
  }

  function showScreen(which) {
    $("screenHome").hidden = which !== "home";
    $("screenLobby").hidden = which !== "lobby";
    $("screenGame").hidden = which !== "game";
    $("topbarInfo").hidden = which === "home";
    if (which === "home") {
      $("btnLeave").hidden = true;
      hideOverlays();
    }
  }

  function hideOverlays() {
    ["bidPanel", "resultOverlay", "endOverlay"].forEach((id) => { $(id).hidden = true; });
  }

  /* --- lobby --- */

  function renderLobby(state) {
    $("chipRoom").textContent = "Tavolo " + state.room;
    $("chipRound").textContent = state.mode_label;
    $("chipTrump").innerHTML = "Briscola " + suitHtml("H");
    $("lobbyCode").textContent = state.room;

    const list = $("seatList");
    list.innerHTML = "";
    state.seats.forEach((seat) => {
      const row = document.createElement("li");
      row.className = "seat-row";
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = seat.name;
      row.appendChild(who);

      if (seat.is_bot) row.appendChild(tag("bot · " + seat.bot_level));
      if (seat.is_host) row.appendChild(tag("host", "host"));
      if (seat.id === state.you) row.appendChild(tag("tu"));
      if (!seat.is_bot && !seat.connected) row.appendChild(tag("offline", "off"));

      if (state.is_host && seat.is_bot) {
        const kick = document.createElement("button");
        kick.className = "kick";
        kick.type = "button";
        kick.title = "Rimuovi";
        kick.textContent = "×";
        kick.onclick = () => send({ type: "remove_player", player_id: seat.id });
        row.appendChild(kick);
      }
      list.appendChild(row);
    });

    const free = state.max_players - state.seats.length;
    document.querySelectorAll("#botControls .ghost").forEach((b) => {
      b.disabled = !state.is_host || free <= 0;
    });
    document.querySelectorAll("#modeControls .mode").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === state.mode);
      b.disabled = !state.is_host;
    });

    const enough = state.seats.length >= state.min_players;
    $("btnStart").disabled = !state.is_host || !enough;
    $("lobbyHint").textContent = !state.is_host
      ? "Aspetta che l'host faccia partire la partita."
      : enough
        ? `${state.seats.length} giocatori al tavolo. ${free} posti liberi.`
        : `Servono almeno ${state.min_players} giocatori: aggiungi un bot o invita qualcuno.`;
  }

  function tag(text, extra = "") {
    const el = document.createElement("span");
    el.className = "tag " + extra;
    el.textContent = text;
    return el;
  }

  /* --- partita --- */

  function seatPosition(offset, total) {
    const angle = (90 + (offset * 360) / total) * (Math.PI / 180);
    return { x: 50 + 40 * Math.cos(angle), y: 50 + 36 * Math.sin(angle) };
  }

  function renderGame(state) {
    const g = state.game;
    const me = g.you;

    $("chipRoom").textContent = "Tavolo " + state.room;
    $("chipRound").textContent = `Round ${g.round.number}/${g.round.total} · ${g.round.title}`;
    const trumpChip = $("chipTrump");
    trumpChip.innerHTML = g.round.trump ? "Briscola " + suitHtml(g.round.trump) : "Senza briscola";
    trumpChip.classList.toggle("hot", !g.round.trump);

    renderSeats(g, me);
    renderTrick(g, me);
    renderCenter(g);
    renderHand(g);
    renderScores(g, me);
    renderLog(g, state.chat);
    renderOverlays(state, g);
  }

  function renderSeats(g, me) {
    const ring = $("seatsRing");
    ring.innerHTML = "";
    const total = g.players.length;
    const anchor = me == null ? 0 : me;

    g.players.forEach((p, i) => {
      const offset = ((i - anchor) % total + total) % total;
      const pos = seatPosition(offset, total);
      const el = document.createElement("div");
      el.className = "player-seat" + (p.is_turn ? " turn" : "") + (i === me ? " self" : "");
      el.style.left = pos.x + "%";
      el.style.top = pos.y + "%";

      const marks = [];
      if (p.is_dealer) marks.push('<span class="dot dealer" title="mazziere">◆</span>');
      if (p.connected === false && !p.is_bot) marks.push('<span class="dot off" title="offline">●</span>');

      const bid = renderBidBadge(g, p);
      el.innerHTML =
        `<div class="nm">${escapeHtml(p.name)} ${marks.join("")}</div>` +
        `<div class="meta">${p.is_bot ? "bot · " + p.bot_level : p.score + " pt"}` +
        `${p.cards_left ? " · " + p.cards_left + " carte" : ""}</div>` +
        bid;
      ring.appendChild(el);
    });
  }

  function renderBidBadge(g, p) {
    if (g.round.kind === "misere") {
      const cls = p.tricks > 0 ? "over" : "done";
      return `<div class="bid-badge ${cls}">${p.tricks} prese</div>`;
    }
    if (p.bid === null || p.bid === undefined) {
      return g.phase === "bidding" ? `<div class="bid-badge">…</div>` : "";
    }
    let cls = "";
    if (g.phase !== "bidding") cls = p.tricks === p.bid ? "done" : p.tricks > p.bid ? "over" : "";
    return `<div class="bid-badge ${cls}">${p.tricks}/${p.bid}</div>`;
  }

  function trickView(g) {
    if (g.trick.length) { app.heldSignature = ""; return { plays: g.trick, winner: null }; }
    if (g.last_trick) {
      const signature = JSON.stringify(g.last_trick);
      if (signature !== app.heldSignature) {
        app.heldSignature = signature;
        app.heldUntil = Date.now() + TRICK_HOLD_MS;
        clearTimeout(app.holdTimer);
        app.holdTimer = setTimeout(render, TRICK_HOLD_MS + 40);
      }
      if (Date.now() < app.heldUntil) {
        return { plays: g.last_trick.plays, winner: g.last_trick.winner };
      }
    }
    return { plays: [], winner: null };
  }

  function renderTrick(g, me) {
    const area = $("trickArea");
    area.innerHTML = "";
    const view = trickView(g);
    const total = g.players.length;
    const anchor = me == null ? 0 : me;

    view.plays.forEach((play, n) => {
      const offset = ((play.player - anchor) % total + total) % total;
      const seat = seatPosition(offset, total);
      const el = cardEl(play.card, play.player === view.winner ? "winning" : "");
      el.style.left = (50 + (seat.x - 50) * 0.44) + "%";
      el.style.top = (50 + (seat.y - 50) * 0.44) + "%";
      el.style.setProperty("--rot", ((n * 7) % 13 - 6) + "deg");
      area.appendChild(el);
    });
  }

  function renderCenter(g) {
    const center = $("tableCenter");
    const view = trickView(g);
    if (view.plays.length) { center.innerHTML = ""; return; }
    const label = g.round.kind === "normal" ? "" : g.round.kind_label;
    center.innerHTML = label
      ? `${escapeHtml(label)}<span class="sub">${g.round.cards} carte</span>`
      : `<span class="sub">Round ${g.round.number} di ${g.round.total}</span>`;
  }

  function renderHand(g) {
    const hand = $("hand");
    hand.innerHTML = "";
    const status = $("handStatus");

    if (g.hand_hidden) {
      for (let i = 0; i < g.round.cards; i++) hand.appendChild(backEl());
      status.innerHTML = "<b>BUIO</b> — dichiara senza guardare le carte.";
      return;
    }

    const legal = new Set(g.legal_cards);
    const myTurn = g.phase === "playing" && legal.size > 0;
    g.hand.forEach((code) => {
      const playable = legal.has(code);
      const el = cardEl(code, myTurn ? (playable ? "playable" : "blocked") : "");
      if (myTurn && playable) el.onclick = () => send({ type: "play", card: code });
      hand.appendChild(el);
    });

    status.innerHTML = handStatusText(g, myTurn);
  }

  function handStatusText(g, myTurn) {
    if (g.phase === "game_over") return "Partita finita.";
    if (g.phase === "round_over") return "Round concluso.";
    const actor = g.players.find((p) => p.is_turn);
    if (g.phase === "bidding") {
      if (!myTurnToBid(g)) {
        return `In attesa della dichiarazione di <b>${escapeHtml(actor ? actor.name : "…")}</b>.`;
      }
      // Il pannello sopra dice gia' "quante prese?": qui ricordiamo la briscola.
      return g.round.trump
        ? `Queste sono le tue carte. Briscola ${suitHtml(g.round.trump)}.`
        : "Queste sono le tue carte. <b>Nessuna briscola</b> in questo round.";
    }
    if (myTurn) {
      const lead = g.lead_suit ? ` Seme di uscita: ${suitHtml(g.lead_suit)}.` : " Esci tu.";
      return "<b>Tocca a te.</b>" + lead;
    }
    return `Gioca <b>${escapeHtml(actor ? actor.name : "…")}</b>.`;
  }

  function myTurnToBid(g) {
    return g.phase === "bidding" && g.legal_bids.length > 0;
  }

  function renderScores(g, me) {
    const table = $("scoreTable");
    table.innerHTML = "";
    g.standings.forEach((row, i) => {
      const tr = document.createElement("tr");
      if (me != null && g.players[me] && g.players[me].id === row.id) tr.className = "me";
      tr.innerHTML =
        `<td class="rank">${i + 1}.</td>` +
        `<td>${escapeHtml(row.name)}</td>` +
        `<td class="pts">${row.score}</td>`;
      table.appendChild(tr);
    });
  }

  function renderLog(g, chat) {
    const box = $("log");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = "";
    g.log.forEach((line) => {
      const div = document.createElement("div");
      div.textContent = line;
      box.appendChild(div);
    });
    (chat || []).forEach((c) => {
      const div = document.createElement("div");
      div.className = "chat-line";
      div.innerHTML = `<b>${escapeHtml(c.name)}:</b> ${escapeHtml(c.text)}`;
      box.appendChild(div);
    });
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  /* --- overlay --- */

  function renderOverlays(state, g) {
    const holding = trickView(g).plays.length > 0;

    // Dichiarazione
    const bidding = myTurnToBid(g);
    $("bidPanel").hidden = !bidding;
    if (bidding) {
      $("bidTitle").textContent = g.round.blind
        ? "Al buio: quante prese?"
        : "Quante prese farai?";
      const declared = g.players.reduce((s, p) => s + (p.bid || 0), 0);
      const missing = g.players.filter((p) => p.bid === null).length - 1;
      const banned = g.forbidden_bid;
      const context = g.round.blind
        ? `${g.round.cards} carte coperte. Dichiarate finora: ${declared}.`
        : `Round da ${g.round.cards} carte. Dichiarate finora: ${declared}.`;
      $("bidSub").textContent = banned === null || banned === undefined
        ? context + (missing > 0 ? ` Dopo di te mancano ${missing} giocatori.` : "")
        : `${context} Chiudi tu il giro: non puoi dire ${banned}, la somma farebbe` +
          ` esattamente ${g.round.cards}.`;

      // Il numero vietato resta visibile, barrato: sparire e basta confonde.
      const legal = new Set(g.legal_bids);
      const grid = $("bidGrid");
      grid.innerHTML = "";
      for (let value = 0; value <= g.round.cards; value++) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = value;
        if (legal.has(value)) {
          btn.onclick = () => send({ type: "bid", value });
        } else {
          btn.disabled = true;
          btn.className = "banned";
          btn.title = `Con ${value} la somma delle dichiarazioni farebbe esattamente ` +
                      `${g.round.cards}: non e' permesso.`;
        }
        grid.appendChild(btn);
      }
    }

    // Fine round
    const roundOver = g.phase === "round_over" && !holding;
    $("resultOverlay").hidden = !roundOver;
    if (roundOver && g.last_result) {
      $("resultTitle").textContent = `Round ${g.last_result.round} — ${g.round.title}`;
      fillResultTable($("resultTable"), g.last_result.rows, g.round.kind === "misere");
      $("resultHint").textContent = "Se nessuno tocca niente, il round successivo parte da solo.";
    }

    // Fine partita
    const over = g.phase === "game_over";
    $("endOverlay").hidden = !over;
    if (over) {
      $("endWinner").textContent = "Vince " + g.winner;
      const rows = g.standings.map((s) => ({ name: s.name, total: s.score }));
      fillResultTable($("endTable"), rows, false, true);
      $("btnNewGame").disabled = !state.is_host;
      $("btnNewGame").textContent = state.is_host
        ? "Torna alla lobby"
        : "In attesa dell'host…";
    }
  }

  function fillResultTable(table, rows, misere, finalOnly = false) {
    table.innerHTML = "";
    const head = document.createElement("tr");
    head.innerHTML = finalOnly
      ? "<th>Giocatore</th><th>Punti</th>"
      : `<th>Giocatore</th><th>${misere ? "—" : "Dichiarate"}</th><th>Prese</th><th>Round</th><th>Totale</th>`;
    table.appendChild(head);

    rows.forEach((row) => {
      const tr = document.createElement("tr");
      if (finalOnly) {
        tr.innerHTML = `<td>${escapeHtml(row.name)}</td><td class="up">${row.total}</td>`;
      } else {
        const cls = row.delta > 0 ? "up" : row.delta < 0 ? "down" : "flat";
        const sign = row.delta > 0 ? "+" : "";
        tr.innerHTML =
          `<td>${escapeHtml(row.name)}</td>` +
          `<td>${row.bid === null || row.bid === undefined ? "—" : row.bid}</td>` +
          `<td>${row.tricks}</td>` +
          `<td class="${cls}">${sign}${row.delta}</td>` +
          `<td>${row.total}</td>`;
      }
      table.appendChild(tr);
    });
  }

  /* ------------------------------------------------------------- utils -- */

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let toastTimer = null;
  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  function showHomeError(message) {
    if (!$("screenHome").hidden) {
      const el = $("homeError");
      el.textContent = message;
      el.hidden = false;
    }
  }

  /* -------------------------------------------------------------- init -- */

  function wire() {
    $("nameNew").value = app.name;
    $("nameJoin").value = app.name;
    const hash = location.hash.replace("#", "").toUpperCase();
    if (hash) $("codeJoin").value = hash;

    $("btnCreate").onclick = () => {
      const name = $("nameNew").value.trim();
      if (!name) return toast("Scrivi il tuo nome.");
      $("homeError").hidden = true;
      connect("", name);
    };

    $("btnJoin").onclick = () => {
      const name = $("nameJoin").value.trim();
      const code = $("codeJoin").value.trim().toUpperCase();
      if (!name) return toast("Scrivi il tuo nome.");
      if (code.length !== 4) return toast("Il codice tavolo ha 4 caratteri.");
      $("homeError").hidden = true;
      connect(code, name);
    };

    $("codeJoin").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnJoin").click(); });
    $("nameNew").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnCreate").click(); });

    $("btnLeave").onclick = () => {
      app.wantConnection = false;
      if (app.ws) app.ws.close();
      app.ws = null;
      app.state = null;
      app.room = "";
      history.replaceState(null, "", location.pathname);
      showScreen("home");
    };

    $("btnCopyLink").onclick = async () => {
      const url = location.origin + location.pathname + "#" + app.room;
      try {
        await navigator.clipboard.writeText(url);
        toast("Link copiato: " + url);
      } catch {
        prompt("Copia il link:", url);
      }
    };

    document.querySelectorAll("#botControls .ghost").forEach((btn) => {
      btn.onclick = () => send({ type: "add_bot", level: btn.dataset.level });
    });
    document.querySelectorAll("#modeControls .mode").forEach((btn) => {
      btn.onclick = () => send({ type: "set_mode", mode: btn.dataset.mode });
    });

    $("btnStart").onclick = () => send({ type: "start" });
    $("btnNextRound").onclick = () => send({ type: "next_round" });
    $("btnNewGame").onclick = () => send({ type: "new_game" });

    $("btnRules").onclick = () => { $("rulesOverlay").hidden = false; };
    $("btnCloseRules").onclick = () => { $("rulesOverlay").hidden = true; };
    $("rulesOverlay").onclick = (e) => { if (e.target === $("rulesOverlay")) $("rulesOverlay").hidden = true; };

    $("chatForm").onsubmit = (e) => {
      e.preventDefault();
      const input = $("chatInput");
      const text = input.value.trim();
      if (text) send({ type: "chat", text });
      input.value = "";
    };

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") $("rulesOverlay").hidden = true;
    });

    // Se ricarichi la pagina mentre sei a un tavolo, ci rientri da solo.
    const previous = store.get("room");
    if (hash && app.playerId && app.name) connect(hash, app.name);
    else if (previous && app.playerId && app.name && !hash) showScreen("home");
  }

  window.addEventListener("beforeunload", () => { app.wantConnection = false; });
  document.addEventListener("DOMContentLoaded", wire);
})();
