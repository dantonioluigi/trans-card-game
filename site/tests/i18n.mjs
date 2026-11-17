/* Le due lingue: dizionario completo, chiavi usate davvero, e ogni frase che
 * scrivono i motori e la rete ha la sua traduzione.
 *
 *   python site/tests/make_messages.py   # se hai cambiato una frase nel codice
 *   node site/tests/i18n.mjs
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

// net-p2p.js si installa su window all'importazione.
globalThis.window = globalThis;
globalThis.location = { hostname: "gioco.example", port: "", search: "" };
globalThis.Peer = class {};

const I18N = createRequire(import.meta.url)("../../web/i18n.js");
const { MESSAGES } = await import("../js/net-p2p.js");
const engineJs = await import("../js/engine.js");
const room = await import("../js/room.js");
const bots = await import("../js/bots.js");

let checks = 0;
const failures = [];
function check(condition, message) {
  checks++;
  if (!condition) failures.push(message);
}

const S = I18N._dictionary;
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const tags = (text) => [...text.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase()).sort().join(",");

/* ------------------------------------------------------------- il dizionario */

for (const [key, entry] of Object.entries(S)) {
  const [it, en] = entry;
  check(Array.isArray(entry) && entry.length === 2, `${key}: non e' [italiano, inglese]`);
  check(typeof en === "string" && en.trim() !== "", `${key}: manca l'inglese`);
  check(it === null || (typeof it === "string" && it.trim() !== ""), `${key}: italiano vuoto`);
  if (typeof it === "string" && typeof en === "string") {
    check(placeholders(it) === placeholders(en), `${key}: i parametri non coincidono (${placeholders(it)} / ${placeholders(en)})`);
    check(tags(it) === tags(en), `${key}: i tag HTML non coincidono`);
  }
  if (typeof en === "string" && /<[a-z]/i.test(en)) {
    const opened = (en.match(/<(b|i|h3|p|ul|li)\b/g) || []).length;
    const closed = (en.match(/<\/(b|i|h3|p|ul|li)>/g) || []).length;
    check(opened === closed, `${key}: tag HTML non chiusi nell'inglese`);
  }
}

/* ---------------------------------------------------------- le chiavi usate */

const html = read("web/index.html") + read("site/build.py");
const staticKeys = new Set();
for (const m of html.matchAll(/data-(?:i18n(?:-html)?|office-key)="([^"]+)"/g)) staticKeys.add(m[1]);
for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
  for (const pair of m[1].split(";")) staticKeys.add(pair.split(":")[1].trim());
}

const namespaces = new Set(Object.keys(S).map((k) => k.split(".")[0]));
const dynamicKeys = new Set();
for (const m of read("web/app.js").matchAll(/"([a-z_]+\.[a-z_]+)"/g)) {
  if (namespaces.has(m[1].split(".")[0])) dynamicKeys.add(m[1]);
}
// "level." + livello: le tre chiavi stanno in index.html e nel codice.
for (const level of ["facile", "normale", "esperto"]) dynamicKeys.add("level." + level);

for (const key of [...staticKeys, ...dynamicKeys]) check(key in S, `chiave usata ma non nel dizionario: ${key}`);
for (const key of Object.keys(S)) {
  check(staticKeys.has(key) || dynamicKeys.has(key), `chiave nel dizionario ma mai usata: ${key}`);
}
for (const key of dynamicKeys) {
  if (S[key]) check(S[key][0] !== null, `${key}: lo usa il codice ma manca l'italiano`);
}
for (const [key, entry] of Object.entries(S)) {
  if (entry[0] === null) check(staticKeys.has(key), `${key}: italiano nella pagina, ma nessun data-i18n lo usa`);
}

/* ------------------------------------------------------- escape dei parametri */

I18N.setLang("en", true);
const evil = '<img src=x onerror="alert(1)">';
check(!I18N.th("hand.waiting", { name: evil }).includes("<img"), "th non protegge i parametri");
check(I18N.th("hand.waiting", { name: evil }).includes("<b>"), "th ha tolto l'HTML del modello");
check(I18N.th("chip.trump", { suitHtml: "<span>x</span>" }).includes("<span>x</span>"), "th ha protetto un parametro Html");
check(I18N.t("toast.copied", { url: evil }).includes("<img"), "t non deve alterare i parametri (e' per textContent)");

/* ------------------------------------------------ frasi dei motori e della rete */

const samples = new Map(); // testo -> da dove viene
const add = (text, src) => { if (!samples.has(text)) samples.set(text, src); };

