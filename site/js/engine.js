/* Motore di TRANS in JavaScript — porto fedele di trans/cards.py, trans/rules.py
 * e trans/engine.py.
 *
 * Serve alla versione peer-to-peer: su GitHub Pages non gira nessun processo,
 * quindi le regole devono stare nel browser di chi apre la stanza.
 *
 * Le carte sono stringhe ("AH", "10S", "2C"): stesso formato che il server
 * Python manda sul filo, cosi' la UI non distingue da dove arriva lo stato.
 *
 * L'unica fonte di verita' sulle regole restano i test Python. site/tests/
 * riesegue qui le partite registrate da quelli e pretende gli stessi punti.
 */

export const SUITS = ["H", "D", "C", "S"];
export const TRUMP_SUIT = "H";

const RANK_LABELS = { 11: "J", 12: "Q", 13: "K", 14: "A" };
const LABEL_RANKS = { J: 11, Q: 12, K: 13, A: 14 };
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

// Ordine di visualizzazione: briscola per prima.
const DISPLAY_ORDER = ["H", "S", "D", "C"];

export const SUIT_NAMES = { H: "cuori", D: "quadri", C: "fiori", S: "picche" };

export function rankOf(code) {
  const label = code.slice(0, -1);
  return LABEL_RANKS[label] !== undefined ? LABEL_RANKS[label] : parseInt(label, 10);
}

export function suitOf(code) {
  return code.slice(-1);
}

export function makeCode(rank, suit) {
  return (RANK_LABELS[rank] || String(rank)) + suit;
}

export function fullDeck() {
  const deck = [];
  for (const suit of DISPLAY_ORDER) {
    for (const rank of RANKS) deck.push(makeCode(rank, suit));
  }
  return deck;
}

/** Chiave d'ordinamento in una presa: briscola > seme di uscita > scarto. */
export function trickKey(code, leadSuit, trump) {
  const suit = suitOf(code);
  const tier = trump && suit === trump ? 2 : suit === leadSuit ? 1 : 0;
  return tier * 100 + rankOf(code);
}

export function beats(card, other, leadSuit, trump) {
  return trickKey(card, leadSuit, trump) > trickKey(other, leadSuit, trump);
}

/** Indice del giocatore che vince una presa completa. */
export function trickWinner(plays, trump) {
  if (!plays.length) throw new Error("presa vuota");
  const lead = suitOf(plays[0].card);
  let best = plays[0];
  for (const play of plays.slice(1)) {
    if (beats(play.card, best.card, lead, trump)) best = play;
  }
  return best.player;
}

export function sortHand(codes) {
  return [...codes].sort((a, b) => {
    const bySuit = DISPLAY_ORDER.indexOf(suitOf(a)) - DISPLAY_ORDER.indexOf(suitOf(b));
    return bySuit !== 0 ? bySuit : rankOf(b) - rankOf(a);
  });
}

