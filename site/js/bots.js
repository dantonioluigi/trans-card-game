/* Bot di TRANS in JavaScript — porto di trans/bots.py.
 *
 * Stessi tre livelli e stesse euristiche della versione Python: la
 * dichiarazione si stima con playout Monte Carlo sulle mani possibili, il
 * gioco decide se conviene prendere e con quale carta.
 */

import {
  Phase,
  RoundKind,
  fullDeck,
  shuffle,
  rankOf,
  suitOf,
  trickKey,
} from "./engine.js";

export const LEVELS = ["facile", "normale", "esperto"];

const SAMPLES = { facile: 0, normale: 40, esperto: 140 };

/* ------------------------------------------------------------------ utili */

function bestInTrick(trick, trump) {
  if (!trick.length) return null;
  const lead = suitOf(trick[0].card);
  let best = trick[0];
  for (const play of trick.slice(1)) {
    if (trickKey(play.card, lead, trump) > trickKey(best.card, lead, trump)) best = play;
  }
  return best;
}

/** La carta batte tutto quello che c'e' gia' sul tavolo? */
function currentlyWins(card, trick, trump) {
  const best = bestInTrick(trick, trump);
  if (!best) return true; // apre lui la presa
  const lead = suitOf(trick[0].card);
  return trickKey(card, lead, trump) > trickKey(best.card, lead, trump);
}

function strength(card, lead, trump) {
  return trickKey(card, lead || suitOf(card), trump);
}

function minBy(items, score) {
  return items.reduce((a, b) => (score(b) < score(a) ? b : a));
}

function maxBy(items, score) {
  return items.reduce((a, b) => (score(b) > score(a) ? b : a));
}

/* ------------------------------------------------------------ dichiarazione */

/**
 * Gioca una mano intera con una politica rozza ma uguale per tutti: si prende
 * la presa se costa poco, altrimenti si scarta la carta piu' bassa. Serve solo
 * a stimare quanto vale una mano, non a giocare bene.
 */
function greedyPlayout(hands, leader, trump) {
  const n = hands.length;
  const tricks = new Array(n).fill(0);
  const remaining = hands.map((h) => [...h]);

  while (remaining[leader].length) {
    const trick = [];
    for (let step = 0; step < n; step++) {
      const p = (leader + step) % n;
      const hand = remaining[p];
      const lead = trick.length ? suitOf(trick[0].card) : null;
      let legal = lead ? hand.filter((c) => suitOf(c) === lead) : [...hand];
      if (!legal.length) legal = [...hand];
      const winners = legal.filter((c) => currentlyWins(c, trick, trump));
      const card = minBy(winners.length ? winners : legal, (c) => strength(c, lead, trump));
      hand.splice(hand.indexOf(card), 1);
      trick.push({ player: p, card });
    }
    leader = bestInTrick(trick, trump).player;
    tricks[leader] += 1;
  }
  return tricks;
}

/** Prese medie che questa mano porta a casa, via Monte Carlo. */
export function estimateTricks(hand, nPlayers, trump, unseen, samples, random = Math.random) {
  if (!hand.length || samples <= 0) return hand.length / Math.max(nPlayers, 1);
  const cardsEach = hand.length;
  if (unseen.length < cardsEach * (nPlayers - 1)) return hand.length / Math.max(nPlayers, 1);

  let total = 0;
  for (let s = 0; s < samples; s++) {
    const pool = shuffle(unseen, random);
    const hands = [[...hand]];
    for (let i = 0; i < nPlayers - 1; i++) {
      hands.push(pool.slice(i * cardsEach, (i + 1) * cardsEach));
    }
    total += greedyPlayout(hands, 0, trump)[0];
  }
  return total / samples;
}

/** La dichiarazione legale piu' vicina a quella che il bot vorrebbe fare. */
function nearestLegal(game, playerIndex, wanted) {
  const options = game.legalBids(playerIndex);
  if (!options.length) throw new Error("nessuna dichiarazione possibile");
  // Come la tupla (abs(b - wanted), b) del Python: distanza, poi il piu' basso.
  return options.reduce((best, b) => {
    const da = Math.abs(best - wanted);
    const db = Math.abs(b - wanted);
    return db < da || (db === da && b < best) ? b : best;
  });
}

export function chooseBid(game, playerIndex, random = Math.random) {
  const player = game.players[playerIndex];
  const spec = game.spec;
  const level = LEVELS.includes(player.botLevel) ? player.botLevel : "normale";

  if (spec.blindBidding) {
    // Al buio non si vede niente: quota equa, con un filo di varianza.
    const fair = spec.cards / game.n;
    return nearestLegal(game, playerIndex, fair + (random() * 1.2 - 0.6));
  }

  if (level === "facile") {
    const options = game.legalBids(playerIndex);
    const naive = spec.cards / game.n;
    const pool = options.filter((b) => Math.abs(b - naive) <= 1);
    const from = pool.length ? pool : options;
    return from[Math.floor(random() * from.length)];
  }

  const inHand = new Set(player.hand);
  const unseen = fullDeck().filter((c) => !inHand.has(c));
  const expected = estimateTricks(player.hand, game.n, game.trump, unseen, SAMPLES[level], random);
  return nearestLegal(game, playerIndex, expected);
}

