/* Le regole sulla pubblicita': cosa si chiede al plugin, in che ordine e quando
 * NON si mostra niente. Il plugin nativo e' finto: registra le chiamate.
 *
 *   node site/tests/ads.mjs
 */

import { createAds, TIMING } from "../js/ads.js";

let checks = 0;
const failures = [];
function check(condition, message) {
  checks++;
  if (!condition) failures.push(message);
}

const REAL_INTERSTITIAL = "ca-app-pub-1234567890123456/1234567890";
const REAL_APP_OPEN = "ca-app-pub-1234567890123456/0987654321";
const IDS = { interstitial: REAL_INTERSTITIAL, appOpen: REAL_APP_OPEN };
// Negli scenari sugli interstitial l'App Open e' spento: da solo conterebbe come annuncio gia' visto.
const INTER_ONLY = { interstitial: REAL_INTERSTITIAL };

const TIME = { ...TIMING, gap: 1000, delay: 7, openWait: 30, openWindow: 5000, callTimeout: 60, retry: 5, retries: 2, stuck: 10000 };

const NOT_REQUIRED = { status: "NOT_REQUIRED", isConsentFormAvailable: false, canRequestAds: true, privacyOptionsRequirementStatus: "NOT_REQUIRED" };
const REQUIRED_FORM = { status: "REQUIRED", isConsentFormAvailable: true, canRequestAds: false, privacyOptionsRequirementStatus: "REQUIRED" };
const OBTAINED = { status: "OBTAINED", canRequestAds: true, privacyOptionsRequirementStatus: "REQUIRED" };
const REFUSED = { status: "OBTAINED", canRequestAds: false, privacyOptionsRequirementStatus: "REQUIRED" };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup({ responses = {}, store = {}, ids = IDS, visible = true, touched = false, privacy = true } = {}) {
  const calls = [];
  const listeners = new Map();
  const defaults = {
    requestConsentInfo: NOT_REQUIRED,
    showConsentForm: OBTAINED,
    initialize: {},
    prepareInterstitial: { adUnitId: "x" },
    showInterstitial: {},
    loadAppOpen: { adUnitId: "x" },
    showAppOpen: {},
    showPrivacyOptionsForm: {},
  };
  const cap = {
    nativePromise: async (plugin, method, options) => {
      calls.push({ plugin, method, options });
      const handler = method in responses ? responses[method] : defaults[method];
      return typeof handler === "function" ? handler(options) : handler;
    },
    addListener: (plugin, event, callback) => {
      listeners.set(event, callback);
      return { remove() {} };
    },
  };

  const data = new Map(Object.entries(store));
  const memory = { get: (k) => (data.has(k) ? data.get(k) : null), set: (k, v) => data.set(k, v) };
  const clock = { t: 1_000_000 };
  const sleeps = [];
  const button = { shown: false, click: null };
  const state = { visible, touched };

  const ads = createAds({
    cap,
    ids,
    store: memory,
    now: () => clock.t,
    sleep: (ms) => { sleeps.push(ms); return wait(ms); },
    visible: () => state.visible,
    touched: () => state.touched,
    privacyButton: privacy ? { show() { button.shown = true; }, onClick(fn) { button.click = fn; } } : null,
    timing: TIME,
  });

  const methods = () => calls.map((c) => c.method);
  const count = (m) => calls.filter((c) => c.method === m).length;
  return { ads, calls, methods, count, listeners, data, clock, sleeps, button, state };
}

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

/* ------------------------------------------------------------------ consenso */

scenario("consenso: prima il modulo, poi l'SDK, poi gli annunci", async () => {
  const t = setup({ responses: { requestConsentInfo: REQUIRED_FORM }, store: { seen: "1" } });
  await t.ads.start();
  const m = t.methods();
  check(m.slice(0, 4).join() === "requestConsentInfo,showConsentForm,initialize,prepareInterstitial",
        `ordine delle chiamate sbagliato: ${m.join()}`);
  check(m.indexOf("initialize") > m.indexOf("showConsentForm"), "SDK inizializzato prima del consenso");
});

scenario("consenso: fuori dallo spazio europeo il modulo non si mostra", async () => {
  const t = setup();
  await t.ads.start();
  check(t.count("showConsentForm") === 0, "modulo mostrato senza che servisse");
  check(t.count("initialize") === 1, "SDK non inizializzato");
});

scenario("consenso: modulo disponibile ma non richiesto -> nessun modulo", async () => {
  const t = setup({ responses: { requestConsentInfo: { ...REQUIRED_FORM, status: "OBTAINED", canRequestAds: true } } });
  await t.ads.start();
  check(t.count("showConsentForm") === 0, "mostrato un modulo gia' compilato");
});

