/* I limiti dell'host peer-to-peer e il tetto alla decompressione.
 *
 *   node site/tests/limits.mjs
 */

import { CAN_COMPRESS, MAX_UNPACKED, TokenBucket, pack, smallEnough, unpack } from "../js/limits.js";

let checks = 0;
const failures = [];
function check(condition, message) {
  checks++;
  if (!condition) failures.push(message);
}
async function rejects(promise) {
  try {
    await promise;
    return false;
  } catch (_) {
    return true;
  }
}

/* ------------------------------------------------------------- frequenza */

{
  const t0 = 1_000_000;
  const bucket = new TokenBucket(30, 8, t0);
  let passed = 0;
  for (let i = 0; i < 100; i++) if (bucket.take(t0)) passed++;
  check(passed === 30, `una raffica ha fatto passare ${passed} messaggi invece di 30`);
  check(!bucket.take(t0 + 50), "dopo la raffica un messaggio dopo 50ms e' passato");
  let afterSecond = 0;
  for (let i = 0; i < 20; i++) if (bucket.take(t0 + 1000)) afterSecond++;
  check(afterSecond === 8, `dopo un secondo dovevano tornare 8 gettoni, sono tornati ${afterSecond}`);
  // A riposo il secchiello non accumula oltre la capienza.
  let rested = 0;
  for (let i = 0; i < 100; i++) if (bucket.take(t0 + 3_600_000)) rested++;
  check(rested === 30, `dopo un'ora di riposo sono passati ${rested} messaggi invece di 30`);

  // Una persona che gioca (un messaggio ogni mezzo secondo) non incontra mai il limite.
  const person = new TokenBucket(30, 8, t0);
  let blocked = 0;
  for (let i = 0; i < 2000; i++) if (!person.take(t0 + i * 500)) blocked++;
  check(blocked === 0, `una persona e' stata bloccata ${blocked} volte`);
}

/* -------------------------------------------------------------- dimensioni */

{
  check(smallEnough({ type: "chat", text: "ciao" }), "un messaggio normale e' stato rifiutato");
  check(!smallEnough({ type: "chat", text: "x".repeat(5000) }), "un messaggio da 5000 caratteri e' passato");
  const cyclic = {};
  cyclic.self = cyclic;
  check(!smallEnough(cyclic), "un oggetto ciclico e' passato");
  check(!smallEnough(undefined), "undefined e' passato");
  check(!smallEnough(10n), "un BigInt (non serializzabile) e' passato");
  let deep = {};
  for (let i = 0; i < 400; i++) deep = { a: deep, pad: "x".repeat(10) };
  check(!smallEnough(deep), "un oggetto annidato e lungo e' passato");
}

/* ------------------------------------------------------------ decompressione */

{
  check(CAN_COMPRESS === true, "in questo ambiente la compressione dovrebbe esserci");

  const state = { type: "state", screen: "game", log: Array.from({ length: 200 }, (_, i) => `riga ${i}`) };
  const back = await unpack(await pack(state));
  check(JSON.stringify(back) === JSON.stringify(state), "uno stato normale non torna uguale");

  // Una bomba: 50 MB di zeri diventano poche decine di KB compressi.
  const bomb = await new Response(
    new Blob([new Uint8Array(50 * 1024 * 1024)]).stream().pipeThrough(new CompressionStream("deflate-raw"))
  ).arrayBuffer();
  check(bomb.byteLength < 256 * 1024, `la bomba di prova pesa ${bomb.byteLength} byte: non e' piu' una bomba`);
  const before = process.memoryUsage().rss;
  check(await rejects(unpack(bomb)), "la bomba di decompressione e' stata accettata");
  const grown = process.memoryUsage().rss - before;
  check(grown < 200 * 1024 * 1024, `la bomba ha fatto crescere la memoria di ${Math.round(grown / 1e6)} MB`);

  check(await rejects(unpack(new Uint8Array(0))), "un buffer vuoto e' stato accettato");
  check(await rejects(unpack(undefined)), "undefined e' stato accettato");
  check(await rejects(unpack({ not: "binary" })), "un oggetto non binario e' stato accettato");
  check(await rejects(unpack(new Uint8Array(300 * 1024).fill(7))), "un buffer compresso troppo grande e' stato accettato");
  check(await rejects(unpack(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))), "byte a caso sono stati accettati come stato");
  check(MAX_UNPACKED === 1024 * 1024, "il tetto di decompressione non e' piu' 1 MiB: aggiornare anche la documentazione");
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} problemi su ${checks} controlli:\n`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`✓ limiti dell'host e decompressione — ${checks} controlli superati`);