/* ------------------------------------------------------------------ gioco */

/**
 * A perdere, prendere tutte le prese vale +15 invece di -5 a presa.
 *
 * Ci si prova solo a colpo sicuro: non averne ancora persa una e avere in mano
 * solo carte imbattibili. Senza, il bot a sei prese su sette giocherebbe per
 * perdere l'ultima, portandosi a casa -30 invece di +15.
 */
function moonIsOn(game, playerIndex) {
  const player = game.players[playerIndex];
  if (!player.hand.length) return false;
  const played = game.spec.cards - player.hand.length;
  if (player.tricks !== played) return false; // una presa gia' persa
  const level = LEVELS.includes(player.botLevel) ? player.botLevel : "normale";
  return player.hand.every((card) => isSafe(card, game, playerIndex, level));
}

/** Al bot conviene prendere questa presa? */
function wantsTrick(game, playerIndex) {
  const spec = game.spec;
  const player = game.players[playerIndex];
  if (spec.kind === RoundKind.MISERE) return moonIsOn(game, playerIndex);
  if (player.bid === null) return false;

  const needed = player.bid - player.tricks;
  // Dichiarazione gia' raggiunta: prendere ancora la fa saltare. Se e' gia'
  // saltata, ogni presa in piu' vale comunque 1 punto.
  if (needed <= 0) return needed < 0;
  return true;
}

function unseenCards(game, playerIndex) {
  const known = new Set([
    ...game.players[playerIndex].hand,
    ...game.playedCards,
    ...game.currentTrick.map((p) => p.card),
  ]);
  return fullDeck().filter((c) => !known.has(c));
}

/** La carta batte tutto quello che gli avversari possono ancora avere? */
function isSafe(card, game, playerIndex, level) {
  const trump = game.trump;
  if (level !== "esperto") {
    return rankOf(card) >= 12 || (trump !== null && suitOf(card) === trump);
  }
  const lead = game.leadSuit || suitOf(card);
  const threshold = trickKey(card, lead, trump);
  return !unseenCards(game, playerIndex).some((other) => trickKey(other, lead, trump) > threshold);
}

function leadCard(game, playerIndex, legal, want, level) {
  const trump = game.trump;
  if (want) {
    if (level === "esperto") {
      const sure = legal.filter((c) => isSafe(c, game, playerIndex, level));
      if (sure.length) return maxBy(sure, (c) => strength(c, suitOf(c), trump));
    }
    const side = legal.filter((c) => !trump || suitOf(c) !== trump);
    if (side.length && Math.max(...side.map(rankOf)) >= 13) {
      return maxBy(side, rankOf);
    }
    return maxBy(legal, (c) => strength(c, suitOf(c), trump));
  }
  // Uscire perdendo: seme lungo e carta bassa, evitando la briscola.
  const side = legal.filter((c) => !trump || suitOf(c) !== trump);
  const pool = side.length ? side : legal;
  return minBy(pool, (c) => rankOf(c) * 1000 + strength(c, suitOf(c), trump));
}

export function chooseCard(game, playerIndex, random = Math.random) {
  const legal = game.legalCards(playerIndex);
  if (!legal.length) throw new Error("nessuna carta giocabile");
  if (legal.length === 1) return legal[0];

  const player = game.players[playerIndex];
  const level = LEVELS.includes(player.botLevel) ? player.botLevel : "normale";
  if (level === "facile") return legal[Math.floor(random() * legal.length)];

  const trump = game.trump;
  const trick = game.currentTrick;
  const lead = game.leadSuit;
  const want = wantsTrick(game, playerIndex);
  const lastToPlay = trick.length === game.n - 1;

  if (!trick.length) return leadCard(game, playerIndex, legal, want, level);

  const winners = legal.filter((c) => currentlyWins(c, trick, trump));
  const losers = legal.filter((c) => !winners.includes(c));

  if (want) {
    if (!winners.length) return minBy(legal, (c) => strength(c, lead, trump));
    if (lastToPlay) return minBy(winners, (c) => strength(c, lead, trump));
    // Restano giocatori dopo di noi: serve una carta che regga davvero.
    const safe = winners.filter((c) => isSafe(c, game, playerIndex, level));
    return minBy(safe.length ? safe : winners, (c) => strength(c, lead, trump));
  }

  // Vogliamo perdere la presa: scarichiamo la carta piu' alta che non prende.
  if (losers.length) return maxBy(losers, (c) => strength(c, lead, trump));
  return maxBy(legal, (c) => strength(c, lead, trump));
}

/** Fa muovere il bot di turno. */
export function act(game, playerIndex, random = Math.random) {
  const player = game.players[playerIndex];
  if (game.phase === Phase.BIDDING) {
    const bid = chooseBid(game, playerIndex, random);
    game.placeBid(player.id, bid);
    return { action: "bid", value: bid };
  }
  if (game.phase === Phase.PLAYING) {
    const card = chooseCard(game, playerIndex, random);
    game.playCard(player.id, card);
    return { action: "play", card };
  }
  throw new Error(`il bot non puo' agire in fase ${game.phase}`);
}
