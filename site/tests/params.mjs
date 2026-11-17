/* I parametri di prova nell'indirizzo si leggono solo su un server locale.
 *
 *   node site/tests/params.mjs
 */

import { isDevServer, trustedQuery } from "../js/params.js";

let checks = 0;
const failures = [];
function check(condition, message) {
  checks++;
  if (!condition) failures.push(message);
}

const at = (hostname, port, search) => ({ hostname, port, search });

// Pagina pubblicata: un link con ?broker= non deve cambiare il broker.
for (const search of ["?broker=https://evil.example", "?ice=[]", "?turn=https://evil.example", "?relay=1"]) {
  const q = trustedQuery(at("dantonioluigi.github.io", "", search));
  check([...q.keys()].length === 0, `su una pagina pubblica ho letto ${search}`);
}

// App Android: https://localhost, senza porta.
check(!isDevServer(at("localhost", "", "")), "l'app (localhost senza porta) non e' un server di sviluppo");
check([...trustedQuery(at("localhost", "", "?broker=https://evil.example")).keys()].length === 0,
      "nell'app un parametro ?broker= e' stato letto");

// Nomi che somigliano a localhost.
for (const host of ["localhost.evil.example", "evil-localhost", "127.0.0.1.evil.example", "0.0.0.0"]) {
  check(!isDevServer(at(host, "8000", "")), `${host}:8000 scambiato per un server locale`);
}

// Sviluppo: server locale con porta.
for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
  const q = trustedQuery(at(host, "8000", "?broker=http://localhost:9000&relay=1"));
  check(q.get("broker") === "http://localhost:9000" && q.get("relay") === "1",
        `in sviluppo (${host}:8000) i parametri non si leggono`);
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} problemi su ${checks} controlli:\n`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`✓ parametri di prova — ${checks} controlli superati`);
