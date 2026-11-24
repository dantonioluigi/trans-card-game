/* L'interfaccia vera (web/app.js) contro il tavolo vero (site/js/room.js).
 *
 * Non c'e' un browser: il DOM e' un finto che si limita a ricordare cosa gli
 * viene assegnato (hidden, textContent...). Basta per vedere se l'app mostra o
 * nasconde i pannelli giusti mentre il tavolo cambia stato. Nasce da un guasto
 * reale: dopo "Torna alla lobby" il pannello della fine partita restava sopra
 * la lobby e non lasciava toccare niente.
 *
 *   node site/tests/app.mjs
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");

/* ------------------------------------------------------------- il finto DOM */

const stores = new Map(); // id -> proprieta' assegnate all'elemento

/** Un oggetto che accetta qualunque uso: legge e chiama senza rompersi. */
function ghost(store = {}) {
  const fn = function () { return ghost(); };
  return new Proxy(fn, {
    get(_, prop) {
      if (prop in store) return store[prop];
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === Symbol.iterator) return function* () {};
      if (prop === "length") return 0;
      if (prop === "then") return undefined;
      return ghost();
    },
    set(_, prop, value) { store[prop] = value; return true; },
    apply() { return ghost(); },
  });
}

function element(id) {
  if (!stores.has(id)) {
    const store = {};
    stores.set(id, { store, proxy: ghost(store) });
  }
  return stores.get(id).proxy;
}
const prop = (id, name) => (stores.get(id) || { store: {} }).store[name];

const listeners = {};
const localStore = new Map([["trans.pid", "p-test"], ["trans.name", "Luigi"]]);

// Node ha gia' alcuni di questi nomi (navigator...) come proprieta' di sola lettura.
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

define("window", globalThis);
define("document", {
  getElementById: element,
  createElement: () => ghost(),
  querySelector: () => ghost({ href: "" }),
  querySelectorAll: () => [],
  addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  documentElement: ghost(),
  visibilityState: "visible",
  title: "",
});
define("navigator", { language: "it-IT", languages: ["it-IT"] });
define("addEventListener", (type, fn) => { (listeners[type] ||= []).push(fn); });
define("localStorage", {
  getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
  setItem: (k, v) => localStore.set(k, String(v)),
});
const loc = { hash: "#ABCD", pathname: "/", origin: "https://gioco.example", search: "", hostname: "gioco.example", port: "" };
define("location", loc);
define("history", { replaceState() {} });
define("Peer", class {});
define("requestAnimationFrame", (fn) => setTimeout(fn, 0));

define("I18N", createRequire(import.meta.url)("../../web/i18n.js"));

// Il trasporto finto: i messaggi dell'app vanno dritti al tavolo, quelli del
// tavolo dritti all'app.
const { Table, handleClientMessage } = await import("../js/room.js");
const bots = await import("../js/bots.js");

const table = new Table("ABCD");
let appHandlers = null;
const session = { playerId: null, sink: (msg) => appHandlers && appHandlers.onMessage(msg) };
const deliver = (msg) => session.sink(msg);

window.TRANS_TRANSPORT = {
  create(handlers) {
    appHandlers = handlers;
    setTimeout(() => handlers.onOpen(), 0);
    return {
      send: (msg) => handleClientMessage(table, session, msg, deliver),
      close() {},
    };
  },
};

// L'app si puo' "riaprire" piu' volte nello stesso processo: ogni volta parte
// da una pagina nuova, come dopo aver chiuso e riaperto l'app sul telefono.
const appSource = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
function loadApp() {
  stores.clear();
  element("screenHome").hidden = false; // come in index.html: la home e' lo schermo di partenza
  listeners.DOMContentLoaded = [];
  vm.runInThisContext(appSource, { filename: "web/app.js" });
  for (const fn of listeners.DOMContentLoaded) fn();
}

/* ----------------------------------------------------------------- il test */

let checks = 0;
const failures = [];
function check(condition, message) {
  checks++;
  if (!condition) failures.push(message);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await sleep(20);
  }
  return condition();
}
const click = (id) => prop(id, "onclick")();

/* ------------------------------------------------ avviso di aggiornamento */

// Play parla solo con l'app installata dallo store: qui un plugin finto che
// annota cosa gli si chiede. Sul sito (window.Capacitor assente) non esiste.
function playSays(info, { result = { code: 0 }, failInfo = false } = {}) {
  const calls = [];
  globalThis.Capacitor = {
    Plugins: {
      AppUpdate: {
        getAppUpdateInfo: async () => { calls.push("info"); if (failInfo) throw new Error("niente Play"); return info; },
        performImmediateUpdate: async () => { calls.push("immediato"); return result; },
        openAppStore: async () => { calls.push("store"); },
      },
    },
  };
  return calls;
}
async function openOnHome() { loc.hash = ""; loadApp(); await sleep(30); }
const updateShown = () => prop("updateOverlay", "hidden") === false;
const AVAILABLE = { updateAvailability: 2, immediateUpdateAllowed: true };

