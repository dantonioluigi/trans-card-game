/* Trasporto peer-to-peer: multiplayer senza nessun server nostro.
 *
 * Chi apre la stanza tiene il tavolo nel proprio browser e fa da arbitro; gli
 * altri si collegano a lui con WebRTC e gli mandano le stesse identiche
 * intenzioni che il client manderebbe al server Python. La UI non nota la
 * differenza: dall'altra parte del filo cambia solo chi risponde.
 *
 * PeerJS serve per il "presentarsi": due browser non si trovano da soli, gli
 * serve un intermediario che si scambi gli indirizzi. Usiamo il broker
 * pubblico di PeerJS — passa solo la stretta di mano, le carte poi viaggiano
 * dirette da browser a browser.
 *
 * Limiti da tenere a mente:
 *  - se l'host chiude la scheda, la partita finisce per tutti;
 *  - la sua pagina conosce le carte di tutti (non gliele mostra, ma ci sono).
 */

import { Table, handleClientMessage, newRoomCode } from "./room.js";

const PEER_PREFIX = "trans-";
const ID_ATTEMPTS = 5;

// PeerJS, se il broker non risponde, resta appeso in silenzio: niente "open",
// niente "error", per sempre. Senza questa scadenza il giocatore preme il
// bottone e non succede piu' nulla.
const OPEN_TIMEOUT = 12000;

const UNREACHABLE =
  "non riesco a raggiungere il servizio che mette in contatto i browser. " +
  "Puo' essere lui momentaneamente giu', oppure la rete che stai usando che " +
  "blocca questo tipo di collegamento (capita su reti aziendali).";

/**
 * Il broker si puo' cambiare: ?broker=https://mio-broker nell'indirizzo, o
 * window.TRANS_BROKER. Senza indicazioni si usa quello pubblico di PeerJS.
 * Serve a chi si trova il broker pubblico bloccato o giu': peerjs-server e'
 * un container da due righe.
 */
function peerOptions() {
  const chosen =
    new URLSearchParams(location.search).get("broker") || window.TRANS_BROKER || "";
  if (!chosen) return { debug: 0 };
  const url = new URL(chosen);
  return {
    host: url.hostname,
    port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname && url.pathname !== "/" ? url.pathname : "/",
    secure: url.protocol === "https:",
    debug: 0,
  };
}

function peerId(code) {
  return PEER_PREFIX + code.toUpperCase();
}

function fatal(handlers, message) {
  handlers.onClose({ fatal: true, message });
}

/* --------------------------------------------------------------- arbitro -- */

function hostTable(handlers) {
  let table = null;
  let peer = null;
  let closed = false;
  const session = { playerId: null, sink: (msg) => handlers.onMessage(msg) };

  function claimId(attempt) {
    const code = newRoomCode();
    const candidate = new Peer(peerId(code), peerOptions());

    const giveUp = setTimeout(() => {
      if (closed) return;
      candidate.destroy();
      fatal(handlers, UNREACHABLE);
    }, OPEN_TIMEOUT);

    candidate.on("open", () => {
      clearTimeout(giveUp);
      if (closed) {
        candidate.destroy();
        return;
      }
      peer = candidate;
      table = new Table(code);
      handlers.onOpen();
    });

    candidate.on("error", (err) => {
      if (err.type === "unavailable-id" && attempt < ID_ATTEMPTS) {
        clearTimeout(giveUp);
        candidate.destroy();
        claimId(attempt + 1);
        return;
      }
      clearTimeout(giveUp);
      if (closed) return;
      fatal(handlers, brokerError(err));
    });

    // Il broker chiude le connessioni inattive: senza reconnect, dopo un po'
    // nessuno riuscirebbe piu' a entrare nella stanza.
    candidate.on("disconnected", () => {
      if (!closed) candidate.reconnect();
    });

    candidate.on("connection", (conn) => wireGuest(conn));
  }

  function wireGuest(conn) {
    const guest = { playerId: null, sink: (msg) => conn.send(msg) };
    conn.on("data", (msg) => {
      if (!table || !msg || typeof msg !== "object") return;
      handleClientMessage(table, guest, msg, (out) => conn.send(out));
    });
    const drop = () => {
      if (!table || !guest.playerId) return;
      table.leave(guest.playerId);
      table.broadcast();
      table.pump();
    };
    conn.on("close", drop);
    conn.on("error", drop);
  }

  claimId(1);

  return {
    send(message) {
      if (!table) return;
      handleClientMessage(table, session, message, (out) => handlers.onMessage(out));
    },
    close() {
      closed = true;
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
  let conn = null;
  const peer = new Peer(peerOptions());

  const giveUp = setTimeout(() => {
    if (closed) return;
    peer.destroy();
    fatal(handlers, UNREACHABLE);
  }, OPEN_TIMEOUT);

  peer.on("open", () => {
    if (closed) return;
    conn = peer.connect(peerId(code), { reliable: true });

    conn.on("open", () => {
      clearTimeout(giveUp);
      if (!closed) handlers.onOpen();
    });
    conn.on("data", (msg) => {
      if (!closed && msg && typeof msg === "object") handlers.onMessage(msg);
    });
    conn.on("close", () => {
      if (!closed) fatal(handlers, "l'host ha chiuso la stanza");
    });
    conn.on("error", () => {
      if (!closed) fatal(handlers, "connessione con l'host interrotta");
    });
  });

  peer.on("error", (err) => {
    clearTimeout(giveUp);
    if (closed) return;
    if (err.type === "peer-unavailable") {
      fatal(handlers, `nessuna stanza aperta con il codice ${code}`);
      return;
    }
    fatal(handlers, brokerError(err));
  });

  return {
    send(message) {
      if (conn && conn.open) conn.send(message);
    },
    close() {
      closed = true;
      clearTimeout(giveUp);
      if (conn) conn.close();
      peer.destroy();
    },
  };
}

function brokerError(err) {
  if (err.type === "browser-incompatible") return "questo browser non supporta WebRTC";
  if (err.type === "network" || err.type === "server-error" || err.type === "socket-error") {
    return "non riesco a raggiungere il servizio che mette in contatto i browser";
  }
  return err.message || "errore di connessione";
}

/* ------------------------------------------------------------------------- */

window.TRANS_TRANSPORT = {
  create(handlers) {
    if (typeof Peer === "undefined") {
      setTimeout(() => fatal(handlers, "libreria di connessione non caricata"), 0);
      return { send() {}, close() {} };
    }
    return handlers.room ? joinAsGuest(handlers) : hostTable(handlers);
  },
};
