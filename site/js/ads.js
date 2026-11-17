/* Pubblicita' dell'app Android (Google AdMob). Solo nella build --app: il sito
 * web non carica questo file.
 *
 * Regole che questo modulo fa rispettare:
 *   - prima il consenso (UMP), poi l'SDK: senza consenso non parte nessuna richiesta;
 *   - mai durante una partita e mai subito dopo un tocco su un pulsante;
 *   - l'interstitial solo alla fine di una partita, a schermata dei punteggi
 *     gia' visibile, mai alla prima partita e non piu' di uno ogni 5 minuti;
 *   - l'App Open solo all'avvio a freddo, prima di qualunque tocco, mai al
 *     primo avvio in assoluto;
 *   - un errore dell'SDK non deve mai fermare il gioco: qui dentro tutto e'
 *     in try/catch e nessuna funzione pubblica rifiuta.
 *
 * Parla col plugin nativo attraverso il bridge di Capacitor
 * (Capacitor.nativePromise / Capacitor.addListener), che la WebView ha gia':
 * niente JavaScript del plugin da caricare.
 */

const PLUGIN = "AdMob";
const UNIT_RE = /^ca-app-pub-\d{16}\/\d{10}$/;

export const TIMING = Object.freeze({
  gap: 5 * 60 * 1000,        // fra due annunci a schermo intero
  delay: 2500,               // dopo la fine partita, per far vedere i punteggi
  openWait: 4000,            // quanto si aspetta l'App Open all'avvio
  openWindow: 12000,         // oltre questo tempo dall'avvio non si mostra piu'
  callTimeout: 15000,        // una chiamata nativa che non risponde
  retry: 60000,              // nuovo tentativo di caricare un interstitial
  retries: 3,
  stuck: 120000,             // un annuncio "ancora aperto" dopo tanto e' un errore
});

/**
 * @param {object} deps
 * @param {object} deps.cap        window.Capacitor (nativePromise, addListener)
 * @param {{interstitial?: string, appOpen?: string}} deps.ids
 * @param {{get(k: string): string|null, set(k: string, v: string): void}} deps.store
 * @param {() => boolean} [deps.visible]   la pagina e' in primo piano
 * @param {() => boolean} [deps.touched]   l'utente ha gia' toccato qualcosa
 * @param {{show(): void, onClick(fn: () => void): void}} [deps.privacyButton]
 */
