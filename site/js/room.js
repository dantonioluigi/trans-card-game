/* Il tavolo, dentro il browser di chi apre la stanza.
 *
 * Porto di server/room.py: stessa lobby, stessi turni dei bot, stesse pause,
 * stesso protocollo. Chi crea la stanza fa da arbitro per tutti; gli altri gli
 * mandano intenzioni e ricevono lo stato gia' filtrato, esattamente come fa il
 * server Python.
 *
 * Non essendoci thread, il posto del lock asyncio lo prende la regola di
 * ricontrollare lo stato dopo ogni attesa: fra un await e l'altro puo' essere
 * arrivato un messaggio da un altro giocatore.
 */

import { Game, MAX_PLAYERS, MIN_PLAYERS, MODE_LABELS, Phase } from "./engine.js";
import * as bots from "./bots.js";

export const BOT_BID_DELAY = 550;
export const BOT_PLAY_DELAY = 750;
export const TRICK_PAUSE = 1400;
export const AUTO_ADVANCE_AFTER = 12000;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // niente I/O/0/1

export class TableError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function newRoomCode() {
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export function newPlayerId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

export class Table {
  constructor(code) {
    this.code = code;
    this.seats = [];
    this.game = null;
    this.mode = "fast";
    this.hostId = null;
    this.chat = [];
    this._pumping = false;
    this._advanceTimer = null;
  }

  /* ------------------------------------------------------------ anagrafica */

  get started() {
    return this.game !== null;
  }

  seatById(playerId) {
    return this.seats.find((s) => s.id === playerId) || null;
  }

  /** Un bot, o un umano che se n'e' andato: gioca il computer per lui. */
  playsItself(seat) {
    return seat.isBot || !seat.connected;
  }

  everyoneIsAutomatic() {
    return this.seats.every((s) => this.playsItself(s));
  }

  _uniqueName(wanted) {
    let name = (wanted || "Ospite").trim().slice(0, 16) || "Ospite";
    const taken = new Set(this.seats.map((s) => s.name));
    if (!taken.has(name)) return name;
    for (let i = 2; i < 100; i++) {
      if (!taken.has(`${name} ${i}`)) return `${name} ${i}`;
    }
    return `${name} ${Math.random().toString(36).slice(2, 5)}`;
  }

  _promoteHost() {
    const current = this.hostId ? this.seatById(this.hostId) : null;
    if (current && current.connected) return;
    const next = this.seats.find((s) => !s.isBot && s.connected);
    this.hostId = next ? next.id : null;
  }

  _requireHost(requester) {
    if (requester !== this.hostId) throw new TableError("solo chi ha creato il tavolo puo' farlo");
  }

  _requireGame() {
    if (!this.game) throw new TableError("la partita non e' iniziata");
    return this.game;
  }

  /* ----------------------------------------------------------------- lobby */

  join(playerId, name, sink) {
    let seat = playerId ? this.seatById(playerId) : null;
    if (seat) {
      if (seat.isBot) throw new TableError("quel posto e' occupato da un bot");
      seat.connected = true;
      seat.sink = sink;
    } else {
      if (this.started) throw new TableError("partita gia' iniziata: non si entra a tavolo aperto");
      if (this.seats.length >= MAX_PLAYERS) throw new TableError(`tavolo pieno (max ${MAX_PLAYERS} giocatori)`);
      seat = {
        id: playerId || newPlayerId(),
        name: this._uniqueName(name),
        isBot: false,
        botLevel: "normale",
        connected: true,
        sink,
      };
      this.seats.push(seat);
    }
    this._promoteHost();
    return seat;
  }

  leave(playerId) {
    const seat = this.seatById(playerId);
    if (!seat) return;
    seat.connected = false;
    seat.sink = null;
    if (!this.started) this.seats = this.seats.filter((s) => s.id !== playerId);
    this._promoteHost();
  }

