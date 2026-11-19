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

  // Le lingue stanno in i18n.js: t() per textContent, th() per innerHTML (protegge
  // i parametri), tr() per le frasi che scrivono i motori e la rete.
  const { t, th } = I18N;
  const tr = I18N.engine;
  const levelLabel = (level) =>
    ["facile", "normale", "esperto"].includes(level) ? t("level." + level) : String(level);

  const store = {
    get(key, fallback = "") {
      try { return localStorage.getItem("trans." + key) || fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("trans." + key, value); } catch { /* modalita' privata */ }
    },
  };

  const GAME_ICON = document.querySelector('link[rel="icon"]').href;

  // In modalita' ufficio la scheda non deve dire cosa c'e' dentro. Il turno
  // si annuncia come un messaggio non letto, "(1)": e' il segnale che ogni app
  // da ufficio usa gia', quindi non stona.
  const OFFICE_ICON =
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
    "<rect width='32' height='32' rx='7' fill='%235B5FC7'/>" +
    "<path d='M9 11h14M9 16h14M9 21h9' stroke='white' stroke-width='2.5' " +
    "stroke-linecap='round'/></svg>";

  // Due Esc ravvicinati accendono la modalita' ufficio. Solo accendono: un
  // tasto di emergenza premuto due volte nel panico non deve spegnerla.
  const PANIC_WINDOW_MS = 450;

  const app = {
    link: null,
    state: null,
    playerId: store.get("pid"),
    // Il segreto di rientro: l'id e' pubblico, questo no. Resta solo su questo dispositivo.
    secret: store.get("secret"),
    name: store.get("name"),
    room: "",
    wantConnection: false,
    retry: 500,
    pendingBid: null,
    office: store.get("office") === "1",
    myTurn: false,
    lastEscape: 0,
    heldSignature: "",
    heldUntil: 0,
    holdTimer: null,
  };

  /* ------------------------------------------------------------ carte -- */

  // Tutto quello che arriva dal tavolo e' dato altrui: in P2P chi apre la stanza
  // e' un avversario, e quello che manda finisce nel DOM. Una carta con una forma
  // diversa da questa diventa "?" invece di essere scritta come HTML.
  const CARD_RE = /^(10|[2-9JQKA])[HDCS]$/;

  function parseCode(code) {
    if (typeof code !== "string" || !CARD_RE.test(code)) return { rank: "?", suit: "?" };
    return { rank: code.slice(0, -1), suit: code.slice(-1) };
  }

  /** Un numero dallo stato, mai testo: dentro l'HTML entra solo una cifra. */
  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? String(Math.trunc(n)) : "0";
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

  /* -------------------------------------------------------- trasporto -- */

  /* La UI non sa con chi sta parlando. Di default apre un WebSocket verso il
   * server Python; sulla versione statica (GitHub Pages) la pagina installa in
   * window.TRANS_TRANSPORT un trasporto peer-to-peer che parla lo stesso
   * identico protocollo. Da qui in giu' il codice e' lo stesso. */

  const websocketTransport = {
    create(handlers) {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      ws.onopen = () => handlers.onOpen();
      ws.onmessage = (event) => handlers.onMessage(JSON.parse(event.data));
      ws.onclose = () => handlers.onClose();
      return {
        send(message) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
        },
        close() {
          ws.close();
        },
      };
    },
  };

  /* Collegarsi puo' richiedere qualche secondo, e puo' anche non riuscire mai.
   * Senza questo, chi preme il bottone vede la pagina immobile e non sa se
   * stia succedendo qualcosa. */
  function setBusy(message) {
    const status = $("homeStatus");
    if (status) {
      status.textContent = message;
      status.hidden = false;
    }
    $("homeError").hidden = true;
    $("btnCreate").disabled = true;
    $("btnJoin").disabled = true;
  }

  function clearBusy() {
    const status = $("homeStatus");
    if (status) status.hidden = true;
    $("btnCreate").disabled = false;
    $("btnJoin").disabled = false;
  }

  function connect(room, name) {
    app.wantConnection = true;
    app.room = room || "";
    app.name = name || app.name;
    store.set("name", app.name);
    setBusy(app.room ? t("home.looking", { room: app.room }) : t("home.opening"));

    const transport = window.TRANS_TRANSPORT || websocketTransport;
    app.link = transport.create({
      room: app.room || null,
      name: app.name,
      playerId: app.playerId || null,

      onOpen: () => {
        app.retry = 500;
        $("connBanner").hidden = true;
        send({
          type: "join",
          room: app.room || null,
          name: app.name,
          player_id: app.playerId || null,
          secret: app.secret || null,
        });
      },

      onMessage: handleMessage,

      onClose: (reason) => {
        app.link = null;
        if (!app.wantConnection) return;
        // Alcune chiusure non hanno senso da riprovare: stanza inesistente,
        // host che ha chiuso la scheda, partita gia' cominciata.
        if (reason && reason.fatal) {
          app.wantConnection = false;
          app.state = null;
          showScreen("home");
          clearBusy();
          const text = reason.message ? tr(reason.message) : t("conn.closed");
          showHomeError(text);
          toast(text);
          return;
        }
        $("connBanner").hidden = false;
        setTimeout(() => {
          if (app.wantConnection) connect(app.room, app.name);
        }, app.retry);
        app.retry = Math.min(app.retry * 2, RECONNECT_MAX);
      },
    });
  }

  function send(message) {
    if (app.link) app.link.send(message);
  }

  function handleMessage(msg) {
    if (msg.type === "welcome") {
      app.playerId = msg.player_id;
      // Un host con codice vecchio non lo manda: allora non c'e' niente da presentare.
      app.secret = typeof msg.secret === "string" ? msg.secret : "";
      app.room = msg.room;
      app.name = msg.name;
      store.set("pid", msg.player_id);
      store.set("secret", app.secret);
      store.set("name", msg.name);
      history.replaceState(null, "", "#" + msg.room);
      clearBusy();
      return;
    }
    if (msg.type === "error") {
      clearBusy();
      const text = tr(msg.message);
      toast(text);
      showHomeError(text);
      return;
    }
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

  // Chi ospita il tavolo fa da arbitro: se il telefono spegne lo schermo la
  // pagina si ferma e la partita finisce per tutti. Finche' si e' a un tavolo
  // lo schermo resta acceso. Il blocco cade da solo quando la pagina va in
  // secondo piano, quindi va richiesto di nuovo al ritorno.
  let wakeLock = null;
  let wakeLockPending = false;

  async function keepAwake(on) {
    try {
      if (!on) {
        const lock = wakeLock;
        wakeLock = null;
        if (lock) await lock.release();
        return;
      }
      if (wakeLock || wakeLockPending || !navigator.wakeLock) return;
      wakeLockPending = true;
      try {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      } finally {
        wakeLockPending = false;
      }
    } catch { /* non supportato o negato: si gioca lo stesso */ }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") keepAwake($("screenHome").hidden);
  });

  function showScreen(which) {
    keepAwake(which !== "home");
    $("screenHome").hidden = which !== "home";
    $("screenLobby").hidden = which !== "lobby";
    $("screenGame").hidden = which !== "game";
    $("topbarInfo").hidden = which === "home";
    if (which !== "game") markTurn(false);
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
    $("chipRoom").textContent = t("chip.table", { room: state.room });
    $("chipRound").textContent = tr(state.mode_label);
    $("chipTrump").innerHTML = th("chip.trump", { suitHtml: suitHtml("H") });
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

      if (seat.is_bot) row.appendChild(tag(t("tag.bot", { level: levelLabel(seat.bot_level) })));
      if (seat.is_host) row.appendChild(tag("host", "host"));
      if (seat.id === state.you) row.appendChild(tag(t("tag.you")));
      if (!seat.is_bot && !seat.connected) row.appendChild(tag("offline", "off"));

      if (state.is_host && seat.is_bot) {
        const kick = document.createElement("button");
        kick.className = "kick";
        kick.type = "button";
        kick.title = t("seat.remove");
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

    // Presente solo nella versione peer-to-peer: la partita vive nella scheda
    // dell'host, e va detto a chi la sta tenendo aperta.
    const hostNote = $("p2pHostNote");
    if (hostNote) hostNote.hidden = !state.is_host;

    const enough = state.seats.length >= state.min_players;
    $("btnStart").disabled = !state.is_host || !enough;
    const bots = state.seats.filter((s) => s.is_bot).length;
    $("lobbyHint").textContent = !state.is_host
      ? t("lobby.wait_host")
      : !enough
        ? t("lobby.need", { n: num(state.min_players) })
        : bots
          ? t("lobby.ready_bots", { n: state.seats.length })
          : t("lobby.ready_free", { n: state.seats.length, free });
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

    $("chipRoom").textContent = t("chip.table", { room: state.room });
    $("chipRound").textContent = t("chip.round", {
      n: num(g.round.number), total: num(g.round.total), title: tr(g.round.title),
    });
    const trumpChip = $("chipTrump");
    trumpChip.innerHTML = g.round.trump
      ? th("chip.trump", { suitHtml: suitHtml(g.round.trump) })
      : th("chip.no_trump");
    trumpChip.classList.toggle("hot", !g.round.trump);

    markTurn(myTurnNow(g));
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
      if (p.is_dealer) marks.push(`<span class="dot dealer" title="${escapeHtml(t("seat.dealer"))}">◆</span>`);

      // Chi e' uscito resta al tavolo col suo nome e i suoi punti, ma deve
      // vedersi che al posto suo sta giocando il computer.
      const replaced = !p.is_bot && p.connected === false;
      if (replaced) el.classList.add("replaced");
      const who = p.is_bot
        ? escapeHtml(t("tag.bot", { level: levelLabel(p.bot_level) }))
        : replaced
          ? th("seat.left", { score: num(p.score) })
          : th("seat.score", { score: num(p.score) });

      const bid = renderBidBadge(g, p);
      el.innerHTML =
        `<div class="nm">${escapeHtml(p.name)} ${marks.join("")}</div>` +
        `<div class="meta">${who}${p.cards_left ? th("seat.cards", { n: num(p.cards_left) }) : ""}</div>` +
        bid;
      ring.appendChild(el);
    });
  }

  function renderBidBadge(g, p) {
    if (g.round.kind === "misere") {
      const cls = p.tricks > 0 ? "over" : "done";
      return `<div class="bid-badge ${cls}">${th("bid.tricks", { n: num(p.tricks) })}</div>`;
    }
    if (p.bid === null || p.bid === undefined) {
      return g.phase === "bidding" ? `<div class="bid-badge">…</div>` : "";
    }
    let cls = "";
    if (g.phase !== "bidding") cls = p.tricks === p.bid ? "done" : p.tricks > p.bid ? "over" : "";
    return `<div class="bid-badge ${cls}">${num(p.tricks)}/${num(p.bid)}</div>`;
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

    // Piu' siamo, meno spazio angolare c'e' fra un posto e l'altro: le carte
    // vanno spinte verso l'esterno, se no si accavallano.
    const spread = total <= 4 ? 0.44 : 0.44 + (total - 4) * 0.055;

    view.plays.forEach((play, n) => {
      const offset = ((play.player - anchor) % total + total) % total;
      const seat = seatPosition(offset, total);
      const el = cardEl(play.card, play.player === view.winner ? "winning" : "");
      el.style.left = (50 + (seat.x - 50) * spread) + "%";
      el.style.top = (50 + (seat.y - 50) * spread) + "%";
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
      ? `${escapeHtml(tr(label))}<span class="sub">${th("center.cards", { n: num(g.round.cards) })}</span>`
      : `<span class="sub">${th("center.round", { n: num(g.round.number), total: num(g.round.total) })}</span>`;
  }

  function renderHand(g) {
    const hand = $("hand");
    hand.innerHTML = "";
    const status = $("handStatus");

    if (g.hand_hidden) {
      for (let i = 0; i < g.round.cards; i++) hand.appendChild(backEl());
      status.innerHTML = th("hand.blind");
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
    if (g.phase === "game_over") return th("hand.game_over");
    if (g.phase === "round_over") return th("hand.round_over");
    const actor = g.players.find((p) => p.is_turn);
    if (g.phase === "bidding") {
      if (!myTurnToBid(g)) {
        return th("hand.waiting", { name: actor ? actor.name : "…" });
      }
      // Il pannello sopra dice gia' "quante prese?": qui ricordiamo la briscola.
      return g.round.trump
        ? th("hand.cards_trump", { suitHtml: suitHtml(g.round.trump) })
        : th("hand.cards_no_trump");
    }
    if (myTurn) {
      const lead = g.lead_suit
        ? th("hand.lead", { suitHtml: suitHtml(g.lead_suit) })
        : th("hand.you_lead");
      return `<span class="turn-badge">${th("hand.your_turn")}</span>` + lead;
    }
    return th("hand.plays", { name: actor ? actor.name : "…" });
  }

  function myTurnToBid(g) {
    return g.phase === "bidding" && g.legal_bids.length > 0;
  }

  /** Tocca a me, che sia da dichiarare o da giocare. */
  function myTurnNow(g) {
    return g.legal_bids.length > 0 || g.legal_cards.length > 0;
  }

  /* Il turno va gridato in tre posti: il tavolo, la riga sopra la mano e il
   * titolo della scheda — perche' spesso si sta guardando un'altra finestra. */
  function markTurn(mine) {
    app.myTurn = mine;
    $("screenGame").classList.toggle("your-turn", mine);
    let wanted;
    if (app.office) wanted = mine ? `(1) ${t("office.title")}` : t("office.title");
    else wanted = mine ? t("title.turn") : t("title.idle");
    if (document.title !== wanted) document.title = wanted;
  }

  /* ------------------------------------------------------ modalita' ufficio */

  function applyMode() {
    const root = document.documentElement;
    if (app.office) root.dataset.mode = "office";
    else delete root.dataset.mode;

    // Prima i testi della pagina nella lingua scelta, poi, in ufficio, quelli
    // neutri al loro posto: marchio e titolone della home, che si leggono da lontano.
    I18N.apply(document);
    document.querySelectorAll("[data-office-key]").forEach((el) => {
      const translated = el.hasAttribute("data-i18n");
      if (app.office) {
        if (!translated && el.dataset.gameHtml === undefined) el.dataset.gameHtml = el.innerHTML;
        el.textContent = t(el.dataset.officeKey);
      } else if (!translated && el.dataset.gameHtml !== undefined) {
        el.innerHTML = el.dataset.gameHtml;
        delete el.dataset.gameHtml;
      }
    });

    document.querySelector('link[rel="icon"]').href = app.office ? OFFICE_ICON : GAME_ICON;
    $("btnOffice").textContent = app.office ? t("top.office_off") : t("top.office");
    markTurn(app.myTurn);
  }

  function setOffice(on) {
    app.office = on;
    store.set("office", on ? "1" : "0");
    applyMode();
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
        `<td class="pts">${num(row.score)}</td>`;
      table.appendChild(tr);
    });
  }

  function renderLog(g, chat) {
    const box = $("log");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = "";
    g.log.forEach((line) => {
      const div = document.createElement("div");
      div.textContent = tr(line);
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
      $("bidTitle").textContent = t(g.round.blind ? "bid.title_blind" : "bid.title");
      const declared = g.players.reduce((s, p) => s + (p.bid || 0), 0);
      const missing = g.players.filter((p) => p.bid === null).length - 1;
      const banned = g.forbidden_bid;
      const context = t(g.round.blind ? "bid.ctx_blind" : "bid.ctx", {
        cards: num(g.round.cards), declared: num(declared),
      });
      $("bidSub").textContent = banned === null || banned === undefined
        ? context + (missing > 0 ? t(missing === 1 ? "bid.missing_one" : "bid.missing", { n: missing }) : "")
        : context + t("bid.banned", { banned: num(banned), cards: num(g.round.cards) });

      // Il numero vietato resta visibile, barrato: sparire e basta confonde.
      const legal = new Set(g.legal_bids);
      if (app.pendingBid !== null && !legal.has(app.pendingBid)) app.pendingBid = null;

      const grid = $("bidGrid");
      grid.innerHTML = "";
      for (let value = 0; value <= g.round.cards; value++) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = value;
        if (legal.has(value)) {
          // Un click sceglie soltanto: a dichiarare ci pensa il secondo passo.
          if (value === app.pendingBid) btn.className = "chosen";
          btn.onclick = () => {
            app.pendingBid = app.pendingBid === value ? null : value;
            render();
          };
        } else {
          btn.disabled = true;
          btn.className = "banned";
          btn.title = t("bid.banned_title", { value, cards: num(g.round.cards) });
        }
        grid.appendChild(btn);
      }
      renderBidConfirm(g);
    } else {
      app.pendingBid = null;
      $("bidConfirm").hidden = true;
    }

    // Fine round
    const roundOver = g.phase === "round_over" && !holding;
    $("resultOverlay").hidden = !roundOver;
    if (roundOver && g.last_result) {
      $("resultTitle").textContent = t("res.title", { n: num(g.last_result.round), title: tr(g.round.title) });
      fillResultTable($("resultTable"), g.last_result.rows, g.round.kind === "misere");
      $("resultHint").textContent = t("res.hint");
    }

    // Fine partita
    const over = g.phase === "game_over";
    $("endOverlay").hidden = !over;

    if (over) {
      $("endWinner").textContent = t("end.winner", { name: g.winner });
      const rows = g.standings.map((s) => ({ name: s.name, total: s.score }));
      fillResultTable($("endTable"), rows, false, true);

      // Chi si e' scollegato durante la partita non torna al tavolo: se restano
      // in troppo pochi, rigiocare com'e' non si puo'.
      const staying = g.players.filter((p) => p.is_bot || p.connected !== false).length;
      const canReplay = state.is_host && staying >= state.min_players;
      $("btnRematch").disabled = !canReplay;
      $("btnNewGame").disabled = !state.is_host;
      $("endHint").textContent = !state.is_host
        ? t("end.wait")
        : canReplay
          ? t("end.same")
          : t("end.need", { n: num(state.min_players) });
    }
  }

  /* Dichiarare non si disfa: prima si sceglie, poi si conferma. */
  function renderBidConfirm(g) {
    const row = $("bidConfirm");
    const chosen = app.pendingBid;
    row.hidden = chosen === null;
    if (chosen === null) return;
    $("bidChosen").innerHTML =
      chosen === 0
        ? th("bid.chosen_zero")
        : th(chosen === 1 ? "bid.chosen_one" : "bid.chosen", { n: num(chosen) });
  }

  function confirmBid() {
    if (app.pendingBid === null) return;
    const value = app.pendingBid;
    app.pendingBid = null;
    $("bidConfirm").hidden = true;
    send({ type: "bid", value });
  }

  function cancelBid() {
    if (app.pendingBid === null) return;
    app.pendingBid = null;
    render();
  }

  function fillResultTable(table, rows, misere, finalOnly = false) {
    table.innerHTML = "";
    const head = document.createElement("tr");
    head.innerHTML = finalOnly
      ? `<th>${th("tbl.player")}</th><th>${th("tbl.points")}</th>`
      : `<th>${th("tbl.player")}</th><th>${misere ? "—" : th("tbl.declared")}</th>` +
        `<th>${th("tbl.tricks")}</th><th>${th("tbl.round")}</th><th>${th("tbl.total")}</th>`;
    table.appendChild(head);

    rows.forEach((row) => {
      const tr = document.createElement("tr");
      if (finalOnly) {
        tr.innerHTML = `<td>${escapeHtml(row.name)}</td><td class="up">${num(row.total)}</td>`;
      } else {
        const cls = row.delta > 0 ? "up" : row.delta < 0 ? "down" : "flat";
        const sign = row.delta > 0 ? "+" : "";
        tr.innerHTML =
          `<td>${escapeHtml(row.name)}</td>` +
          `<td>${row.bid === null || row.bid === undefined ? "—" : num(row.bid)}</td>` +
          `<td>${num(row.tricks)}</td>` +
          `<td class="${cls}">${sign}${num(row.delta)}</td>` +
          `<td>${num(row.total)}</td>`;
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
    applyMode();
    $("nameNew").value = app.name;
    $("nameJoin").value = app.name;
    const hash = location.hash.replace("#", "").toUpperCase();
    if (hash) $("codeJoin").value = hash;

    $("btnCreate").onclick = () => {
      const name = $("nameNew").value.trim();
      if (!name) return toast(t("toast.name"));
      $("homeError").hidden = true;
      connect("", name);
    };

    $("btnJoin").onclick = () => {
      const name = $("nameJoin").value.trim();
      const code = $("codeJoin").value.trim().toUpperCase();
      if (!name) return toast(t("toast.name"));
      if (code.length !== 4) return toast(t("toast.code"));
      $("homeError").hidden = true;
      connect(code, name);
    };

    $("codeJoin").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnJoin").click(); });
    $("nameNew").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnCreate").click(); });

    $("btnLeave").onclick = () => {
      app.wantConnection = false;
      if (app.link) app.link.close();
      app.link = null;
      clearBusy();
      app.state = null;
      app.room = "";
      history.replaceState(null, "", location.pathname);
      showScreen("home");
    };

    $("btnCopyLink").onclick = async () => {
      // Nell'app l'indirizzo della pagina e' https://localhost: il link da
      // passare e' quello del sito pubblico, che la build dell'app incorpora.
      const url = (window.TRANS_SHARE_URL || location.origin + location.pathname) + "#" + app.room;
      try {
        await navigator.clipboard.writeText(url);
        toast(t("toast.copied", { url }));
      } catch {
        prompt(t("prompt.copy"), url);
      }
    };

    document.querySelectorAll("#botControls .ghost").forEach((btn) => {
      btn.onclick = () => send({ type: "add_bot", level: btn.dataset.level });
    });
    document.querySelectorAll("#modeControls .mode").forEach((btn) => {
      btn.onclick = () => send({ type: "set_mode", mode: btn.dataset.mode });
    });

    $("btnBidConfirm").onclick = confirmBid;
    $("btnBidCancel").onclick = cancelBid;

    $("btnStart").onclick = () => send({ type: "start" });
    $("btnNextRound").onclick = () => send({ type: "next_round" });
    $("btnRematch").onclick = () => send({ type: "rematch" });
    $("btnNewGame").onclick = () => send({ type: "new_game" });

    $("btnOffice").onclick = () => setOffice(!app.office);
    $("btnLang").onclick = () => I18N.toggle();
    // Cambiando lingua si rifa' tutto cio' che e' scritto dal client.
    I18N.onChange(() => {
      applyMode();
      if (app.state) render();
    });
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
      if (e.key === "Escape") {
        const now = Date.now();
        if (now - app.lastEscape < PANIC_WINDOW_MS) setOffice(true);
        app.lastEscape = now;
        $("rulesOverlay").hidden = true;
        cancelBid();
        return;
      }
      // Mentre si scrive in chat i tasti sono della chat.
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      if ($("bidPanel").hidden) return;

      if (e.key === "Enter") {
        confirmBid();
        return;
      }
      // Le cifre scelgono, non dichiarano: serve comunque il secondo passo.
      if (/^[0-9]$/.test(e.key)) {
        const value = Number(e.key);
        const g = app.state && app.state.game;
        if (g && g.legal_bids.includes(value)) {
          app.pendingBid = value;
          render();
        }
      }
    });

    // Se ricarichi la pagina mentre sei a un tavolo, ci rientri da solo.
    const previous = store.get("room");
    if (hash && app.playerId && app.name) connect(hash, app.name);
    else if (previous && app.playerId && app.name && !hash) showScreen("home");
  }

  window.addEventListener("beforeunload", () => { app.wantConnection = false; });
  document.addEventListener("DOMContentLoaded", wire);
})();
