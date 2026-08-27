/* Test dell'arbitro peer-to-peer: un host e un ospite simulati contro lo
 * stesso Table, senza WebRTC di mezzo.
 *
 * WebRTC e' solo il tubo; le decisioni — chi puo' fare cosa, cosa vede
 * ciascuno — stanno tutte qui. Sono le stesse cose che tests/test_server.py
 * verifica sul server Python.
 *
 *   node site/tests/table.mjs
 */

import { Table, handleClientMessage, newRoomCode } from "../js/room.js";

let checks = 0;
const failures = [];

function check(condition, message) {
  checks++;
  if (!condition) failures.push(message);
}

/** Un giocatore collegato al tavolo: raccoglie quello che gli arriva. */
function makeSession(table, name, playerId = null) {
  const inbox = [];
  const session = { playerId: null, sink: (msg) => inbox.push(msg) };
  const deliver = (msg) => inbox.push(msg);
  const send = (msg) => handleClientMessage(table, session, msg, deliver);
  return {
    session,
    inbox,
    send,
    join(joinName = name) {
      send({ type: "join", room: table.code, name: joinName, player_id: playerId });
    },
    get id() {
      return session.playerId;
    },
    last(type) {
      for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].type === type) return inbox[i];
      return null;
    },
    errors() {
      return inbox.filter((m) => m.type === "error");
    },
  };
}

/* ------------------------------------------------------------------ lobby */

{
  const table = new Table(newRoomCode());
  const host = makeSession(table, "Luigi");
  host.join();
  check(host.last("welcome") !== null, "l'host non ha ricevuto il benvenuto");
  check(table.hostId === host.id, "chi apre la stanza dovrebbe essere l'host");
  check(host.last("state").is_host === true, "lo stato non dice che e' host");

  const guest = makeSession(table, "Anna");
  guest.join();
  check(guest.last("state").is_host === false, "l'ospite non dovrebbe essere host");
  check(guest.last("state").seats.length === 2, "l'ospite non vede due posti");

  // Un ospite non comanda.
  guest.send({ type: "add_bot", level: "normale" });
  check(guest.errors().at(-1)?.message.includes("solo chi ha creato"),
        "un ospite ha potuto aggiungere un bot");
  guest.send({ type: "start" });
  check(guest.errors().at(-1)?.message.includes("solo chi ha creato"),
        "un ospite ha potuto far partire la partita");

  // Nomi uguali: si disambiguano.
  const twin = makeSession(table, "Luigi");
  twin.join();
  check(twin.last("welcome").name === "Luigi 2", "i nomi doppi non sono stati distinti");
}

/* ------------------------------------------------- privatezza e permessi */

{
  const table = new Table(newRoomCode());
  const host = makeSession(table, "Luigi");
  host.join();
  const guest = makeSession(table, "Anna");
  guest.join();
  host.send({ type: "start" });

  const hostHand = host.last("state").game.hand;
  const guestHand = guest.last("state").game.hand;
  check(hostHand.length === 7 && guestHand.length === 7, "mani non da 7 carte");
  check(hostHand.every((c) => !guestHand.includes(c)),
        "le due mani si sovrappongono: qualcuno vede le carte dell'altro");
  check(host.last("state").game.players.every((p) => p.hand === undefined),
        "lo stato contiene la mano di un altro giocatore");

  // Entrare a partita iniziata non si puo'.
  const late = makeSession(table, "Tardi");
  late.join();
  check(late.errors().at(-1)?.message.includes("gia' iniziata"),
        "si e' potuto entrare a partita iniziata");

  // Mosse fuori turno o fuori fase.
  host.send({ type: "play", card: "AH" });
  check(host.errors().at(-1)?.message.includes("momento di giocare"),
        "si e' potuto giocare durante le dichiarazioni");
  host.send({ type: "banana" });
  check(host.errors().at(-1)?.message.includes("sconosciuto"),
        "un messaggio inventato non e' stato rifiutato");
}

/* --------------------------------------------------------- partita intera */

{
  const table = new Table(newRoomCode());
  const host = makeSession(table, "Luigi");
  host.join();
  const guest = makeSession(table, "Anna");
  guest.join();
  host.send({ type: "add_bot", level: "esperto" });
  host.send({ type: "set_mode", mode: "fast" });
  host.send({ type: "start" });

  // I bot qui vanno mossi a mano: il pump usa i timer, e non vogliamo attese.
  const seats = [host, guest];
  const bots = await import("../js/bots.js");

  let guard = 0;
  while (!table.game.isOver) {
    if (++guard > 20000) throw new Error("la partita non finisce");
    const game = table.game;

    if (game.phase === "round_over") {
      host.send({ type: "next_round" });
      continue;
    }
    const actor = game.currentActor();
    const seat = table.seats[actor];
    if (seat.isBot) {
      bots.act(game, actor);
      table.broadcast();
      continue;
    }
    const who = seats.find((s) => s.id === seat.id);
    const view = who.last("state").game;
    if (view.legal_bids.length) who.send({ type: "bid", value: view.legal_bids[0] });
    else if (view.legal_cards.length) who.send({ type: "play", card: view.legal_cards[0] });
    else throw new Error("un umano di turno senza mosse legali");
  }

  const final = host.last("state").game;
  check(final.round.number === 10, `la partita veloce non ha fatto 10 round (${final.round.number})`);
  check(!!final.winner, "nessun vincitore alla fine");
  check(final.players.every((p) => p.cards_left === 0), "restano carte in mano a fine partita");
  check(host.errors().length === 0 && guest.errors().length === 0,
        `errori inattesi durante la partita: ${JSON.stringify([...host.errors(), ...guest.errors()].slice(0, 3))}`);

  // Ogni round ha assegnato esattamente le prese in palio.
  for (const result of table.game.results) {
    const spec = table.game.schedule[result.roundNumber - 1];
    const total = result.rows.reduce((s, r) => s + r.tricks, 0);
    check(total === spec.cards, `round ${result.roundNumber}: ${total} prese invece di ${spec.cards}`);
  }
}

/* ------------------------------------------- l'host che se ne va e ritorna */

{
  const table = new Table(newRoomCode());
  const host = makeSession(table, "Luigi");
  host.join();
  const guest = makeSession(table, "Anna");
  guest.join();
  const guestId = guest.id;
  host.send({ type: "start" });

  table.leave(guestId);
  check(table.seatById(guestId).connected === false, "l'ospite risulta ancora collegato");
  check(table.playsItself(table.seatById(guestId)) === true,
        "un disconnesso dovrebbe essere giocato dal computer");

  const back = makeSession(table, "Anna", guestId);
  back.join();
  check(back.id === guestId, "rientrando non ha riavuto il suo posto");
  check(back.last("state").screen === "game", "rientrando non e' tornato in partita");
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} problemi su ${checks} controlli:\n`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`✓ arbitro peer-to-peer — ${checks} controlli superati`);
