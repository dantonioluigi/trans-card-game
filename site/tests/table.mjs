/* Test dell'arbitro peer-to-peer: un host e un ospite simulati contro lo
 * stesso Table, senza WebRTC di mezzo.
 *
 * WebRTC e' solo il tubo; le decisioni — chi puo' fare cosa, cosa vede
 * ciascuno — stanno tutte qui. Sono le stesse cose che tests/test_server.py
 * verifica sul server Python.
 *
 *   node site/tests/table.mjs
 */

import {
  Table, cleanName, handleClientMessage, localTable, newPlayerId, newRoomCode, newSecret, silentSessions,
} from "../js/room.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let checks = 0;
const failures = [];

function check(condition, message) {
  checks++;
  if (!condition) failures.push(message);
}

/** Un giocatore collegato al tavolo: raccoglie quello che gli arriva. */
function makeSession(table, name, playerId = null, secret = null) {
  const inbox = [];
  const session = { playerId: null, sink: (msg) => inbox.push(msg) };
  const deliver = (msg) => inbox.push(msg);
  const send = (msg) => handleClientMessage(table, session, msg, deliver);
  return {
    session,
    inbox,
    send,
    join(joinName = name) {
      send({ type: "join", room: table.code, name: joinName, player_id: playerId, secret });
    },
    get id() {
      return session.playerId;
    },
    get secret() {
      return session.secret;
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

  // A partita iniziata, senza bot al tavolo, non c'e' posto.
  const late = makeSession(table, "Tardi");
  late.join();
  check(late.errors().at(-1)?.message.includes("non ci sono posti liberi"),
        "senza posti liberi il ritardatario dovrebbe restare fuori");

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

/* --------------------------------------------------- rigiocare senza rifare */

{
  const table = new Table(newRoomCode());
  const host = makeSession(table, "Luigi");
  host.join();
  const guest = makeSession(table, "Anna");
  guest.join();
  host.send({ type: "set_mode", mode: "long" });
  host.send({ type: "start" });

  const bots = await import("../js/bots.js");
  const names = table.game.players.map((p) => p.name);

  // A meta' strada non si rigioca.
  host.send({ type: "rematch" });
  check(host.errors().at(-1)?.message.includes("non e' ancora finita"),
        "ha accettato il rematch a partita in corso");

  let guard = 0;
  while (!table.game.isOver) {
    if (++guard > 40000) throw new Error("la partita non finisce");
    if (table.game.phase === "round_over") { table.game.advanceRound(); continue; }
    bots.act(table.game, table.game.currentActor());
  }
  check(table.game.players.some((p) => p.score !== 0), "nessuno ha fatto punti");

  // Un ospite non decide per il tavolo.
  guest.send({ type: "rematch" });
  check(guest.errors().at(-1)?.message.includes("solo chi ha creato"),
        "un ospite ha potuto far ripartire la partita");

  host.send({ type: "rematch" });
  check(host.errors().length === 1, `rematch rifiutato: ${JSON.stringify(host.errors())}`);
  check(table.game !== null && !table.game.isOver, "la nuova partita non e' partita");
  check(table.game.roundIndex === 0, "non e' ripartita dal primo round");
  check(table.game.players.map((p) => p.name).join() === names.join(),
        "i giocatori al tavolo sono cambiati");
  check(table.game.players.every((p) => p.score === 0), "i punteggi non sono azzerati");
  check(table.game.schedule.length === 20, "la durata scelta non e' stata mantenuta");
  check(guest.last("state").game.hand.length === 7, "l'ospite non ha ricevuto carte nuove");
}

/* ------------------------------------- chi arriva tardi prende posto a un bot */

{
  const table = new Table(newRoomCode());
  const host = makeSession(table, "Luigi");
  host.join();
  host.send({ type: "add_bot", level: "facile" });
  host.send({ type: "start" });

  const before = table.game.players.map((p) => p.name);
  check(before[1].startsWith("Bot"), "il secondo posto doveva essere di un bot");

  const late = makeSession(table, "Anna");
  late.join();
  check(late.errors().length === 0,
        `il ritardatario e' stato rifiutato: ${JSON.stringify(late.errors())}`);

  const view = late.last("state");
  check(view.screen === "game", "il ritardatario non e' entrato in partita");
  check(view.game.players[view.game.you].name === "Anna", "non ha preso il nome giusto");
  check(view.game.players[view.game.you].is_bot === false, "risulta ancora un bot");
  check(view.game.hand.length > 0, "non ha ricevuto le carte del bot");
  check(table.playsItself(table.seats[1]) === false,
        "il computer continua a giocare al posto suo");
  check(table.game.players[1].name === "Anna", "il nome non e' cambiato anche nella partita");
}

/* ------------------------------------------ chi esce lascia il posto a un bot */

{
  const table = new Table(newRoomCode());
  const host = makeSession(table, "Luigi");
  host.join();
  const guest = makeSession(table, "Anna");
  guest.join();
  const annaId = guest.id;
  host.send({ type: "start" });

  table.leave(annaId);
  table.leave(annaId); // "close" ed "error" arrivano spesso insieme
  const seat = table.seatById(annaId);
  check(table.playsItself(seat), "dopo l'uscita il posto di Anna non e' giocato dal computer");
  const exits = table.game.log.filter((l) => l.includes("Anna esce: al suo posto gioca un bot."));
  check(exits.length === 1, `avviso d'uscita ripetuto ${exits.length} volte invece di una`);

  const view = host.last("state");
  table.broadcast();
  const anna = host.last("state").game.players.find((p) => p.name === "Anna");
  check(anna.connected === false && anna.auto === true, "la UI non riceve che Anna e' sostituita");

  // Chi arriva si siede li', con un id nuovo.
  const late = makeSession(table, "Marco");
  late.join();
  check(late.errors().length === 0, `Marco rifiutato: ${JSON.stringify(late.errors())}`);
  check(late.id !== annaId, "Marco ha ereditato l'id di Anna");
  check(table.game.players.map((p) => p.name).join() === "Luigi,Marco", "Marco non e' al posto di Anna");
  check(table.game.log.some((l) => l.includes("Marco prende il posto di Anna.")), "manca l'avviso del cambio");

  // Anna col vecchio id non puo' riprenderselo.
  const back = makeSession(table, "Anna", annaId);
  back.join();
  check(back.errors().at(-1)?.message.includes("non ci sono posti liberi"),
        "Anna ha scalzato Marco dal posto");
}

{
  // Se rientra prima che qualcuno si sieda, il posto torna suo.
  const table = new Table(newRoomCode());
  const host = makeSession(table, "Luigi");
  host.join();
  const guest = makeSession(table, "Anna");
  guest.join();
  const annaId = guest.id;
  const annaSecret = guest.secret;
  host.send({ type: "start" });
  table.leave(annaId);

  const back = makeSession(table, "Anna", annaId, annaSecret);
  back.join();
  check(back.id === annaId, "rientrando Anna non ha riavuto il suo posto");
  check(!table.playsItself(table.seatById(annaId)), "il bot continua a giocare anche dopo il rientro");
  check(table.game.log.some((l) => l.includes("Anna rientra al tavolo.")), "manca l'avviso del rientro");
}

{
  // Il silenzio conta come uscita: la rete che cade non avvisa nessuno.
  const now = 100000;
  const sessions = [
    { playerId: "a", lastHeard: now - 2000 },
    { playerId: "b", lastHeard: now - 20000 },
    { playerId: null, lastHeard: now - 99999 }, // non ancora entrato: non conta
  ];
  const quiet = silentSessions(sessions, now, 15000).map((s) => s.playerId);
  check(quiet.join() === "b", `sessioni mute sbagliate: ${JSON.stringify(quiet)}`);
}

/* ------------------------------------------- l'host che se ne va e ritorna */

{
  const table = new Table(newRoomCode());
  const host = makeSession(table, "Luigi");
  host.join();
  const guest = makeSession(table, "Anna");
  guest.join();
  const guestId = guest.id;
  const guestSecret = guest.secret;
  host.send({ type: "start" });

  table.leave(guestId);
  check(table.seatById(guestId).connected === false, "l'ospite risulta ancora collegato");
  check(table.playsItself(table.seatById(guestId)) === true,
        "un disconnesso dovrebbe essere giocato dal computer");

  const back = makeSession(table, "Anna", guestId, guestSecret);
  back.join();
  check(back.id === guestId, "rientrando col segreto non ha riavuto il suo posto");
  check(back.last("state").screen === "game", "rientrando non e' tornato in partita");
}

/* ----------------------------------------------- id pubblico e segreto di rientro */

{
  const table = new Table(newRoomCode());
  const host = makeSession(table, "Luigi");
  host.join();
  const bob = makeSession(table, "Bob");
  bob.join();
  const hostId = bob.last("state").host;
  check(hostId === host.id, "l'id dell'host dovrebbe essere visibile a tutti (e' pubblico)");
  check(typeof host.last("welcome").secret === "string" && host.last("welcome").secret.length >= 32,
        "il benvenuto non porta un segreto abbastanza lungo");

  // Chi conosce solo l'id pubblico non prende il posto, ne' quello dell'host.
  const mallory = makeSession(table, "Mallory", hostId);
  mallory.join();
  check(mallory.id !== hostId, "Mallory ha preso l'id dell'host");
  check(mallory.last("state").is_host === false, "Mallory e' diventata host con un id pubblico");
  const seats = table.seats.length;
  mallory.send({ type: "add_bot", level: "facile" });
  check(mallory.errors().at(-1)?.message.includes("solo chi ha creato"), "Mallory ha potuto aggiungere un bot");
  check(table.seats.length === seats, "Mallory ha cambiato il tavolo");
  const heard = host.inbox.length;
  table.broadcast();
  check(host.inbox.length > heard, "l'host vero non riceve piu' gli stati");
  check(table.hostId === host.id, "l'host non e' piu' quello di prima");

  // Un segreto sbagliato vale come nessun segreto.
  const wrong = makeSession(table, "Wrong", hostId, "0".repeat(32));
  wrong.join();
  check(wrong.id !== hostId && wrong.last("state").is_host === false, "un segreto sbagliato ha dato il posto dell'host");

  // Il segreto non compare in nessuno stato, ne' per se' ne' per gli altri.
  const secrets = [host, bob, mallory, wrong].map((s) => s.secret);
  check(new Set(secrets).size === 4 && secrets.every(Boolean), "i segreti non sono tutti diversi");
  const states = JSON.stringify([host, bob, mallory, wrong].flatMap((s) => s.inbox.filter((m) => m.type === "state")));
  check(secrets.every((secret) => !states.includes(secret)), "un segreto e' finito in uno stato");

  // Col segreto giusto, invece, si riprende il proprio posto (a partita iniziata il posto resta).
  host.send({ type: "start" });
  table.leave(hostId);
  const back = makeSession(table, "Luigi", hostId, host.secret);
  back.join();
  check(back.id === hostId, "l'host col suo segreto non ha ripreso il posto");
  check(table.seatById(hostId).connected === true, "il posto dell'host non e' tornato collegato");
  const stolen = makeSession(table, "Mallory2", hostId);
  stolen.join();
  check(stolen.id !== hostId, "col solo id pubblico si e' preso il posto di chi e' appena rientrato");
}

{
  // Chi prende il posto di un bot o di chi e' uscito ha id e segreto nuovi: i vecchi non rientrano.
  const table = new Table(newRoomCode());
  const host = makeSession(table, "Luigi");
  host.join();
  const anna = makeSession(table, "Anna");
  anna.join();
  host.send({ type: "start" });
  const annaId = anna.id;
  const annaSecret = anna.secret;
  table.leave(annaId);

  const marco = makeSession(table, "Marco");
  marco.join();
  check(marco.id !== annaId && marco.secret !== annaSecret, "il posto preso non ha id e segreto nuovi");
  const old = makeSession(table, "Anna", annaId, annaSecret);
  old.join();
  check(old.errors().length > 0 && old.id === null, "chi era uscito ha scalzato chi si e' seduto al suo posto");
}

{
  // Una sessione, un posto; messaggi che non hanno la forma giusta.
  const table = new Table(newRoomCode());
  const host = makeSession(table, "Luigi");
  host.join();
  host.send({ type: "join", room: table.code, name: "Fantasma" });
  check(host.errors().at(-1)?.message.includes("gia' al tavolo"), "un secondo join e' stato accettato");
  check(table.seats.length === 1, "il secondo join ha creato un posto fantasma");

  for (const bad of [null, 5, "testo", [1, 2], {}, { type: 5 }]) {
    const before = host.errors().length;
    host.send(bad);
    check(host.errors().length === before + 1, `il messaggio ${JSON.stringify(bad)} non ha avuto risposta`);
  }
  host.send({ type: "set_mode", mode: "constructor" });
  host.send({ type: "set_mode", mode: "__proto__" });
  host.send({ type: "set_mode", mode: ["fast"] });
  check(table.mode === "fast", `modalita' cambiata da un nome non valido: ${table.mode}`);
  check(host.errors().filter((e) => e.message.includes("modalita'")).length === 3,
        "set_mode con nomi non validi non ha dato errore");

  const huge = makeSession(table, "x".repeat(10000));
  huge.join();
  check(huge.last("welcome")?.name === "Ospite", "un nome enorme non e' stato ridotto a un nome di riserva");
  const weird = makeSession(table, { toString() { return "x"; } }, { id: 1 }, 7);
  weird.join();
  check(weird.last("welcome") !== null && weird.id !== null, "campi di tipo sbagliato nel join hanno rotto l'ingresso");
}

{
  // Nomi: niente caratteri invisibili o di direzione, niente doppioni per aspetto.
  check(cleanName("A​B‮  C\n") === "AB C", "zero-width o override non tolti dal nome");
  check(cleanName("Ｌｕｉｇｉ") === "Luigi", "il nome a larghezza piena non e' stato normalizzato");
  check(cleanName("​‮") === "", "un nome fatto solo di caratteri invisibili e' rimasto");
  check(cleanName("x".repeat(40)).length === 16, "il nome non e' stato tagliato a 16");
  const table = new Table(newRoomCode());
  const a = makeSession(table, "Anna");
  a.join();
  const b = makeSession(table, "An​na");
  b.join();
  check(a.last("welcome").name !== b.last("welcome").name, "due nomi che sembrano uguali sono rimasti uguali");
  a.send({ type: "chat", text: "ciao‮​ mondo" });
  check(table.chat.at(-1)?.text === "ciao mondo", `testo della chat non ripulito: ${table.chat.at(-1)?.text}`);
}

{
  // Id, segreti e codici vengono da un generatore sicuro: formato giusto e mai uguali.
  const ids = new Set(Array.from({ length: 200 }, newPlayerId));
  const secrets = new Set(Array.from({ length: 200 }, newSecret));
  const codes = Array.from({ length: 200 }, newRoomCode);
  check(ids.size === 200 && secrets.size === 200, "id o segreti ripetuti in 200 estrazioni");
  check([...ids].every((v) => /^[0-9a-f]{12}$/.test(v)), "formato dell'id inatteso");
  check([...secrets].every((v) => /^[0-9a-f]{32}$/.test(v)), "formato del segreto inatteso");
  check(codes.every((c) => /^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{4}$/.test(c)), "un codice stanza fuori dall'alfabeto");
  check(new Set(codes).size > 150, "i codici stanza si ripetono troppo");
}

/* ------------------------------------------- tavolo locale (offline, campagna) */

{
  const inbox = [];
  let opened = 0;
  const link = localTable({
    onOpen: () => {
      opened++;
      link.send({ type: "join", room: null, name: "Luigi", player_id: null });
    },
    onMessage: (msg) => inbox.push(msg),
    onClose: () => failures.push("il tavolo locale non dovrebbe chiudersi da solo"),
  });
  const last = (type) => inbox.findLast((m) => m.type === type) ?? null;

  check(opened === 0, "onOpen e' arrivato in modo sincrono: chi chiama non ha ancora il collegamento");
  await sleep(10);
  check(opened === 1, "onOpen non e' arrivato");
  check(last("welcome")?.room?.length === 4, "il tavolo locale non ha dato il benvenuto");
  check(last("state")?.is_host === true, "chi gioca da solo dovrebbe essere l'host");

  link.send({ type: "add_bot", level: "facile" });
  link.send({ type: "add_bot", level: "facile" });
  // Nel gioco vero i messaggi arrivano in momenti diversi; qui, mandati tutti
  // di fila, pump() scarterebbe la chiamata dopo "start" e i bot non partirebbero.
  await sleep(20);
  link.send({ type: "start" });
  check(last("state").screen === "game", "la partita locale non e' partita");
  check(last("state").game.players.length === 3, "dovevano esserci tre giocatori");
  await sleep(20);

  // Un messaggio sbagliato torna come errore, non come eccezione.
  link.send({ type: "play", card: "2H" });
  check(inbox.some((m) => m.type === "error"), "una mossa fuori turno doveva dare errore");

  // Apre il primo bot (il mazziere e' l'host, quindi parla il bot dopo di lui):
  // il suo timer e' gia' in corso, e senza la guardia scatterebbe dopo close().
  await sleep(100);
  check(last("state").game.phase === "bidding" && last("state").game.legal_bids.length === 0,
        "il test presume che a muovere sia un bot");

  // Dopo close() non arriva piu' niente, nemmeno dai bot che hanno timer in giro.
  link.close();
  const before = inbox.length;
  await sleep(1800);
  check(inbox.length === before, `arrivati ${inbox.length - before} messaggi dopo close()`);
  link.send({ type: "chat", text: "ci sei?" });
  check(inbox.length === before, "un tavolo chiuso ha risposto a un messaggio");
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} problemi su ${checks} controlli:\n`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`✓ arbitro peer-to-peer — ${checks} controlli superati`);
