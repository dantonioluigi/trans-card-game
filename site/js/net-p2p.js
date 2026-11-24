/* Trasporto peer-to-peer: multiplayer senza nessun server nostro.
 *
 * Chi apre la stanza tiene il tavolo nel proprio browser e fa da arbitro; gli
 * altri si collegano a lui con WebRTC e gli mandano le stesse intenzioni che
 * manderebbero al server Python.
 *
 * Per collegarsi servono tre cose, e ognuna puo' mancare:
 *  - il broker di PeerJS, che fa presentare i browser;
 *  - STUN, con cui ogni browser scopre il proprio indirizzo pubblico: basta
 *    quando le reti sono "gentili";
 *  - un relay TURN, che inoltra il traffico quando il collegamento diretto e'
 *    impossibile: 4G, hotspot del telefono, reti aziendali. PeerJS ne elenca
 *    uno pubblico nella configurazione di default, ma quei server non esistono
 *    piu' (i nomi non risolvono): senza un relay nostro, fuori dalla stessa
 *    Wi-Fi il collegamento spesso non si apre.
 *
 * Limiti: se l'host chiude la scheda la partita finisce per tutti, e la sua
 * pagina conosce le carte di tutti.
 */

import { Table, handleClientMessage, localTable, newRoomCode, silentSessions } from "./room.js";
import { trustedQuery } from "./params.js";
import {
  CAN_COMPRESS, MAX_GUESTS, MAX_PENDING, RATE_BURST, RATE_PER_SECOND, TokenBucket, pack, smallEnough, unpack,
} from "./limits.js";

const PEER_PREFIX = "trans-";
const ID_ATTEMPTS = 5;

const OPEN_TIMEOUT = 12000;      // broker o collegamento diretto che non si aprono
const TURN_FETCH_TIMEOUT = 6000; // credenziali del relay
// Il battito passa dal relay anche quando nessuno gioca, e il relay si paga a
// byte. Chi chiude la scheda viene rilevato subito lo stesso: il battito serve
// solo per chi sparisce senza chiudere, e li' mezzo minuto basta.
const PING_EVERY = 10000;
const SILENCE_LIMIT = 30000;     // oltre, chi tace e' considerato uscito

// Piu' di uno, di fornitori diversi: se uno e' giu' non si resta ciechi.
const STUN_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

/* La versione del tavolo: chi gioca insieme deve vedere le stesse regole. Il
 * tavolo vive sul telefono di chi lo crea, e le regole e i punteggi li calcola
 * lui: un ospite con una versione diversa vedrebbe un testo delle regole, o dei
 * messaggi, che non corrisponde a quello che succede davvero.
 *
 * Va ALZATO a mano quando cambia qualcosa che due versioni al tavolo vedrebbero
 * in modo diverso (una regola, un punteggio, un messaggio del protocollo). NON
 * serve per quello che resta sul telefono di chi lo ha (grafica, margini, avvisi).
 *
 * Chi non lo manda e' una versione fino alla rc6: per quelle vale 1. */
export const PROTOCOL = 2;
const LEGACY_PROTOCOL = 1;

export const MESSAGES = {
  broker:
    "non riesco a raggiungere il servizio che mette in contatto i browser. " +
    "Puo' essere momentaneamente giu', oppure la rete che stai usando lo blocca.",
  direct:
    "il tavolo esiste, ma i vostri browser non riescono a collegarsi fra loro. " +
    "Succede quando non siete sulla stessa rete (4G, hotspot, reti aziendali): " +
    "provate sulla stessa Wi-Fi.",
  directWithRelay:
    "il tavolo esiste, ma il collegamento non passa nemmeno dal relay: " +
    "probabilmente la rete che stai usando blocca anche quello.",
  hostClosed: "l'host ha chiuso la stanza",
  hostLost: "l'host non risponde piu': ha chiuso la scheda o ha perso la connessione",
  guestOutdated:
    "la tua versione di Dichiaro e' piu' vecchia di quella di chi ha creato il tavolo: " +
    "aggiornala (dal Play Store, o ricarica la pagina nel browser) e riprova.",
  hostOutdated:
    "chi ha creato il tavolo ha una versione di Dichiaro piu' vecchia della tua: " +
    "digli di aggiornarla (dal Play Store, o di ricaricare la pagina nel browser).",
};

