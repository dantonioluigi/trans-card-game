/* L'host peer-to-peer con un finto PeerJS: ospiti che inondano, messaggi enormi,
 * troppe connessioni, furto di un posto via rete.
 *
 * WebRTC e' solo il tubo, ma i limiti vivono nel codice che sta fra il tubo e il
 * tavolo (hostTable in net-p2p.js): e' quel cablaggio che si prova qui.
 *
 *   node site/tests/host.mjs
 */

let checks = 0;
const failures = [];
function check(condition, message) {
  checks++;
  if (!condition) failures.push(message);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------ finto browser */

class Emitter {
  constructor() {
    this.handlers = {};
  }
  on(event, fn) {
    (this.handlers[event] ||= []).push(fn);
  }
  emit(event, ...args) {
    for (const fn of this.handlers[event] || []) fn(...args);
  }
}

class FakePeer extends Emitter {
  constructor(id, options) {
    super();
    this.id = id;
    this.options = options;
    FakePeer.last = this;
    setTimeout(() => this.emit("open"), 0);
  }
  destroy() {
    this.destroyed = true;
  }
  reconnect() {}
}

class FakeConn extends Emitter {
  constructor() {
    super();
    this.open = true;
    this.sent = [];
    this.closed = false;
  }
  send(message) {
    this.sent.push(message);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit("close");
  }
  last(type) {
    return this.sent.findLast((m) => m && m.type === type) ?? null;
  }
}

globalThis.window = globalThis;
globalThis.location = { hostname: "gioco.example", port: "", search: "?broker=https://evil.example" };
globalThis.Peer = FakePeer;
const warnings = [];
console.warn = (...args) => warnings.push(args.join(" "));

await import("../js/net-p2p.js");

function openHost() {
  const received = [];
  const link = window.TRANS_TRANSPORT.create({
    onOpen: () => link.send({ type: "join", room: null, name: "Luigi", player_id: null, secret: null }),
    onMessage: (m) => received.push(m),
    onClose: () => {},
  });
  return { link, received, last: (t) => received.findLast((m) => m.type === t) ?? null };
}

async function connectGuest(name, extra = {}) {
  const conn = new FakeConn();
  FakePeer.last.emit("connection", conn);
  conn.emit("data", { type: "join", name, ...extra });
  await sleep(5);
  return conn;
}

/* ---------------------------------------------------------------- scenari */

{
  const host = openHost();
  await sleep(20);
  check(host.last("welcome") !== null, "l'host non si e' seduto al suo tavolo");
  check(FakePeer.last.id.startsWith("trans-") && FakePeer.last.id.length === "trans-".length + 4,
        `id del peer inatteso: ${FakePeer.last.id}`);
  const hostId = host.last("welcome").player_id;
  // Il pagina e' pubblica e l'indirizzo contiene ?broker=: non deve cambiare il broker.
  check(FakePeer.last.options.host === undefined && FakePeer.last.options.secure === undefined,
        "un ?broker= nell'indirizzo ha cambiato il broker su una pagina pubblica");

  // Un ospite normale entra, parla, e non viene toccato dai limiti.
  const anna = await connectGuest("Anna");
  check(anna.last("welcome") !== null && anna.last("welcome").secret, "l'ospite non ha ricevuto benvenuto e segreto");
  for (let i = 0; i < 12; i++) anna.emit("data", { type: "chat", text: `riga ${i}` });
  await sleep(10);
  check(!anna.closed, "un ospite che scrive 12 righe e' stato escluso");

  // Furto di posto via rete: Bob ha visto l'id dell'host in uno stato, ma non il segreto.
  const bob = await connectGuest("Bob", { player_id: hostId });
  check(bob.last("welcome") !== null && bob.last("welcome").player_id !== hostId,
        "Bob ha preso il posto dell'host con il solo id pubblico");
  check(bob.last("state")?.is_host === false, "Bob e' diventato host via rete");
  bob.emit("data", { type: "add_bot", level: "facile" });
  await sleep(10);
  check(bob.last("error")?.message.includes("solo chi ha creato"), "Bob ha potuto aggiungere un bot");
  const heard = host.received.length;
  anna.emit("data", { type: "chat", text: "ancora li'?" });
  await sleep(10);
  check(host.received.length > heard, "l'host vero ha smesso di ricevere gli stati");

  // Il secondo join sulla stessa connessione non crea un posto fantasma.
  anna.emit("data", { type: "join", name: "Fantasma" });
  await sleep(10);
  check(anna.last("error")?.message.includes("gia' al tavolo"), "un secondo join e' stato accettato");

  // Un'inondazione chiude la connessione, e il posto passa a un bot.
  const flood = await connectGuest("Mallory");
  for (let i = 0; i < 200; i++) flood.emit("data", { type: "ping" });
  check(flood.closed, "200 messaggi di colpo non hanno chiuso la connessione");
  check(warnings.some((w) => w.includes("troppi messaggi")), "manca l'avviso di esclusione per frequenza");
  const before = flood.sent.length;
  flood.emit("data", { type: "chat", text: "sono ancora qui" });
  await sleep(10);
  check(flood.sent.length === before, "una connessione esclusa ha ricevuto risposte");

  // Un messaggio enorme chiude la connessione.
  const big = await connectGuest("Eve");
  big.emit("data", { type: "chat", text: "x".repeat(10_000) });
  check(big.closed, "un messaggio da 10000 caratteri non ha chiuso la connessione");
  check(warnings.some((w) => w.includes("troppo grande")), "manca l'avviso di esclusione per dimensione");

  // Un messaggio senza forma di oggetto viene ignorato senza rompere niente.
  anna.emit("data", "testo");
  anna.emit("data", 42);
  anna.emit("data", null);
  anna.emit("data", { type: 5 });
  await sleep(10);
  check(!anna.closed, "messaggi senza forma hanno chiuso una connessione che si comporta bene");

  host.link.close();
}

{
  // Troppe connessioni: oltre il tetto si chiude subito, senza seduta.
  const host = openHost();
  await sleep(20);
  const conns = [];
  for (let i = 0; i < 16; i++) {
    const conn = new FakeConn();
    FakePeer.last.emit("connection", conn);
    conns.push(conn);
  }
  const refused = conns.filter((c) => c.closed).length;
  check(refused === 4, `con 16 connessioni dovevano essere rifiutate 4, sono state ${refused}`);
  host.link.close();
}

{
  // Un host che chiude il tavolo non lascia timer: il processo puo' finire.
  const host = openHost();
  await sleep(20);
  host.link.close();
  check(FakePeer.last.destroyed === true, "chiudendo il tavolo il peer non e' stato distrutto");
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} problemi su ${checks} controlli:\n`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`✓ host peer-to-peer con limiti — ${checks} controlli superati`);