  addBot(requester, level = "normale") {
    this._requireHost(requester);
    if (this.started) throw new TableError("partita gia' iniziata");
    if (this.seats.length >= MAX_PLAYERS) throw new TableError(`tavolo pieno (max ${MAX_PLAYERS} giocatori)`);
    if (!bots.LEVELS.includes(level)) throw new TableError(`livello sconosciuto: ${level}`);
    const n = this.seats.filter((s) => s.isBot).length + 1;
    this.seats.push({
      id: newPlayerId(),
      name: this._uniqueName(`Bot ${n}`),
      isBot: true,
      botLevel: level,
      connected: false,
      sink: null,
    });
  }

  removeSeat(requester, targetId) {
    this._requireHost(requester);
    if (this.started) throw new TableError("partita gia' iniziata");
    const target = this.seatById(targetId);
    if (!target) throw new TableError("giocatore non trovato");
    if (!target.isBot && target.id !== requester) throw new TableError("puoi rimuovere solo i bot");
    this.seats = this.seats.filter((s) => s.id !== targetId);
    this._promoteHost();
  }

  setMode(requester, mode) {
    this._requireHost(requester);
    if (this.started) throw new TableError("partita gia' iniziata");
    if (!MODE_LABELS[mode]) throw new TableError(`modalita' sconosciuta: ${mode}`);
    this.mode = mode;
  }

  /* --------------------------------------------------------------- partita */

  start(requester) {
    this._requireHost(requester);
    if (this.started) throw new TableError("partita gia' iniziata");
    if (this.seats.length < MIN_PLAYERS) {
      throw new TableError(`servono almeno ${MIN_PLAYERS} giocatori (aggiungi un bot)`);
    }
    this.game = new Game(
      this.seats.map((s) => ({ id: s.id, name: s.name, isBot: s.isBot, botLevel: s.botLevel })),
      { mode: this.mode }
    );
  }

  backToLobby(requester) {
    this._requireHost(requester);
    this._cancelAutoAdvance();
    this.game = null;
    this.seats = this.seats.filter((s) => s.isBot || s.connected);
    this._promoteHost();
  }

  bid(playerId, value) {
    this._requireGame().placeBid(playerId, Number(value));
  }

  play(playerId, card) {
    this._requireGame().playCard(playerId, card);
  }

  nextRound(playerId) {
    const game = this._requireGame();
    if (!this.seatById(playerId)) throw new TableError("non sei a questo tavolo");
    this._cancelAutoAdvance();
    game.advanceRound();
  }

  say(playerId, text) {
    const seat = this.seatById(playerId);
    if (!seat) return;
    const clean = String(text || "").trim().slice(0, 200);
    if (!clean) return;
    this.chat.push({ name: seat.name, text: clean, ts: Date.now() / 1000 });
    if (this.chat.length > 50) this.chat = this.chat.slice(-50);
  }

  /* -------------------------------------------------------------- snapshot */

  snapshotFor(playerId) {
    const base = {
      type: "state",
      room: this.code,
      you: playerId,
      host: this.hostId,
      is_host: playerId !== null && playerId === this.hostId,
      mode: this.mode,
      mode_label: MODE_LABELS[this.mode],
      chat: this.chat.slice(-30),
      min_players: MIN_PLAYERS,
      max_players: MAX_PLAYERS,
      bot_levels: [...bots.LEVELS],
    };

    if (!this.game) {
      base.screen = "lobby";
      base.seats = this.seats.map((s) => ({
        id: s.id,
        name: s.name,
        is_bot: s.isBot,
        bot_level: s.isBot ? s.botLevel : null,
        connected: s.connected,
        is_host: s.id === this.hostId,
      }));
      return base;
    }

    base.screen = "game";
    base.game = this.game.snapshot(playerId);
    this.seats.forEach((seat, i) => {
      base.game.players[i].connected = seat.connected;
      base.game.players[i].auto = this.playsItself(seat);
    });
    return base;
  }

  broadcast() {
    for (const seat of [...this.seats]) {
      if (!seat.sink || !seat.connected) continue;
      try {
        seat.sink(this.snapshotFor(seat.id));
      } catch (err) {
        seat.connected = false;
        seat.sink = null;
        this._promoteHost();
      }
    }
  }

  /* ------------------------------------------------------------ bot driver */

  pump() {
    if (this._pumping) return;
    this._pumping = true;
    this._pumpLoop().finally(() => {
      this._pumping = false;
    });
  }