scenario("consenso negato: nessuna richiesta di annunci, ma il pulsante delle scelte compare", async () => {
  const t = setup({ responses: { requestConsentInfo: REQUIRED_FORM, showConsentForm: REFUSED }, store: { seen: "1", games: "5" } });
  await t.ads.start();
  await t.ads.gameOver();
  const forbidden = ["initialize", "prepareInterstitial", "showInterstitial", "loadAppOpen", "showAppOpen"];
  check(!t.methods().some((m) => forbidden.includes(m)), `chiamate vietate senza consenso: ${t.methods().join()}`);
  check(t.button.shown, "il pulsante delle scelte sulla pubblicita' non e' comparso");
});

scenario("consenso: se non si riesce a sapere, niente annunci", async () => {
  const t = setup({ responses: { requestConsentInfo: () => { throw new Error("rete assente"); } }, store: { seen: "1", games: "5" } });
  await t.ads.start();
  await t.ads.gameOver();
  check(t.count("initialize") === 0 && t.count("showInterstitial") === 0, "annunci senza sapere il consenso");
});

scenario("il pulsante delle scelte non compare se non e' richiesto", async () => {
  const t = setup();
  await t.ads.start();
  check(!t.button.shown, "pulsante mostrato fuori dallo spazio europeo");
});

/* ------------------------------------------------------------------ App Open */

scenario("App Open: mai al primo avvio assoluto", async () => {
  const t = setup();
  await t.ads.start();
  check(t.count("loadAppOpen") === 0 && t.count("showAppOpen") === 0, "App Open al primo avvio");
  check(t.data.get("seen") === "1", "il primo avvio non e' stato ricordato");
});

scenario("App Open: dal secondo avvio si carica e si mostra", async () => {
  const t = setup({ store: { seen: "1" } });
  await t.ads.start();
  check(t.count("loadAppOpen") === 1 && t.count("showAppOpen") === 1, `chiamate: ${t.methods().join()}`);
  const show = t.calls.find((c) => c.method === "showAppOpen");
  check(show.options.adId === REAL_APP_OPEN, "App Open con l'id sbagliato");
});

scenario("App Open: se si carica troppo piano, si salta", async () => {
  const t = setup({ store: { seen: "1" }, responses: { loadAppOpen: () => wait(200).then(() => ({})) } });
  await t.ads.start();
  check(t.count("showAppOpen") === 0, "App Open mostrato dopo l'attesa massima");
});

scenario("App Open: non dopo un tocco, non in background, non fuori finestra", async () => {
  const touched = setup({ store: { seen: "1" }, touched: true });
  await touched.ads.start();
  check(touched.count("showAppOpen") === 0, "App Open dopo un tocco");

  const hidden = setup({ store: { seen: "1" }, visible: false });
  await hidden.ads.start();
  check(hidden.count("showAppOpen") === 0, "App Open con la pagina in background");

});

scenario("App Open: se il consenso ha preso troppo tempo, l'utente e' gia' nel gioco", async () => {
  let clock;
  const t = setup({
    store: { seen: "1" },
    responses: {
      requestConsentInfo: REQUIRED_FORM,
      showConsentForm: async () => { clock.t += 6000; return OBTAINED; },
    },
  });
  clock = t.clock;
  await t.ads.start();
  check(t.count("showAppOpen") === 0, "App Open mostrato fuori dalla finestra d'avvio");
});

/* -------------------------------------------------------------- interstitial */

scenario("interstitial: mai alla prima partita dell'installazione", async () => {
  const t = setup({ ids: INTER_ONLY, store: { seen: "1" } });
  await t.ads.start();
  await t.ads.gameOver();
  check(t.count("showInterstitial") === 0, "annuncio alla prima partita");
  check(t.data.get("games") === "1", "partita non contata");
});

scenario("interstitial: dalla seconda partita, dopo il ritardo, una volta", async () => {
  const t = setup({ ids: INTER_ONLY, store: { seen: "1", games: "1" } });
  await t.ads.start();
  t.sleeps.length = 0;
  await t.ads.gameOver();
  check(t.count("showInterstitial") === 1, `annunci mostrati: ${t.count("showInterstitial")}`);
  check(t.sleeps.includes(TIME.delay), "nessuna attesa prima di mostrare l'annuncio");
  const show = t.calls.find((c) => c.method === "showInterstitial");
  check(show.options.adId === REAL_INTERSTITIAL, "interstitial con l'id sbagliato");
});

