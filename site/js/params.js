/* Parametri di prova nell'indirizzo: ?broker=, ?turn=, ?ice=, ?relay=.
 *
 * Servono a chi sviluppa. In produzione sarebbero una porta aperta: chiunque
 * puo' costruire un link con ?broker=https://sito-suo#ABCD e portare chi lo apre
 * su un falso tavolo, dove l'host controlla tutto quello che l'ospite vede.
 * Quindi si leggono solo su un server locale con una porta (python -m
 * http.server, uvicorn); non su una pagina pubblicata e non nell'app Android,
 * dove l'indirizzo e' https://localhost senza porta.
 *
 * Un broker proprio, in produzione, si imposta in pubblicazione (TRANS_BROKER).
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isDevServer(loc) {
  return LOCAL_HOSTS.has(loc.hostname) && loc.port !== "";
}

export function trustedQuery(loc) {
  return new URLSearchParams(isDevServer(loc) ? loc.search : "");
}
