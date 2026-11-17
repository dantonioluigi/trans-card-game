/* Limiti dell'host peer-to-peer, e compressione degli stati.
 *
 * Chi apre la stanza e' l'arbitro, e gli altri sono connessioni aperte sul suo
 * browser: qualunque cosa mandino, la paga la sua pagina. Un'intenzione vera
 * (una dichiarazione, una carta, una riga di chat) e' di poche decine di byte e
 * arriva al ritmo di una persona; quello che esce da questi limiti non e' una
 * partita.
 */

export const MAX_GUESTS = 12;            // connessioni aperte insieme; i posti sono 7
export const MAX_MESSAGE_CHARS = 2048;   // un messaggio dell'ospite, in JSON
export const RATE_BURST = 30;            // messaggi di colpo...
export const RATE_PER_SECOND = 8;        // ...e poi al secondo
export const MAX_PENDING = 60;           // stati in coda verso chi legge piano
export const MAX_PACKED = 256 * 1024;    // uno stato compresso
export const MAX_UNPACKED = 1024 * 1024; // e decompresso

/** Un secchiello di gettoni: lascia passare una raffica, poi un ritmo costante. */
export class TokenBucket {
  constructor(capacity, perSecond, now = Date.now()) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.tokens = capacity;
    this.stamp = now;
  }

  take(now = Date.now()) {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.stamp) / 1000) * this.perSecond);
    this.stamp = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Il messaggio sta dentro il tetto? Un valore che non si serializza non ci sta. */
export function smallEnough(message, max = MAX_MESSAGE_CHARS) {
  try {
    const json = JSON.stringify(message);
    return typeof json === "string" && json.length <= max;
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------------------ compressione */

// Ogni stato del tavolo viaggia intero, e compresso pesa circa un quarto. Solo
// host → ospite: e' li' che passa il grosso, le intenzioni sono poche decine di
// byte. Chi la supporta lo dichiara nel join, e l'host comprime solo per lui:
// cosi' codice vecchio e nuovo si parlano anche a meta' pubblicazione.
export const CAN_COMPRESS = (() => {
  try {
    new CompressionStream("deflate-raw");
    new DecompressionStream("deflate-raw");
    return true;
  } catch (_) {
    return false;
  }
})();

export async function pack(message) {
  const stream = new Blob([JSON.stringify(message)])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Response(stream).arrayBuffer();
}

/**
 * Decomprime con un tetto. Pochi KB di deflate possono diventare gigabyte: senza
 * tetto, un host malevolo manderebbe in esaurimento la scheda dell'ospite.
 */
export async function unpack(bytes, maxPacked = MAX_PACKED, maxUnpacked = MAX_UNPACKED) {
  const size = bytes && typeof bytes.byteLength === "number" ? bytes.byteLength : 0;
  if (!size || size > maxPacked) throw new Error("stato compresso troppo grande");
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxUnpacked) {
      await reader.cancel();
      throw new Error("stato decompresso troppo grande");
    }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(all));
}