/* ----------------------------------------------------------- configurazione */

let icePromise = null;

/** Le credenziali del relay si chiedono una volta per pagina. */
function loadIce() {
  if (!icePromise) icePromise = fetchIce();
  return icePromise;
}

async function fetchIce() {
  const params = trustedQuery(location);

  // Elenco gia' pronto (credenziali statiche, tipiche di un piano gratuito
  // senza scadenza): niente richiesta in piu' per aprire una connessione.
  // ?ice= serve per le prove; in produzione lo mette la build.
  const staticJson = params.get("ice") || "";
  const embedded = staticJson ? tryParse(staticJson) : window.TRANS_TURN_ICE;
  if (embedded) {
    const turn = normaliseIce(embedded);
    if (turn.length) return { servers: [...STUN_SERVERS, ...turn], relay: true };
  }

  // In alternativa, un endpoint che genera credenziali temporanee al volo.
  // ?turn= serve per le prove; in produzione l'indirizzo lo mette la build.
  const url = params.get("turn") || window.TRANS_TURN_URL || "";
  if (!url) return { servers: STUN_SERVERS, relay: false };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TURN_FETCH_TIMEOUT);
  try {
    const response = await fetch(url, { signal: abort.signal });
    const turn = normaliseIce(await response.json());
    if (!turn.length) throw new Error("nessun server nella risposta");
    return { servers: [...STUN_SERVERS, ...turn], relay: true };
  } catch (err) {
    // Senza relay si gioca lo stesso: sulla stessa rete funziona comunque.
    console.warn("TRANS: relay non disponibile, solo collegamento diretto", err);
    return { servers: STUN_SERVERS, relay: false };
  } finally {
    clearTimeout(timer);
  }
}

function tryParse(json) {
  try {
    return JSON.parse(json);
  } catch (err) {
    console.warn("TRANS: elenco ICE nell'indirizzo non valido", err);
    return null;
  }
}

/** Metered risponde con un array, Cloudflare con {iceServers}: vanno bene entrambi. */
function normaliseIce(body) {
  const list = Array.isArray(body) ? body : body && body.iceServers;
  if (!list) return [];
  return (Array.isArray(list) ? list : [list]).filter((server) => server && server.urls);
}

/**
 * ?broker=https://mio-broker cambia il broker, ?relay=1 obbliga a passare dal
 * relay (serve a verificare che funzioni davvero).
 */
function peerOptions(ice) {
  const params = trustedQuery(location);
  const options = { debug: 0, config: { iceServers: ice.servers } };
  if (params.get("relay") === "1") options.config.iceTransportPolicy = "relay";

  const broker = params.get("broker") || window.TRANS_BROKER || "";
  if (broker) {
    const url = new URL(broker);
    Object.assign(options, {
      host: url.hostname,
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname && url.pathname !== "/" ? url.pathname : "/",
      secure: url.protocol === "https:",
    });
  }
  return options;
}

function peerId(code) {
  return PEER_PREFIX + code.toUpperCase();
}

function brokerError(err) {
  if (err.type === "browser-incompatible") return "questo browser non supporta WebRTC";
  return MESSAGES.broker;
}

function safeSend(conn, message) {
  if (conn.open) conn.send(message);
}

/* --------------------------------------------------------------- arbitro -- */