export function createAds({
  cap,
  ids = {},
  store,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  visible = () => true,
  touched = () => false,
  privacyButton = null,
  timing = TIMING,
  log = () => {},
}) {
  const bridge = cap && typeof cap.nativePromise === "function" && typeof cap.addListener === "function";
  const unit = {
    interstitial: UNIT_RE.test(ids.interstitial || "") ? ids.interstitial : "",
    appOpen: UNIT_RE.test(ids.appOpen || "") ? ids.appOpen : "",
  };

  const t0 = now();
  let started = false;
  let canAds = false;
  let initialised = false;
  let interReady = false;
  let preparing = false;
  let failures = 0;
  let showingSince = 0;
  let lastShown = Number(read("last")) || 0;

  /* ------------------------------------------------------------- il bridge */

  function call(method, options = {}) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${method}: nessuna risposta`)), timing.callTimeout);
    });
    const attempt = Promise.resolve().then(() => cap.nativePromise(PLUGIN, method, options));
    return Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
  }

  function read(key) {
    try { return store.get(key); } catch { return null; }
  }

  function remember(key, value) {
    try { store.set(key, String(value)); } catch { /* memoria piena o negata */ }
  }

  /* ------------------------------------------------------------- consenso */

  function applyConsent(info) {
    canAds = !!info && info.canRequestAds === true;
    if (info && info.privacyOptionsRequirementStatus === "REQUIRED" && privacyButton) {
      privacyButton.show();
    }
  }

  async function initialise() {
    if (initialised || !canAds) return;
    await call("initialize");
    initialised = true;
    cap.addListener(PLUGIN, "interstitialAdDismissed", () => {
      showingSince = 0;
      prepare();
    });
  }

  /** Il pulsante "scelte sulla pubblicita'": ripropone il modulo di Google. */
  async function privacyOptions() {
    try {
      await call("showPrivacyOptionsForm");
      applyConsent(await call("requestConsentInfo"));
      await initialise(); // non fa niente senza consenso
      prepare();          // idem
    } catch (err) {
      log("opzioni privacy", err);
    }
  }

  /* ----------------------------------------------------------- interstitial */

  async function prepare() {
    if (!initialised || !canAds || !unit.interstitial || preparing || interReady) return;
    preparing = true;
    try {
      await call("prepareInterstitial", { adId: unit.interstitial });
      interReady = true;
      failures = 0;
    } catch (err) {
      interReady = false;
      log("interstitial non caricato", err);
      // Senza annunci disponibili (rete assente, nessun inserzionista) si riprova
      // poche volte, a distanza: niente raffica di richieste a vuoto.
      if (++failures <= timing.retries) setTimeout(prepare, timing.retry);
    } finally {
      preparing = false;
    }
  }

  function farEnough() {
    const since = now() - lastShown;
    return since >= timing.gap || since < 0; // orologio spostato indietro: non blocca per sempre
  }

  /**
   * Chiamata quando compare la schermata dei punteggi finali.
   * @param {() => boolean} stillThere   vero finche' la schermata e' ancora li'
   */
  async function gameOver(stillThere = () => true) {
    try {
      const games = (Number(read("games")) || 0) + 1;
      remember("games", games);
      if (!unit.interstitial) return;
      if (!interReady) { failures = 0; prepare(); }
      if (games < 2) return; // la prima partita dell'installazione e' senza pubblicita'

      await sleep(timing.delay);

      const stuck = showingSince && now() - showingSince > timing.stuck;
      if (
        !initialised || !canAds || !interReady || (showingSince && !stuck) ||
        !stillThere() || !visible() || !farEnough()
      ) return;

      showingSince = now();
      interReady = false;
      try {
        await call("showInterstitial", { adId: unit.interstitial });
        lastShown = now();
        remember("last", lastShown);
      } catch (err) {
        showingSince = 0;
        log("interstitial non mostrato", err);
        prepare();
      }
    } catch (err) {
      log("fine partita", err);
    }
  }

  /* --------------------------------------------------------------- App Open */

  async function coldStartAppOpen(firstEver) {
    if (!unit.appOpen || firstEver) return;
    const loaded = await Promise.race([
      call("loadAppOpen", { adId: unit.appOpen }).then(() => true),
      sleep(timing.openWait).then(() => false),
    ]);
    if (!loaded || !canAds || !visible() || touched()) return;
    if (now() - t0 > timing.openWindow) return;
    await call("showAppOpen", { adId: unit.appOpen }); // risolve quando l'utente lo chiude
    lastShown = now();
    remember("last", lastShown);
  }

  /* ------------------------------------------------------------------ avvio */

  async function start() {
    if (started || !bridge) return;
    started = true;
    if (privacyButton) privacyButton.onClick(privacyOptions);
    const firstEver = read("seen") !== "1";
    remember("seen", "1");
    try {
      let info = await call("requestConsentInfo");
      if (info.isConsentFormAvailable && info.status === "REQUIRED") {
        info = await call("showConsentForm");
      }
      applyConsent(info);
      if (!canAds) return;
      await initialise();
      prepare();
      await coldStartAppOpen(firstEver);
    } catch (err) {
      log("avvio pubblicita'", err);
    }
  }

  return { start, gameOver, privacyOptions };
}

/* ---------------------------------------------------- collegamento alla pagina */

function localStore() {
  const key = (k) => "trans.ads." + k;
  return {
    get(k) { try { return localStorage.getItem(key(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(key(k), v); } catch { /* modalita' privata */ } },
  };
}

function wirePrivacyButton() {
  const el = document.getElementById("btnAdsPrivacy");
  if (!el) return null;
  return {
    show() { el.hidden = false; },
    onClick(fn) { el.onclick = fn; },
  };
}

if (typeof window !== "undefined" && window.TRANS_ADS_IDS && window.Capacitor) {
  let touched = false;
  document.addEventListener("pointerdown", () => { touched = true; }, { capture: true, once: true });

  const ads = createAds({
    cap: window.Capacitor,
    ids: window.TRANS_ADS_IDS,
    store: localStore(),
    visible: () => document.visibilityState === "visible",
    touched: () => touched,
    privacyButton: wirePrivacyButton(),
  });
  window.TRANS_ADS = ads;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => ads.start());
  else ads.start();
}
