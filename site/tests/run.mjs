/* Confronto fra il motore JavaScript e quello Python.
 *
 * fixtures.json contiene partite intere giocate da trans/ in Python: le mani
 * distribuite a ogni round, ogni mossa, le mosse che erano legali in quel
 * momento e i punti di ogni round. Qui si rigioca tutto con site/js/engine.js
 * e si pretende che coincida, mossa per mossa.
 *
 *   node site/tests/run.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Game, Phase } from "../js/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const { games } = JSON.parse(readFileSync(join(here, "fixtures.json"), "utf8"));

let checks = 0;
const failures = [];

function expect(condition, message) {
  checks++;
  if (!condition) failures.push(message);
  return condition;
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

for (const fixture of games) {
  const label = fixture.label;
  let roundIndex = 0;

  // Le mani sono gia' decise: il motore JS le riceve invece di mescolare.
  const dealFn = () => fixture.rounds[roundIndex].hands;

  const game = new Game(
    fixture.players.map((p) => ({ id: p.id, name: p.name })),
    { mode: fixture.mode, dealer: fixture.dealer, dealFn }
  );

  for (const round of fixture.rounds) {
    if (!expect(game.spec.cards === round.cards, `${label} r${round.cards}: numero di carte diverso`)) break;
    if (!expect(game.spec.kind === round.kind, `${label}: tipo di round diverso`)) break;

    for (const action of round.actions) {
      const actor = game.currentActor();
      if (!expect(actor !== null && game.players[actor].id === action.player,
                  `${label}: tocca a ${actor === null ? "nessuno" : game.players[actor].id}, il Python diceva ${action.player}`)) {
        break;
      }

      if (action.kind === "bid") {
        expect(same(game.legalBids(actor), action.legal),
               `${label}: dichiarazioni legali diverse per ${action.player} — JS ${JSON.stringify(game.legalBids(actor))} vs PY ${JSON.stringify(action.legal)}`);
        expect(game.forbiddenBid(actor) === action.forbidden,
               `${label}: dichiarazione vietata diversa per ${action.player} — JS ${game.forbiddenBid(actor)} vs PY ${action.forbidden}`);
        game.placeBid(action.player, action.value);
      } else {
        // L'ordine non conta: quello che conta e' l'insieme delle carte giocabili.
        expect(same([...game.legalCards(actor)].sort(), [...action.legal].sort()),
               `${label}: carte giocabili diverse per ${action.player} — JS ${JSON.stringify(game.legalCards(actor))} vs PY ${JSON.stringify(action.legal)}`);
        game.playCard(action.player, action.card);
      }
    }

    expect(game.phase === Phase.ROUND_OVER, `${label}: il round ${round.cards} non si e' chiuso`);
    const rows = game.results[game.results.length - 1].rows;
    expect(same(rows, round.rows),
           `${label}: punteggi del round diversi\n  JS ${JSON.stringify(rows)}\n  PY ${JSON.stringify(round.rows)}`);

    roundIndex++;
    game.advanceRound();
  }

  expect(game.isOver, `${label}: la partita non e' finita`);
  const final = game.players.map((p) => ({ id: p.id, score: p.score }));
  expect(same(final, fixture.final),
         `${label}: punteggi finali diversi\n  JS ${JSON.stringify(final)}\n  PY ${JSON.stringify(fixture.final)}`);
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} differenze su ${checks} controlli:\n`);
  for (const f of failures.slice(0, 10)) console.error("  - " + f);
  if (failures.length > 10) console.error(`  ... e altre ${failures.length - 10}`);
  process.exit(1);
}

console.log(`✓ motore JS identico a quello Python — ${checks} controlli su ${games.length} partite`);