function hostTable(handlers) {
  let table = null;
  let peer = null;
  let closed = false;
  let sweeper = null;
  const guests = new Set();
  // Dopo close() il Table ha ancora i timer dei bot: senza questa guardia, un
  // loro messaggio tardivo rimetterebbe in primo piano il tavolo appena lasciato.
  const session = {
    playerId: null,
    sink: (msg) => {
      if (table) handlers.onMessage(msg);
    },
  };

  loadIce().then((ice) => {
    if (!closed) claimId(1, ice);
  });

  function claimId(attempt, ice) {
    const code = newRoomCode();
    const candidate = new Peer(peerId(code), peerOptions(ice));

    const giveUp = setTimeout(() => {
      if (closed || peer) return;
      candidate.destroy();
      handlers.onClose({ fatal: true, message: MESSAGES.broker });
    }, OPEN_TIMEOUT);

    let retry = 1000;

    candidate.on("open", () => {
      clearTimeout(giveUp);
      if (closed) return candidate.destroy();
      if (peer) {
        // PeerJS rimanda "open" anche dopo reconnect(). Qui prima nasceva un
        // tavolo nuovo: a ogni singhiozzo del broker la partita in corso
        // spariva per tutti. Il tavolo e' quello di prima, basta ripartire.
        retry = 1000;
        return;
      }
      peer = candidate;
      table = new Table(code);
      sweeper = setInterval(sweepSilentGuests, PING_EVERY);
      handlers.onOpen();
    });

    candidate.on("error", (err) => {
      if (peer) {
        // A tavolo aperto nessun errore del Peer e' fatale. PeerJS ci manda qui
        // sia i guasti del singolo ospite sia la perdita del broker, e in
        // entrambi i casi le connessioni gia' aperte restano vive: chiudere il
        // tavolo per questo buttava fuori tutti per colpa di uno.
        console.warn("TRANS: errore non fatale sull'host", err.type, err.message);
        return;
      }
      clearTimeout(giveUp);
      if (err.type === "unavailable-id" && attempt < ID_ATTEMPTS) {
        candidate.destroy();
        return claimId(attempt + 1, ice);
      }
      if (!closed) handlers.onClose({ fatal: true, message: brokerError(err) });
    });

    // Perso il broker, chi e' gia' al tavolo continua a giocare; serve solo a
    // chi deve ancora entrare. Si riprova con attese crescenti: riprovare
    // subito, con il broker giu', diventa un ciclo senza fine.
    candidate.on("disconnected", () => {
      if (closed || candidate.destroyed) return;
      setTimeout(() => {
        if (!closed && !candidate.destroyed && candidate.disconnected) candidate.reconnect();
      }, retry);
      retry = Math.min(retry * 2, 30000);
    });

    candidate.on("connection", wireGuest);
  }

  function wireGuest(conn) {
    // I posti sono 7: chi ne apre di piu' sta solo consumando la pagina dell'host.
    if (guests.size >= MAX_GUESTS) {
      conn.close();
      return;
    }
    const guest = {
      playerId: null,
      secret: null,
      lastHeard: Date.now(),
      away: false,
      compress: false,
      queue: Promise.resolve(),
      pending: 0,
      bucket: new TokenBucket(RATE_BURST, RATE_PER_SECOND),
      banned: false,
      conn,
      sink: (msg) => post(guest, msg),
    };
    guests.add(guest);

    // Fuori dai limiti non e' una partita: si chiude, e il posto passa a un bot.
    const kick = (why) => {
      if (guest.banned) return;
      guest.banned = true;
      console.warn("TRANS: ospite escluso:", why);
      conn.close();
    };

    // Versione diversa dalla nostra: gli si dice perche' e non lo si ascolta piu'.
    // Non si chiude subito: una versione vecchia, vedendo la chiusura, scriverebbe
    // "l'host ha chiuso la stanza" al posto del motivo. Chi tace senza essersi
    // seduto lo toglie comunque sweepSilentGuests, dopo mezzo minuto.
    const refuse = (message) => {
      guest.banned = true;
      post(guest, { type: "error", message, fatal: true });
    };

    conn.on("data", (msg) => {
      if (guest.banned) return;
      guest.lastHeard = Date.now();
      if (!table || !msg || typeof msg !== "object") return;
      if (!guest.bucket.take()) return kick("troppi messaggi");
      if (!smallEnough(msg)) return kick("messaggio troppo grande");
      if (msg.type === "join" && !guest.playerId) {
        const theirs = Number.isInteger(msg.proto) ? msg.proto : LEGACY_PROTOCOL;
        if (theirs !== PROTOCOL) return refuse(theirs < PROTOCOL ? MESSAGES.guestOutdated : MESSAGES.hostOutdated);
      }
      if (msg.type === "join" && msg.compress && CAN_COMPRESS) guest.compress = true;
      if (guest.away) comeBack(guest);
      // Il benvenuto porta la nostra versione: un ospite piu' nuovo di un host che
      // non controlla nulla (fino alla rc6) la vede mancare e se ne accorge da solo.
      handleClientMessage(table, guest, msg, (out) => post(guest, out.type === "welcome" ? { ...out, proto: PROTOCOL } : out));
    });

    guest.kick = kick;
    const drop = () => {
      if (!guests.delete(guest)) return;
      if (table && guest.playerId && !guest.away) {
        table.leave(guest.playerId);
        table.broadcast();
        table.pump();
      }
    };
    conn.on("close", drop);
    conn.on("error", drop);
  }

  /**
   * Tutto quello che va a un ospite passa da qui, in fila: la compressione e'
   * asincrona, e senza la fila uno stato vecchio potrebbe superarne uno nuovo.
   */
  function post(guest, message) {
    // Chi non legge i propri stati li lascia accumulare nella nostra memoria.
    if (guest.pending >= MAX_PENDING) return guest.kick("non legge i messaggi");
    guest.pending++;
    guest.queue = guest.queue
      .then(() => (guest.compress ? pack(message).then((z) => ({ z })) : message))
      .then((wire) => safeSend(guest.conn, wire))
      .catch((err) => console.warn("TRANS: invio all'ospite fallito", err))
      .finally(() => { guest.pending--; });
  }

  /**
   * Chi tace da troppo passa al bot, ma la connessione resta aperta: spesso non
   * e' morta, e' solo una scheda in background con i timer rallentati. Se torna
   * a farsi sentire, si risiede da solo.
   */
  function sweepSilentGuests() {
    if (!table) return;
    const now = Date.now();
    let changed = false;
    for (const guest of silentSessions([...guests], now, SILENCE_LIMIT)) {
      if (guest.away) continue;
      guest.away = true;
      table.leave(guest.playerId);
      changed = true;
    }
    // Chi non e' mai riuscito a entrare non tiene occupato niente.
    for (const guest of guests) {
      if (!guest.playerId && now - guest.lastHeard > SILENCE_LIMIT) {
        guests.delete(guest);
        guest.conn.close();
      }
    }
    if (changed) {
      table.broadcast();
      table.pump();
    }
  }

  function comeBack(guest) {
    guest.away = false;
    if (!table.seatById(guest.playerId)) {
      // Nel frattempo qualcuno si e' seduto al suo posto: niente posto nuovo
      // assegnato di nascosto, glielo si dice.
      post(guest, { type: "error", message: "mentre eri assente il tuo posto e' stato preso" });
      guests.delete(guest);
      guest.conn.close();
      return;
    }
    table.join(guest.playerId, "", guest.sink, guest.secret);
    table.broadcast();
  }

  return {
    send(message) {
      if (table) handleClientMessage(table, session, message, (out) => handlers.onMessage(out));
    },
    close() {
      closed = true;
      clearInterval(sweeper);
      if (peer) peer.destroy();
      peer = null;
      table = null;
    },
  };
}