delete globalThis.Capacitor;
await openOnHome();
check(!updateShown(), "sul sito (senza plugin) e' comparso l'avviso di aggiornamento");

let calls = playSays({ updateAvailability: 1 });
await openOnHome();
check(calls.join() === "info" && !updateShown(), "senza aggiornamenti e' comparso l'avviso");

calls = playSays(AVAILABLE);
await openOnHome();
check(updateShown(), "con un aggiornamento disponibile l'avviso non compare");
await click("btnUpdateLater");
check(!updateShown() && calls.join() === "info", "\"Piu' tardi\" non chiude l'avviso o avvia l'aggiornamento");

calls = playSays(AVAILABLE);
await openOnHome();
await click("btnUpdate");
check(!updateShown() && calls.join() === "info,immediato", `"Aggiorna" doveva avviare l'aggiornamento di Play, ha fatto: ${calls}`);

calls = playSays(AVAILABLE, { result: { code: 1 } });
await openOnHome();
await click("btnUpdate");
check(calls.join() === "info,immediato", `chi annulla la schermata di Play non deve finire nello store, ha fatto: ${calls}`);

calls = playSays(AVAILABLE, { result: { code: 2 } });
await openOnHome();
await click("btnUpdate");
check(calls.join() === "info,immediato,store", `se Play non riesce si apre lo store, ha fatto: ${calls}`);

calls = playSays({ updateAvailability: 2, immediateUpdateAllowed: false });
await openOnHome();
await click("btnUpdate");
check(calls.join() === "info,store", `senza aggiornamento immediato si apre lo store, ha fatto: ${calls}`);

{
  const warn = console.warn;
  console.warn = () => {}; // l'app lo segnala, ed e' quello che deve fare
  calls = playSays(AVAILABLE, { failInfo: true });
  await openOnHome();
  console.warn = warn;
  check(calls.join() === "info" && !updateShown(), "senza i servizi di Play l'app dovrebbe restare muta");
}

// Con un tavolo che si apre da solo non si butta una finestra addosso a chi gioca.
calls = playSays(AVAILABLE);
loc.hash = "#ABCD";
loadApp();

// L'app entra al tavolo da sola (indirizzo #ABCD, nome e id gia' salvati).
check(await until(() => prop("screenLobby", "hidden") === false), "l'app non e' arrivata alla lobby");
check(prop("screenGame", "hidden") === true, "in lobby lo schermo di gioco dovrebbe essere nascosto");
check(!updateShown(), "l'avviso di aggiornamento e' comparso mentre l'app entrava al tavolo");

table.addBot(table.hostId, "normale");
table.broadcast();
click("btnStart");
check(await until(() => prop("screenGame", "hidden") === false), "la partita non e' partita");

// Si gioca fino in fondo: l'umano con la prima mossa legale, il bot col suo cervello.
let guard = 0;
while (!table.game.isOver) {
  if (++guard > 20000) throw new Error("la partita non finisce");
  const game = table.game;
  if (game.phase === "round_over") { handleClientMessage(table, session, { type: "next_round" }, deliver); continue; }
  const actor = game.currentActor();
  const seat = table.seats[actor];
  if (seat.isBot) { bots.act(game, actor); table.broadcast(); continue; }
  const view = table.snapshotFor(seat.id).game;
  const move = view.legal_bids.length
    ? { type: "bid", value: view.legal_bids[0] }
    : { type: "play", card: view.legal_cards[0] };
  handleClientMessage(table, session, move, deliver);
}

check(await until(() => prop("endOverlay", "hidden") === false), "a fine partita il pannello finale non si vede");
check(prop("btnNewGame", "disabled") === false, "chi ha creato il tavolo non puo' tornare alla lobby");

// "Torna alla lobby": il pannello finale deve sparire e la lobby deve restare libera.
click("btnNewGame");
check(await until(() => prop("screenLobby", "hidden") === false), "non si e' tornati alla lobby");
check(prop("endOverlay", "hidden") === true, "il pannello della fine partita copre ancora la lobby");
check(prop("resultOverlay", "hidden") === true, "il pannello del round copre la lobby");
check(prop("bidPanel", "hidden") === true, "il pannello delle dichiarazioni copre la lobby");

// Dalla lobby si riparte, e in partita il pannello della fine non si vede piu'.
click("btnStart");
check(await until(() => prop("screenGame", "hidden") === false), "dopo la lobby la nuova partita non e' partita");
check(prop("endOverlay", "hidden") === true, "il pannello della fine partita e' rimasto aperto nella nuova partita");

if (failures.length) {
  console.error(`${failures.length} controlli falliti su ${checks}:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`app.mjs: ${checks} controlli ok`);
process.exit(0);