scenario("interstitial: non se l'utente ha gia' lasciato la schermata finale", async () => {
  const t = setup({ ids: INTER_ONLY, store: { seen: "1", games: "3" } });
  await t.ads.start();
  await t.ads.gameOver(() => false);
  check(t.count("showInterstitial") === 0, "annuncio dopo che l'utente aveva premuto un pulsante");
});

scenario("interstitial: non in background", async () => {
  const t = setup({ ids: INTER_ONLY, store: { seen: "1", games: "3" } });
  await t.ads.start();
  t.state.visible = false;
  await t.ads.gameOver();
  check(t.count("showInterstitial") === 0, "annuncio con l'app in background");
});

scenario("interstitial: al massimo uno ogni 5 minuti, e il tempo si conta dopo l'annuncio", async () => {
  const t = setup({ ids: INTER_ONLY, store: { seen: "1", games: "3" } });
  await t.ads.start();
  await t.ads.gameOver();
  t.listeners.get("interstitialAdDismissed")();   // l'utente lo chiude: se ne prepara un altro
  await wait(10);
  await t.ads.gameOver();
  check(t.count("showInterstitial") === 1, "secondo annuncio dentro l'intervallo minimo");
  t.clock.t += TIME.gap;
  await t.ads.gameOver();
  check(t.count("showInterstitial") === 2, "nessun annuncio passato l'intervallo");
});

scenario("interstitial: l'intervallo vale anche dopo un riavvio dell'app", async () => {
  const first = setup({ ids: INTER_ONLY, store: { seen: "1", games: "3" } });
  await first.ads.start();
  await first.ads.gameOver();
  check(first.count("showInterstitial") === 1, "preparazione: l'annuncio non e' uscito");

  const second = setup({ ids: INTER_ONLY, store: Object.fromEntries(first.data), });
  second.clock.t = first.clock.t + 1;
  await second.ads.start();
  await second.ads.gameOver();
  check(second.count("showInterstitial") === 0, "dopo il riavvio l'intervallo e' stato dimenticato");
});

scenario("interstitial: un App Open appena visto vale come annuncio", async () => {
  const t = setup({ store: { seen: "1", games: "3" } });
  await t.ads.start();
  check(t.count("showAppOpen") === 1, "preparazione: l'App Open non e' uscito");
  await t.ads.gameOver();
  check(t.count("showInterstitial") === 0, "interstitial subito dopo un App Open");
});

scenario("interstitial: due fine-partita di fila non ne mostrano due", async () => {
  const t = setup({ ids: INTER_ONLY, store: { seen: "1", games: "3" }, responses: { loadAppOpen: () => { throw new Error("niente"); } } });
  await t.ads.start();
  await Promise.all([t.ads.gameOver(), t.ads.gameOver()]);
  check(t.count("showInterstitial") === 1, `annunci: ${t.count("showInterstitial")}`);
});

scenario("interstitial: se non si carica, niente annuncio", async () => {
  const t = setup({
    ids: INTER_ONLY,
    store: { seen: "1", games: "3" },
    responses: { prepareInterstitial: () => { throw new Error("nessun inserzionista"); } },
  });
  await t.ads.start();
  await t.ads.gameOver();
  check(t.count("showInterstitial") === 0, "annuncio mostrato senza averlo caricato");
});

scenario("interstitial: dopo un caricamento fallito si riprova da solo, e poi si mostra", async () => {
  let attempts = 0;
  const t = setup({
    ids: INTER_ONLY,
    store: { seen: "1", games: "3" },
    responses: { prepareInterstitial: () => { if (++attempts === 1) throw new Error("nessun inserzionista"); return {}; } },
  });
  await t.ads.start();
  await wait(40); // il nuovo tentativo parte da solo, a distanza
  check(attempts === 2, `tentativi di caricamento: ${attempts}`);
  await t.ads.gameOver();
  check(t.count("showInterstitial") === 1, "dopo il nuovo tentativo l'annuncio non e' uscito");
});

scenario("interstitial: i tentativi a vuoto sono pochi", async () => {
  const t = setup({
    ids: INTER_ONLY,
    store: { seen: "1" },
    responses: { loadAppOpen: () => { throw new Error("x"); }, prepareInterstitial: () => { throw new Error("vuoto"); } },
  });
  await t.ads.start();
  await wait(60);
  check(t.count("prepareInterstitial") <= 1 + TIME.retries, `richieste a vuoto: ${t.count("prepareInterstitial")}`);
});

scenario("interstitial: un errore nel mostrarlo non rompe niente", async () => {
  const t = setup({
    ids: INTER_ONLY,
    store: { seen: "1", games: "3" },
    responses: { loadAppOpen: () => { throw new Error("x"); }, showInterstitial: () => { throw new Error("attivita' assente"); } },
  });
  await t.ads.start();
  let thrown = null;
  try { await t.ads.gameOver(); } catch (err) { thrown = err; }
  check(thrown === null, "gameOver ha rifiutato");
  check(t.count("prepareInterstitial") >= 2, "dopo l'errore non se ne prepara un altro");
});