/* ---------------------------------------------------------------- ospite -- */

function joinAsGuest(handlers) {
  const code = String(handlers.room || "").toUpperCase();
  let closed = false;
  let peer = null;
  let conn = null;
  let brokerReached = false;
  let opened = false;
  let relay = false;
  let giveUp = null;
  let pinger = null;
  let waitingSince = null;

  loadIce().then((ice) => {
    if (closed) return;
    relay = ice.relay;
    peer = new Peer(peerOptions(ice));
    giveUp = setTimeout(() => finish(brokerReached ? directFailure() : MESSAGES.broker), OPEN_TIMEOUT);

    peer.on("open", () => {
      if (closed) return;
      brokerReached = true;
      conn = peer.connect(peerId(code), { reliable: true });

      conn.on("open", () => {
        if (closed) return;
        opened = true;
        clearTimeout(giveUp);
        pinger = setInterval(heartbeat, PING_EVERY);
        handlers.onOpen();
      });
      let inbox = Promise.resolve();
      conn.on("data", (msg) => {
        waitingSince = null;
        if (closed || !msg || typeof msg !== "object") return;
        // Anche la decompressione in fila, per non invertire l'ordine degli stati.
        inbox = inbox
          .then(() => (msg.z ? unpack(msg.z) : msg))
          .then((plain) => {
            if (!plain || typeof plain !== "object" || typeof plain.type !== "string") return;
            if (closed || plain.type === "pong") return;
            // L'host ci rifiuta per la versione: il motivo e' l'ultima cosa che dice.
            if (plain.type === "error" && plain.fatal) return finish(String(plain.message || MESSAGES.hostClosed));
            // Un host fino alla rc6 non manda la versione ne' controlla la nostra:
            // se la nostra e' piu' nuova, a non capirsi sarebbero le regole.
            if (plain.type === "welcome" && (Number.isInteger(plain.proto) ? plain.proto : LEGACY_PROTOCOL) < PROTOCOL) {
              return finish(MESSAGES.hostOutdated);
            }
            handlers.onMessage(plain);
          })
          .catch((err) => console.warn("TRANS: messaggio dall'host illeggibile", err));
      });
      // Prima dell'apertura, chiusura ed errore significano che il collegamento
      // diretto non e' riuscito (PeerJS chiude la connessione quando ICE fallisce).
      conn.on("close", () => finish(opened ? MESSAGES.hostClosed : directFailure()));
      conn.on("error", () => finish(opened ? MESSAGES.hostLost : directFailure()));
    });

    peer.on("error", (err) => {
      if (err.type === "peer-unavailable") {
        return finish(`nessuna stanza aperta con il codice ${code}`);
      }
      if (opened) return; // a partita avviata il broker non serve piu'
      finish(brokerReached ? directFailure() : brokerError(err));
    });
  });

  function directFailure() {
    return relay ? MESSAGES.directWithRelay : MESSAGES.direct;
  }

  /**
   * Il silenzio si misura dal proprio ping senza risposta, non dall'ultimo
   * messaggio ricevuto: se nessuno gioca, l'host non ha niente da dire, e in
   * una scheda in background i timer girano una volta al minuto.
   */
  function heartbeat() {
    if (closed || !conn) return;
    const now = Date.now();
    if (waitingSince !== null && now - waitingSince > SILENCE_LIMIT) {
      return finish(MESSAGES.hostLost);
    }
    if (waitingSince === null) waitingSince = now;
    safeSend(conn, { type: "ping" });
  }

  function finish(message) {
    if (closed) return;
    closed = true;
    clearTimeout(giveUp);
    clearInterval(pinger);
    if (peer) peer.destroy();
    handlers.onClose({ fatal: true, message });
  }

  return {
    send(message) {
      if (!conn) return;
      const wanted = message.type === "join"
        ? { ...message, proto: PROTOCOL, ...(CAN_COMPRESS ? { compress: true } : {}) }
        : message;
      safeSend(conn, wanted);
    },
    close() {
      closed = true;
      clearTimeout(giveUp);
      clearInterval(pinger);
      if (conn) conn.close();
      if (peer) peer.destroy();
    },
  };
}

/* ------------------------------------------------------------------------- */

window.TRANS_TRANSPORT = {
  create(handlers) {
    if (handlers.local) return localTable(handlers);
    if (typeof Peer === "undefined") {
      setTimeout(() => handlers.onClose({ fatal: true, message: "libreria di connessione non caricata" }), 0);
      return { send() {}, close() {} };
    }
    return handlers.room ? joinAsGuest(handlers) : hostTable(handlers);
  },
};