  async _pumpLoop() {
    for (;;) {
      const game = this.game;
      if (!game || game.isOver) return;

      if (game.phase === Phase.ROUND_OVER) {
        if (!this.everyoneIsAutomatic()) {
          // C'e' un umano: gli lasciamo leggere il tabellone. L'attesa vive in
          // un timer a parte, se no bloccherebbe i bot quando qualcuno preme
          // "prossimo round" prima della scadenza.
          this._scheduleAutoAdvance(game, game.roundIndex);
          return;
        }
        await sleep(TRICK_PAUSE);
        if (!this._advanceIfStuck(game, game.roundIndex)) return;
        continue;
      }

      const actor = game.currentActor();
      if (actor === null || !this.playsItself(this.seats[actor])) return;

      const trickWasClosing = game.currentTrick.length === game.n - 1;
      await sleep(game.phase === Phase.BIDDING ? BOT_BID_DELAY : BOT_PLAY_DELAY);

      // Dopo l'attesa lo stato puo' essere cambiato: si ricontrolla tutto.
      if (this.game !== game) return;
      const now = game.currentActor();
      if (now === null || !this.playsItself(this.seats[now])) return;
      try {
        bots.act(game, now);
      } catch (err) {
        return;
      }
      this.broadcast();

      if (trickWasClosing) await sleep(TRICK_PAUSE);
    }
  }

  _scheduleAutoAdvance(game, roundIndex) {
    this._cancelAutoAdvance();
    this._advanceTimer = setTimeout(() => {
      this._advanceTimer = null;
      if (this._advanceIfStuck(game, roundIndex)) this.pump();
    }, AUTO_ADVANCE_AFTER);
  }

  _cancelAutoAdvance() {
    if (this._advanceTimer !== null) clearTimeout(this._advanceTimer);
    this._advanceTimer = null;
  }

  /** Avanza solo se siamo ancora fermi sullo stesso round finito. */
  _advanceIfStuck(game, roundIndex) {
    if (this.game !== game || game.phase !== Phase.ROUND_OVER) return false;
    if (game.roundIndex !== roundIndex) return false;
    game.advanceRound();
    this.broadcast();
    return true;
  }
}

/** Applica un messaggio del client al tavolo. */
function applyClientMessage(table, session, msg) {
  switch (msg.type) {
    case "add_bot":
      return table.addBot(session.playerId, msg.level || "normale");
    case "remove_player":
      return table.removeSeat(session.playerId, msg.player_id || "");
    case "set_mode":
      return table.setMode(session.playerId, msg.mode || "fast");
    case "start":
      return table.start(session.playerId);
    case "bid":
      return table.bid(session.playerId, msg.value ?? 0);
    case "play":
      return table.play(session.playerId, msg.card || "");
    case "next_round":
      return table.nextRound(session.playerId);
    case "new_game":
      return table.backToLobby(session.playerId);
    case "chat":
      return table.say(session.playerId, msg.text || "");
    default:
      throw new TableError(`messaggio sconosciuto: ${msg.type}`);
  }
}

/** Smista un messaggio del client. Gemello di server/main.py: e' l'unico
 * punto in cui si decide cosa un giocatore ha il diritto di fare. */
export function handleClientMessage(table, session, msg, deliver) {
  if (msg.type === "join") {
    let seat;
    try {
      seat = table.join(msg.player_id || null, msg.name || "", session.sink);
    } catch (err) {
      deliver({ type: "error", message: err.message });
      return;
    }
    session.playerId = seat.id;
    deliver({ type: "welcome", room: table.code, player_id: seat.id, name: seat.name });
    table.broadcast();
    table.pump();
    return;
  }

  if (!session.playerId) {
    deliver({ type: "error", message: "prima entra in un tavolo" });
    return;
  }
  if (msg.type === "ping") {
    deliver({ type: "pong" });
    return;
  }

  try {
    applyClientMessage(table, session, msg);
  } catch (err) {
    deliver({ type: "error", message: err.message || "mossa non valida" });
    return;
  }
  table.broadcast();
  table.pump();
}