export function shuffle(items, random = Math.random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function deal(nPlayers, cardsEach, random = Math.random) {
  if (nPlayers * cardsEach > 52) {
    throw new Error(`servono ${nPlayers * cardsEach} carte ma il mazzo ne ha 52`);
  }
  const deck = shuffle(fullDeck(), random);
  const hands = [];
  for (let i = 0; i < nPlayers; i++) {
    hands.push(sortHand(deck.slice(i * cardsEach, (i + 1) * cardsEach)));
  }
  return hands;
}

/* ------------------------------------------------------------------ regole */

export const RoundKind = {
  NORMAL: "normal",
  NO_TRUMP: "no_trump",
  BLIND: "blind",
  MISERE: "misere",
};

const KIND_LABELS = {
  normal: "Normale",
  no_trump: "NO BRISCOLA",
  blind: "BUIO",
  misere: "A PERDERE",
};

export const SPECIAL_ROUND_CARDS = 7;
export const MAX_NORMAL_CARDS = 7;
const SPECIAL_SEQUENCE = [RoundKind.NO_TRUMP, RoundKind.BLIND, RoundKind.MISERE];

export const HIT_BASE = 10;
export const HIT_PER_TRICK = 5;
export const MISS_PER_TRICK = 1;
export const MISERE_PER_TRICK = -5;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

function roundSpec(number, cards, kind) {
  return {
    number,
    cards,
    kind,
    kindLabel: KIND_LABELS[kind],
    trump: kind === RoundKind.NO_TRUMP ? null : TRUMP_SUIT,
    hasBidding: kind !== RoundKind.MISERE,
    blindBidding: kind === RoundKind.BLIND,
    title: kind === RoundKind.NORMAL ? `${cards} carte` : `${KIND_LABELS[kind]} · ${cards} carte`,
  };
}

/**
 * Veloce (10): 7,6,5,4,3,2,1 + NO BRISCOLA, BUIO, A PERDERE.
 * Lunga  (20): come sopra, poi la risalita 1..7 e di nuovo i tre speciali.
 */
export function buildSchedule(mode) {
  const plan = [];
  for (let n = MAX_NORMAL_CARDS; n >= 1; n--) plan.push([n, RoundKind.NORMAL]);
  for (const kind of SPECIAL_SEQUENCE) plan.push([SPECIAL_ROUND_CARDS, kind]);
  if (mode === "long") {
    for (let n = 1; n <= MAX_NORMAL_CARDS; n++) plan.push([n, RoundKind.NORMAL]);
    for (const kind of SPECIAL_SEQUENCE) plan.push([SPECIAL_ROUND_CARDS, kind]);
  }
  return plan.map(([cards, kind], i) => roundSpec(i + 1, cards, kind));
}

export const MODE_LABELS = {
  fast: "Partita veloce (10 round)",
  long: "Partita lunga (20 round)",
};

/**
 * A PERDERE: -5 per presa. Dichiarazione centrata: 10 + 5 per presa dichiarata.
 * Dichiarazione sbagliata: 1 punto per presa fatta.
 */
export function scoreRound(kind, bid, tricks) {
  if (kind === RoundKind.MISERE) return MISERE_PER_TRICK * tricks;
  if (bid !== null && bid !== undefined && bid === tricks) return HIT_BASE + HIT_PER_TRICK * bid;
  return MISS_PER_TRICK * tricks;
}

/* ------------------------------------------------------------------ partita */

export const Phase = {
  BIDDING: "bidding",
  PLAYING: "playing",
  ROUND_OVER: "round_over",
  GAME_OVER: "game_over",
};

export class IllegalMove extends Error {}

export class Game {
  /**
   * @param {Array} players  {id, name, isBot, botLevel}
   * @param {Object} options  mode, dealer, forbidExactTotal, random, dealFn
   */
  constructor(players, options = {}) {
    if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
      throw new Error(`servono da ${MIN_PLAYERS} a ${MAX_PLAYERS} giocatori`);
    }
    if (new Set(players.map((p) => p.id)).size !== players.length) {
      throw new Error("id giocatori duplicati");
    }

    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      botLevel: p.botLevel || "normale",
      score: 0,
      hand: [],
      bid: null,
      tricks: 0,
    }));
    this.mode = options.mode || "fast";
    this.schedule = buildSchedule(this.mode);
    this.random = options.random || Math.random;
    // dealFn esiste per i test: permette di rigiocare mani gia' distribuite.
    this.dealFn = options.dealFn || ((n, cards) => deal(n, cards, this.random));
    // Regola dell'impiccato, attiva come nel motore Python.
    this.forbidExactTotal = options.forbidExactTotal !== false;

    this.roundIndex = 0;
    this.dealer = (options.dealer || 0) % this.players.length;
    this.turn = 0;
    this.phase = Phase.BIDDING;
    this.currentTrick = [];
    this.lastTrick = null;
    this.playedCards = [];
    this.results = [];
    this.log = [];

    this._startRound();
  }

  get n() {
    return this.players.length;
  }

  get spec() {
    return this.schedule[this.roundIndex];
  }

  get trump() {
    return this.spec.trump;
  }

  get isOver() {
    return this.phase === Phase.GAME_OVER;
  }

  get leadSuit() {
    return this.currentTrick.length ? suitOf(this.currentTrick[0].card) : null;
  }

  indexOf(playerId) {
    const i = this.players.findIndex((p) => p.id === playerId);
    if (i < 0) throw new Error(`giocatore sconosciuto: ${playerId}`);
    return i;
  }

  currentActor() {
    return this.phase === Phase.BIDDING || this.phase === Phase.PLAYING ? this.turn : null;
  }

  handVisibleToOwner() {
    return !(this.spec.blindBidding && this.phase === Phase.BIDDING);
  }

  _log(message) {
    this.log.push(message);
    if (this.log.length > 200) this.log = this.log.slice(-200);
  }

  _startRound() {
    const spec = this.spec;
    const hands = this.dealFn(this.n, spec.cards);
    this.players.forEach((player, i) => {
      player.hand = [...hands[i]];
      player.bid = null;
      player.tricks = 0;
    });
    this.currentTrick = [];
    this.lastTrick = null;
    this.playedCards = [];
    this.turn = (this.dealer + 1) % this.n;
    this.phase = spec.hasBidding ? Phase.BIDDING : Phase.PLAYING;
    this._log(`Round ${spec.number}/${this.schedule.length} — ${spec.title}`);
    if (!spec.hasBidding) this._log("A PERDERE: nessuna scommessa, ogni presa vale -5.");
  }

  /* ---------------------------------------------------------- dichiarazioni */

  /** La dichiarazione vietata a chi chiude il giro: quella che pareggia il conto. */
  forbiddenBid(playerIndex) {
    if (!this.forbidExactTotal || playerIndex !== this.dealer) return null;
    const declared = this.players.reduce((sum, p) => sum + (p.bid === null ? 0 : p.bid), 0);
    const forbidden = this.spec.cards - declared;
    return forbidden >= 0 && forbidden <= this.spec.cards ? forbidden : null;
  }

  legalBids(playerIndex) {
    if (this.phase !== Phase.BIDDING || playerIndex !== this.turn) return [];
    const forbidden = this.forbiddenBid(playerIndex);
    const options = [];
    for (let b = 0; b <= this.spec.cards; b++) if (b !== forbidden) options.push(b);
    return options;
  }

  placeBid(playerId, value) {
    const idx = this.indexOf(playerId);
    if (this.phase !== Phase.BIDDING) throw new IllegalMove("non e' il momento di scommettere");
    if (idx !== this.turn) throw new IllegalMove("non e' il tuo turno di scommettere");
    if (value === this.forbiddenBid(idx)) {
      throw new IllegalMove(
        `chiudi tu il giro: con ${value} la somma farebbe esattamente ${this.spec.cards}, e non e' permesso`
      );
    }
    if (!this.legalBids(idx).includes(value)) {
      throw new IllegalMove(`scommessa non valida: ${value}`);
    }

    const player = this.players[idx];
    player.bid = value;
    this._log(`${player.name} scommette ${value}.`);

    if (this.players.every((p) => p.bid !== null)) {
      this.phase = Phase.PLAYING;
      this.turn = (this.dealer + 1) % this.n;
      const total = this.players.reduce((s, p) => s + p.bid, 0);
      this._log(`Scommesse chiuse: ${total} prese dichiarate su ${this.spec.cards}.`);
    } else {
      this.turn = (this.turn + 1) % this.n;
    }
  }

  /* ---------------------------------------------------------------- gioco */

  /** Obbligo di rispondere al seme; se non ce l'hai, giochi quello che vuoi. */
  legalCards(playerIndex) {
    if (this.phase !== Phase.PLAYING || playerIndex !== this.turn) return [];
    const hand = this.players[playerIndex].hand;
    const lead = this.leadSuit;
    if (!lead) return [...hand];
    const sameSuit = hand.filter((c) => suitOf(c) === lead);
    return sameSuit.length ? sameSuit : [...hand];
  }

  playCard(playerId, card) {
    const idx = this.indexOf(playerId);
    if (this.phase !== Phase.PLAYING) throw new IllegalMove("non e' il momento di giocare una carta");
    if (idx !== this.turn) throw new IllegalMove("non e' il tuo turno");
    const player = this.players[idx];
    if (!player.hand.includes(card)) throw new IllegalMove(`non hai ${card} in mano`);
    if (!this.legalCards(idx).includes(card)) {
      const lead = this.leadSuit;
      throw new IllegalMove(lead ? `devi rispondere a ${SUIT_NAMES[lead]}` : "carta non giocabile");
    }

    player.hand.splice(player.hand.indexOf(card), 1);
    this.currentTrick.push({ player: idx, card });
    this.playedCards.push(card);
    this._log(`${player.name} gioca ${card}.`);

    if (this.currentTrick.length === this.n) this._resolveTrick();
    else this.turn = (this.turn + 1) % this.n;
  }

  _resolveTrick() {
    const winner = trickWinner(this.currentTrick, this.trump);
    this.players[winner].tricks += 1;
    this.lastTrick = { plays: [...this.currentTrick], winner };
    this._log(`Presa a ${this.players[winner].name}.`);
    this.currentTrick = [];
    this.turn = winner;
    if (!this.players.some((p) => p.hand.length)) this._endRound();
  }

  _endRound() {
    const spec = this.spec;
    const rows = this.players.map((player) => {
      const delta = scoreRound(spec.kind, player.bid, player.tricks);
      player.score += delta;
      return {
        player_id: player.id,
        name: player.name,
        bid: player.bid,
        tricks: player.tricks,
        delta,
        total: player.score,
      };
    });
    this.results.push({ roundNumber: spec.number, kind: spec.kind, rows });
    this.phase = Phase.ROUND_OVER;
    const summary = rows.map((r) => `${r.name} ${r.delta >= 0 ? "+" : ""}${r.delta}`).join(", ");
    this._log(`Fine round ${spec.number}: ${summary}.`);
  }

  advanceRound() {
    if (this.phase !== Phase.ROUND_OVER) throw new IllegalMove("il round non e' finito");
    if (this.roundIndex + 1 >= this.schedule.length) {
      this.phase = Phase.GAME_OVER;
      this._log(`Partita finita. Vince ${this.winnerNames()}.`);
      return;
    }
    this.roundIndex += 1;
    this.dealer = (this.dealer + 1) % this.n;
    this._startRound();
  }

  standings() {
    return [...this.players].sort((a, b) => b.score - a.score);
  }

  winnerNames() {
    const best = Math.max(...this.players.map((p) => p.score));
    const names = this.players.filter((p) => p.score === best).map((p) => p.name);
    return `${names.join(" e ")} (${best} punti)`;
  }

  /* -------------------------------------------------------------- snapshot */

  /** Stesso formato del server Python: la UI non sa da dove arriva. */
  snapshot(viewerId) {
    let viewer = null;
    if (viewerId) {
      const i = this.players.findIndex((p) => p.id === viewerId);
      if (i >= 0) viewer = i;
    }
    const spec = this.spec;
    const actor = this.currentActor();

    let hand = [];
    let legalCards = [];
    let legalBids = [];
    let forbiddenBid = null;
    if (viewer !== null) {
      if (this.handVisibleToOwner()) hand = sortHand(this.players[viewer].hand);
      legalCards = this.legalCards(viewer);
      legalBids = this.legalBids(viewer);
      forbiddenBid = this.forbiddenBid(viewer);
    }

    return {
      phase: this.phase,
      mode: this.mode,
      round: {
        number: spec.number,
        total: this.schedule.length,
        cards: spec.cards,
        kind: spec.kind,
        kind_label: spec.kindLabel,
        title: spec.title,
        trump: spec.trump,
        blind: spec.blindBidding,
        has_bidding: spec.hasBidding,
      },
      players: this.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        is_bot: p.isBot,
        bot_level: p.isBot ? p.botLevel : null,
        score: p.score,
        bid: p.bid,
        tricks: p.tricks,
        cards_left: p.hand.length,
        is_dealer: i === this.dealer,
        is_turn: actor === i,
      })),
      you: viewer,
      hand,
      hand_hidden: viewer !== null && !this.handVisibleToOwner(),
      legal_cards: legalCards,
      legal_bids: legalBids,
      forbidden_bid: forbiddenBid,
      trick: this.currentTrick.map((p) => ({ player: p.player, card: p.card })),
      lead_suit: this.leadSuit,
      played: [...this.playedCards],
      last_trick: this.lastTrick,
      last_result: this.results.length
        ? {
            round: this.results[this.results.length - 1].roundNumber,
            rows: this.results[this.results.length - 1].rows,
          }
        : null,
      standings: this.standings().map((p) => ({ id: p.id, name: p.name, score: p.score })),
      schedule: this.schedule.map((s) => ({
        number: s.number,
        cards: s.cards,
        kind: s.kind,
        title: s.title,
      })),
      round_index: this.roundIndex,
      log: this.log.slice(-40),
      winner: this.isOver ? this.winnerNames() : null,
    };
  }
}