for (const row of JSON.parse(read("site/tests/messages.json"))) add(row.text, row.src.join(","));
for (const [name, text] of Object.entries(MESSAGES)) add(text, `MESSAGES.${name}`);
for (const text of Object.values(engineJs.MODE_LABELS)) add(text, "MODE_LABELS");
for (const text of Object.values(engineJs.SUIT_NAMES)) add(text, "SUIT_NAMES");
for (const mode of Object.keys(engineJs.MODE_LABELS)) {
  for (const spec of engineJs.buildSchedule(mode)) {
    add(spec.title, `titolo ${mode}`);
    add(spec.kindLabel, `etichetta ${mode}`);
  }
}

// Una partita vera, fino in fondo: ogni riga del diario deve tradursi.
{
  const table = new room.Table(room.newRoomCode());
  const inbox = [];
  const make = (name) => {
    const box = [];
    const session = { playerId: null, sink: (m) => box.push(m) };
    const send = (m) => room.handleClientMessage(table, session, m, (x) => box.push(x));
    send({ type: "join", room: table.code, name, player_id: null, secret: null });
    return { send, box, session, last: (t) => [...box].reverse().find((m) => m.type === t) };
  };
  const host = make("Luigi");
  const guest = make("Anna");
  host.send({ type: "add_bot", level: "esperto" });
  host.send({ type: "set_mode", mode: "fast" });
  host.send({ type: "start" });
  // Qualche mossa sbagliata, per avere anche gli errori di gioco veri.
  guest.send({ type: "bid", value: 99 });
  guest.send({ type: "play", card: "2H" });
  host.send({ type: "set_mode", mode: "boh" });
  host.send({ type: "add_bot", level: "boh" });
  guest.send({ type: "add_bot", level: "facile" });

  const people = [host, guest];
  let guard = 0;
  while (!table.game.isOver) {
    if (++guard > 20000) throw new Error("la partita non finisce");
    const game = table.game;
    if (game.phase === "round_over") { host.send({ type: "next_round" }); continue; }
    const actor = game.currentActor();
    const seat = table.seats[actor];
    if (seat.isBot) { bots.act(game, actor); table.broadcast(); continue; }
    const who = people.find((p) => p.session.playerId === seat.id);
    const view = who.last("state").game;
    if (view.legal_bids.length) who.send({ type: "bid", value: view.legal_bids[0] });
    else who.send({ type: "play", card: view.legal_cards[0] });
  }
  for (const line of table.game.log) add(line, "diario di una partita vera");
  for (const m of [...host.box, ...guest.box]) if (m.type === "error") add(m.message, "errore reale");
  const state = host.last("state");
  add(state.mode_label, "mode_label");
  add(state.game.round.title, "round.title");
  add(state.game.round.kind_label, "round.kind_label");
}

const used = new Set();
for (const [text, src] of samples) {
  I18N.setLang("it", true);
  check(I18N.engine(text) === text, `in italiano la frase cambia: ${text}`);
  I18N.setLang("en", true);
  const out = I18N.engine(text);
  check(out !== text, `senza traduzione (${src}): ${JSON.stringify(text)}`);
  check(!/\{\w+\}/.test(out), `parametro non riempito: ${out}`);
  const idx = I18N._which(text);
  if (idx >= 0) used.add(idx);
}

// Un modello che nessuna frase del codice usa piu' e' un modello morto.
I18N._engine.forEach(([it], idx) => {
  check(used.has(idx), `modello mai usato dal codice: ${JSON.stringify(it)}`);
});

// Traduzioni a campione, per vedere che i pezzi vadano al posto giusto.
I18N.setLang("en", true);
const eq = (input, expected) => check(I18N.engine(input) === expected, `${input} -> ${I18N.engine(input)} (atteso: ${expected})`);
eq("Anna gioca 10S.", "Anna plays 10S.");
eq("Anna esce: al suo posto gioca un bot.", "Anna left: a bot plays in their place.");
eq("Round 3/10 — NO BRISCOLA · 7 carte", "Round 3/10 — NO TRUMP · 7 cards");
eq("Round 1/10 — 7 carte", "Round 1/10 — 7 cards");
eq("devi rispondere a picche", "you must follow spades");
eq("Partita veloce (10 round)", "Fast game (10 rounds)");
eq("A PERDERE · 7 carte", "MISÈRE · 7 cards");
// Il nome di un giocatore non puo' far scambiare una frase per un'altra.
eq("Un tipo gioca un bot dichiara 5 gioca 7H.", "Un tipo gioca un bot dichiara 5 plays 7H.");
eq("frase mai vista", "frase mai vista");
check(I18N.engine(42) === 42 && I18N.engine(null) === null, "engine deve lasciare stare cio' che non e' testo");

/* --------------------------------------------------------------------------- */

if (failures.length) {
  console.error(`FALLITI ${failures.length} controlli su ${checks}:`);
  for (const message of failures) console.error("  - " + message);
  process.exit(1);
}
console.log(`i18n: ${checks} controlli ok (${Object.keys(S).length} chiavi, ${I18N._engine.length} modelli, ${samples.size} frasi)`);