scenario("interstitial: id non validi -> nessuna richiesta di quel formato", async () => {
  const t = setup({ ids: INTER_ONLY, store: { seen: "1", games: "3" }, ids: { interstitial: "ca-app-pub-1/2", appOpen: "<script>" } });
  await t.ads.start();
  await t.ads.gameOver();
  const used = t.methods().filter((m) => /Interstitial|AppOpen/.test(m));
  check(used.length === 0, `richieste con id non validi: ${used.join()}`);
});

/* ------------------------------------------------------ scelte sulla pubblicita' */

scenario("scelte: il pulsante ripropone il modulo e rilegge il consenso", async () => {
  const t = setup({ responses: { requestConsentInfo: REQUIRED_FORM, showConsentForm: OBTAINED }, store: { seen: "1", games: "3" } });
  await t.ads.start();
  check(t.button.shown && typeof t.button.click === "function", "pulsante non collegato");
  const before = t.count("requestConsentInfo");
  await t.button.click();
  check(t.count("showPrivacyOptionsForm") === 1, "modulo delle scelte non mostrato");
  check(t.count("requestConsentInfo") === before + 1, "consenso non riletto");
});

scenario("scelte: se l'utente revoca, gli annunci si fermano", async () => {
  let consent = REQUIRED_FORM;
  const t = setup({
    responses: { requestConsentInfo: () => consent, showConsentForm: OBTAINED, loadAppOpen: () => { throw new Error("x"); } },
    store: { seen: "1", games: "3" },
  });
  await t.ads.start();
  consent = REFUSED;
  await t.button.click();
  await t.ads.gameOver();
  check(t.count("showInterstitial") === 0, "annuncio dopo la revoca del consenso");
});

scenario("scelte: se l'utente acconsente piu' tardi, l'SDK parte allora", async () => {
  let consent = { ...REQUIRED_FORM, canRequestAds: false };
  const t = setup({
    responses: { requestConsentInfo: () => consent, showConsentForm: REFUSED },
    store: { seen: "1", games: "3" },
  });
  await t.ads.start();
  check(t.count("initialize") === 0, "SDK avviato senza consenso");
  consent = { ...OBTAINED };
  await t.button.click();
  check(t.count("initialize") === 1, "SDK non avviato dopo il consenso");
});

/* ------------------------------------------------------------------ robustezza */

scenario("senza bridge nativo il modulo non fa niente e non rompe niente", async () => {
  for (const cap of [undefined, {}, { nativePromise: () => {} }]) {
    const ads = createAds({ cap, ids: IDS, store: { get: () => null, set() {} }, timing: TIME });
    await ads.start();
    await ads.gameOver();
    await ads.privacyOptions();
  }
  check(true, "");
});

scenario("un bridge che lancia subito non rompe l'avvio", async () => {
  const cap = { nativePromise: () => { throw new Error("bridge rotto"); }, addListener() {} };
  const store = new Map();
  const ads = createAds({ cap, ids: IDS, store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v) }, timing: TIME });
  await ads.start();
  await ads.gameOver();
  check(true, "");
});

scenario("una chiamata nativa che non risponde mai non blocca l'avvio", async () => {
  const t = setup({ responses: { requestConsentInfo: () => new Promise(() => {}) } });
  const started = Date.now();
  await t.ads.start();
  check(Date.now() - started < 1000, "start ha aspettato troppo");
});

scenario("la memoria del dispositivo che non funziona non rompe niente", async () => {
  const broken = { get() { throw new Error("negato"); }, set() { throw new Error("negato"); } };
  const calls = [];
  const bridge = { nativePromise: async (_p, m) => { calls.push(m); return NOT_REQUIRED; }, addListener() {} };
  let thrown = null;
  try {
    const ads = createAds({ cap: bridge, ids: IDS, store: broken, timing: TIME });
    await ads.start();
    await ads.gameOver();
  } catch (err) {
    thrown = err;
  }
  check(thrown === null, "una memoria che lancia ha rotto il modulo");
});

/* ------------------------------------------------------------------------- */

for (const { name, fn } of scenarios) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: eccezione ${err && err.stack ? err.stack.split("\n").slice(0, 2).join(" ") : err}`);
  }
}

if (failures.length) {
  console.error(`FALLITI ${failures.length} controlli su ${checks}:`);
  for (const message of failures) console.error("  - " + message);
  process.exit(1);
}
console.log(`ads: ${checks} controlli ok`);
