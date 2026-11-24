/* Dichiaro — lingue (italiano e inglese). Nessuna dipendenza.
 *
 * Tre cose:
 *   1. il dizionario: t("chiave", {parametri}) per il testo che scrive il client;
 *   2. data-i18n / data-i18n-html / data-i18n-attr per il testo scritto in
 *      index.html (l'italiano resta li', e viene letto da li' la prima volta);
 *   3. engine(testo): le frasi che arrivano dai motori (diario, errori, etichette)
 *      sono italiano scritto nel motore, che e' lo stesso in JS e in Python e
 *      non si tocca. Qui si traducono a vista con una tabella di modelli.
 *
 * site/tests/i18n.mjs controlla che ogni chiave abbia le due lingue e che ogni
 * frase dei motori e della rete abbia la sua traduzione.
 */
(function () {
  "use strict";

  const LANGS = ["it", "en"];

  /* --------------------------------------------------------------- dizionario
   * [italiano, inglese]. Con null al posto dell'italiano il testo sta in
   * index.html (o in site/build.py) e si legge da li'. {x} sono parametri; i
   * parametri che finiscono in "Html" sono HTML gia' pronto, gli altri si
   * proteggono prima di entrare in una pagina. */
  const S = {
    /* barra in alto */
    "top.office": ["Modalità ufficio", "Office mode"],
    "top.office_off": ["Vista normale", "Normal view"],
    "top.office_title": [null, "Press Esc twice to turn it on quickly"],
    "top.rules": [null, "Rules"],
    "top.leave": [null, "Leave"],
    "top.lang_title": ["Cambia lingua", "Change language"],

    /* modalità ufficio: testi che non devono dire cosa c'è dentro */
    "office.brand": ["Attività", "Activity"],
    "office.tagline": ["Riepilogo settimanale delle attività del team.", "Weekly team activity summary."],
    "office.title": ["Riepilogo attività", "Activity summary"],

    /* titolo della scheda */
    "title.idle": ["Dichiaro — il gioco di carte", "Dichiaro — the card game"],
    "title.turn": ["▶ Tocca a te · Dichiaro", "▶ Your turn · Dichiaro"],

    /* home */
    "home.tagline": [null, "Declare how many tricks you'll take. Getting it wrong costs."],
    "home.new": [null, "New table"],
    "home.name": [null, "Your name"],
    "home.create": [null, "Create table"],
    "home.create_hint": [null, "You get a 4-letter code to share with the others. You can fill the empty seats with bots."],
    "home.join_title": [null, "Join a table"],
    "home.code": [null, "Table code"],
    "home.join": [null, "Join"],
    "home.p2p_note": [null, "No-server version: games go straight from browser to browser."],
    "home.looking": ["Cerco il tavolo {room}…", "Looking for table {room}…"],
    "home.opening": ["Apro il tavolo…", "Opening the table…"],
    "toast.name": ["Scrivi il tuo nome.", "Enter your name."],
    "toast.code": ["Il codice tavolo ha 4 caratteri.", "The table code has 4 characters."],
    "toast.copied": ["Link copiato: {url}", "Link copied: {url}"],
    "prompt.copy": ["Copia il link:", "Copy the link:"],
    "conn.closed": ["connessione chiusa", "connection closed"],
    "conn.lost": [null, "Connection lost — retrying…"],

    /* avviso di aggiornamento (solo app Android, da Play) */
    "update.title": [null, "An update is available"],
    "update.text": [null, "There's a newer version of Dichiaro. Update it to get the latest fixes and to play with people who already have it."],
    "update.now": [null, "Update"],
    "update.later": [null, "Later"],

    /* sala d'attesa */
    "lobby.table": [null, "Table"],
    "lobby.share": [null, "Share the code, or"],
    "lobby.copy": [null, "copy the invite link"],
    "lobby.add_bot": [null, "Add bot"],
    "lobby.length": [null, "Length"],
    "lobby.start": [null, "Start the game"],
    "lobby.host_note": [null, "The table lives in this tab: if you close it, the game ends for everyone."],
    "lobby.wait_host": ["Aspetta che l'host faccia partire la partita.", "Wait for the host to start the game."],
    "lobby.need": [
      "Servono almeno {n} giocatori: aggiungi un bot o invita qualcuno.",
      "You need at least {n} players: add a bot or invite someone.",
    ],
    "lobby.ready_bots": [
      "{n} giocatori al tavolo. Puoi partire quando vuoi: chi arriva dopo prende il posto di un bot.",
      "{n} players at the table. You can start whenever you like: anyone who arrives later takes a bot's seat.",
    ],
    "lobby.ready_free": [
      "{n} giocatori al tavolo, {free} posti liberi. A partita iniziata si entra solo al posto di un bot.",
      "{n} players at the table, {free} free seats. Once the game has started you can only join in place of a bot.",
    ],
    "level.facile": ["facile", "easy"],
    "level.normale": ["normale", "normal"],
    "level.esperto": ["esperto", "expert"],
    "mode.fast": [null, "Fast · 10 rounds"],
    "mode.long": [null, "Long · 20 rounds"],

    /* barra delle informazioni e posti */
    "chip.table": ["Tavolo {room}", "Table {room}"],
    "chip.trump": ["Briscola {suitHtml}", "Trump {suitHtml}"],
    "chip.no_trump": ["Senza briscola", "No trump"],
    "chip.round": ["Round {n}/{total} · {title}", "Round {n}/{total} · {title}"],
    "tag.bot": ["bot · {level}", "bot · {level}"],
    "tag.you": ["tu", "you"],
    "seat.remove": ["Rimuovi", "Remove"],
    "seat.dealer": ["mazziere", "dealer"],
    "seat.score": ["{score} pt", "{score} pts"],
    "seat.left": ["uscito · gioca un bot · {score} pt", "left · a bot is playing · {score} pts"],
    "seat.cards": [" · {n} carte", " · {n} cards"],
    "bid.tricks": ["{n} prese", "{n} tricks"],
    "center.cards": ["{n} carte", "{n} cards"],
    "center.round": ["Round {n} di {total}", "Round {n} of {total}"],

    /* stato della mano */
    "hand.blind": ["<b>BUIO</b> — dichiara senza guardare le carte.", "<b>BLIND</b> — declare without looking at your cards."],
    "hand.game_over": ["Partita finita.", "Game over."],
    "hand.round_over": ["Round concluso.", "Round over."],
    "hand.waiting": ["In attesa della dichiarazione di <b>{name}</b>.", "Waiting for <b>{name}</b> to declare."],
    "hand.cards_trump": ["Queste sono le tue carte. Briscola {suitHtml}.", "These are your cards. Trump {suitHtml}."],
    "hand.cards_no_trump": [
      "Queste sono le tue carte. <b>Nessuna briscola</b> in questo round.",
      "These are your cards. <b>No trump</b> this round.",
    ],
    "hand.your_turn": ["Tocca a te", "Your turn"],
    "hand.lead": [" Seme di uscita: {suitHtml}.", " Lead suit: {suitHtml}."],
    "hand.you_lead": [" Esci tu: scegli il seme.", " You lead: pick the suit."],
    "hand.plays": ["Gioca <b>{name}</b>.", "<b>{name}</b> to play."],

    /* barra laterale */
    "side.scores": [null, "Score"],
    "side.log": [null, "Log"],
    "chat.placeholder": [null, "Write to the table…"],
    "chat.send": [null, "Send"],

    /* dichiarazione */
    "bid.title": ["Quante prese farai?", "How many tricks will you take?"],
    "bid.title_blind": ["Al buio: quante prese?", "Blind: how many tricks?"],
    "bid.ctx": [
      "Round da {cards} carte. Dichiarate finora: {declared}.",
      "{cards}-card round. Declared so far: {declared}.",
    ],
    "bid.ctx_blind": [
      "{cards} carte coperte. Dichiarate finora: {declared}.",
      "{cards} face-down cards. Declared so far: {declared}.",
    ],
    "bid.missing_one": [" Dopo di te manca 1 giocatore.", " 1 more player to declare after you."],
    "bid.missing": [" Dopo di te mancano {n} giocatori.", " {n} more players to declare after you."],
    "bid.banned": [
      " Chiudi tu il giro: non puoi dire {banned}, la somma farebbe esattamente {cards}.",
      " You close the round: you can't say {banned}, the total would be exactly {cards}.",
    ],
    "bid.banned_title": [
      "Con {value} la somma delle dichiarazioni farebbe esattamente {cards}: non e' permesso.",
      "With {value} the total of the declarations would be exactly {cards}: not allowed.",
    ],
    "bid.confirm": [null, "Confirm"],
    "bid.cancel": [null, "Cancel"],
    "bid.chosen_zero": ["Dichiari <b>nessuna presa</b>?", "Declare <b>no tricks</b>?"],
    "bid.chosen_one": ["Dichiari <b>{n}</b> presa?", "Declare <b>{n}</b> trick?"],
    "bid.chosen": ["Dichiari <b>{n}</b> prese?", "Declare <b>{n}</b> tricks?"],

    /* fine round e fine partita */
    "res.title": ["Round {n} — {title}", "Round {n} — {title}"],
    "res.next": [null, "Next round"],
    "res.hint": [
      "Se nessuno tocca niente, il round successivo parte da solo.",
      "If nobody touches anything, the next round starts by itself.",
    ],
    "tbl.player": ["Giocatore", "Player"],
    "tbl.declared": ["Dichiarate", "Declared"],
    "tbl.tricks": ["Prese", "Tricks"],
    "tbl.round": ["Round", "Round"],
    "tbl.total": ["Totale", "Total"],
    "tbl.points": ["Punti", "Points"],
    "end.title": [null, "Game over"],
    "end.winner": ["Vince {name}", "{name} wins"],
    "end.rematch": [null, "Play again"],
    "end.lobby": [null, "Back to the lobby"],
    "end.wait": ["Aspetta che l'host decida se rigiocare.", "Wait for the host to decide whether to play again."],
    "end.same": [
      "Stessi giocatori e stessa durata, punteggi da zero.",
      "Same players, same length, scores back to zero.",
    ],
    "end.need": [
      "Per rigiocare servono almeno {n} giocatori: passa dalla lobby.",
      "To play again you need at least {n} players: go through the lobby.",
    ],

    /* regole */
    "rules.title": [null, "The rules"],
    "rules.close": [null, "Close"],
    "rules.body": [
      null,
      `<h3>The deck</h3>
      <p>52 French-suited cards, no jokers. Values from 2 to ace: <b>2 &lt; 3 &lt; … &lt; 10 &lt; J &lt; Q &lt; K &lt; A</b>. Trump is always <b class="red">hearts ♥&#xFE0E;</b>.</p>

      <h3>The trick</h3>
      <p>Whoever leads chooses the suit. <b>You must follow that suit</b> if you have it; if you don't, you play whatever you like, trump included. The highest trump wins, otherwise the highest card of the led suit. The winner leads the next trick.</p>

      <h3>The declaration</h3>
      <p>Before playing, everyone declares how many tricks they will take, starting from the left of the dealer.</p>
      <p><b>The last to speak is the dealer, and they can't make the total come out even:</b> the sum
      of the declarations can't be exactly the number of tricks at stake. With five players in a
      5-card round, if the first four each say 1, the dealer can't say 1. That way at least one
      player is bound to get it wrong.</p>
      <ul>
        <li><b>Declaration hit:</b> 10 points + 5 for every declared trick. Say 0 and take 0 → <b>10</b>. Say 1 and take 1 → <b>15</b>. Say 2 and take 2 → <b>20</b>, and so on.</li>
        <li><b>Declaration missed:</b> just 1 point for every trick you took.</li>
      </ul>

      <h3>The rounds</h3>
      <p>The hands go down: 7 cards each, then 6, 5, 4, 3, 2, 1. Then the three special rounds, with 7 cards:</p>
      <ul>
        <li><b>NO TRUMP</b> — there is no trump; the highest card of the led suit always wins.</li>
        <li><b>BLIND</b> — you declare <i>without looking at your cards</i>. You only see them once everyone has declared.</li>
        <li><b>MISÈRE</b> — nobody declares: every trick you take is worth <b class="red">−5 points</b>.
        But if you take <b>all</b> of them you turn the round around and score <b>+35</b>: all or nothing.</li>
      </ul>
      <h3>Latecomers</h3>
      <p>You need at least two players to start, so games often begin with bots. Anyone who joins
      with the code after the game has begun <b>takes a bot's seat</b>, with its cards and its
      score. Nobody is left out for being late.</p>

      <h3>Leaving</h3>
      <p>If someone closes the tab or loses the connection, <b>a bot plays in their place</b> and
      the game doesn't stop. If they come back before someone else sits there, they take their
      seat back; otherwise the seat is free for whoever arrives.</p>

      <p><b>Fast game:</b> 10 rounds (7→1 plus the three special ones).<br>
         <b>Long game:</b> 20 rounds (the fast one, then the climb back 1→7 and the three special ones again).</p>
      <p>The player with the most points at the end wins.</p>`,
    ],
  };

  /* ------------------------------------------------- frasi dei motori e della rete
   * [italiano, inglese]. Le frasi sono quelle scritte in site/js/engine.js,
   * site/js/room.js, site/js/net-p2p.js, trans/engine.py, server/*.py. {x} cattura
   * un pezzo variabile; title, kind e suit si traducono a loro volta. Vince il
   * primo modello che corrisponde: i piu' specifici vanno prima. */
  const E = [
    /* diario */
    ["Round {n}/{total} — {title}", "Round {n}/{total} — {title}"],
    ["A PERDERE: nessuna dichiarazione, ogni presa vale -5.", "MISÈRE: no declarations, every trick is worth -5."],
    ["{name} esce: al suo posto gioca un bot.", "{name} left: a bot plays in their place."],
    ["{name} rientra al tavolo.", "{name} is back at the table."],
    ["{name} prende il posto di {was}.", "{name} takes over {was}'s seat."],
    ["{name} dichiara {value}.", "{name} declares {value}."],
    ["Dichiarazioni chiuse: {total} prese dichiarate su {cards}.", "Declarations closed: {total} tricks declared out of {cards}."],
    ["{name} gioca {card}.", "{name} plays {card}."],
    ["Presa a {name}.", "Trick to {name}."],
    ["Fine round {n}: {summary}.", "End of round {n}: {summary}."],
    ["Partita finita. Vince {names}.", "Game over. {names} wins."],

    /* errori di gioco */
    ["non e' il momento di dichiarare", "it's not the time to declare"],
    ["non e' il tuo turno di dichiarare", "it's not your turn to declare"],
    [
      "chiudi tu il giro: con {value} la somma farebbe esattamente {cards}, e non e' permesso",
      "you close the round: with {value} the total would be exactly {cards}, and that's not allowed",
    ],
    ["dichiarazione non valida: {value}", "invalid declaration: {value}"],
    ["non e' il momento di giocare una carta", "it's not the time to play a card"],
    ["non e' il tuo turno", "it's not your turn"],
    ["non hai {card} in mano", "you don't have {card} in your hand"],
    ["devi rispondere a {suit}", "you must follow {suit}"],
    ["carta non giocabile", "that card can't be played"],
    ["il round non e' finito", "the round isn't over"],

    /* tavolo */
    ["solo chi ha creato il tavolo puo' farlo", "only the person who created the table can do that"],
    ["la partita non e' iniziata", "the game hasn't started"],
    ["partita gia' iniziata e non ci sono posti liberi da prendere", "the game has already started and there are no free seats to take"],
    ["partita gia' iniziata", "the game has already started"],
    ["tavolo pieno (max {n} giocatori)", "table full (max {n} players)"],
    ["livello sconosciuto: {level}", "unknown level: {level}"],
    ["giocatore non trovato", "player not found"],
    ["puoi rimuovere solo i bot", "you can only remove bots"],
    ["modalita' sconosciuta: {mode}", "unknown mode: {mode}"],
    ["modalita' sconosciuta", "unknown mode"],
    ["servono almeno {n} giocatori (aggiungi un bot)", "you need at least {n} players (add a bot)"],
    ["la partita non e' ancora finita", "the game isn't over yet"],
    ["non sei a questo tavolo", "you're not at this table"],
    ["messaggio sconosciuto: {type}", "unknown message: {type}"],
    ["messaggio sconosciuto", "unknown message"],
    ["messaggio non valido", "invalid message"],
    ["solo messaggi di testo", "text messages only"],
    ["sei gia' al tavolo", "you're already at the table"],
    ["prima entra in un tavolo", "join a table first"],
    ["mossa non valida", "invalid move"],
    ["mentre eri assente il tuo posto e' stato preso", "your seat was taken while you were away"],
    ["tavolo {code} inesistente", "table {code} doesn't exist"],
    ["il server e' pieno: riprova fra poco", "the server is full: try again shortly"],
    ["non riesco a generare un codice libero", "I can't generate a free code"],

    /* etichette */
    ["Partita veloce (10 round)", "Fast game (10 rounds)"],
    ["Partita lunga (20 round)", "Long game (20 rounds)"],
    ["{kind} · {cards} carte", "{kind} · {cards} cards"],
    ["{cards} carte", "{cards} cards"],
    ["Normale", "Normal"],
    ["NO BRISCOLA", "NO TRUMP"],
    ["BUIO", "BLIND"],
    ["A PERDERE", "MISÈRE"],
    ["cuori", "hearts"],
    ["quadri", "diamonds"],
    ["fiori", "clubs"],
    ["picche", "spades"],

    /* rete */
    [
      "non riesco a raggiungere il servizio che mette in contatto i browser. " +
        "Puo' essere momentaneamente giu', oppure la rete che stai usando lo blocca.",
      "I can't reach the service that puts the browsers in touch. " +
        "It may be down for a moment, or the network you're on is blocking it.",
    ],
    [
      "il tavolo esiste, ma i vostri browser non riescono a collegarsi fra loro. " +
        "Succede quando non siete sulla stessa rete (4G, hotspot, reti aziendali): " +
        "provate sulla stessa Wi-Fi.",
      "the table exists, but your browsers can't connect to each other. " +
        "This happens when you're not on the same network (4G, hotspot, corporate networks): " +
        "try on the same Wi-Fi.",
    ],
    [
      "il tavolo esiste, ma il collegamento non passa nemmeno dal relay: " +
        "probabilmente la rete che stai usando blocca anche quello.",
      "the table exists, but the connection doesn't even go through the relay: " +
        "the network you're on is probably blocking that too.",
    ],
    ["l'host ha chiuso la stanza", "the host closed the room"],
    [
      "l'host non risponde piu': ha chiuso la scheda o ha perso la connessione",
      "the host is no longer responding: they closed the tab or lost the connection",
    ],
    [
      "la tua versione di Dichiaro e' piu' vecchia di quella di chi ha creato il tavolo: " +
        "aggiornala (dal Play Store, o ricarica la pagina nel browser) e riprova.",
      "your version of Dichiaro is older than the one of whoever created the table: " +
        "update it (from the Play Store, or reload the page in your browser) and try again.",
    ],
    [
      "chi ha creato il tavolo ha una versione di Dichiaro piu' vecchia della tua: " +
        "digli di aggiornarla (dal Play Store, o di ricaricare la pagina nel browser).",
      "whoever created the table has an older version of Dichiaro than yours: " +
        "tell them to update it (from the Play Store, or to reload the page in their browser).",
    ],
    ["questo browser non supporta WebRTC", "this browser doesn't support WebRTC"],
    ["libreria di connessione non caricata", "connection library not loaded"],
    ["troppi messaggi", "too many messages"],
    ["messaggio troppo grande", "message too large"],
    ["non legge i messaggi", "not reading messages"],
  ];

  /* Che forma ha il pezzo variabile: di default qualunque cosa, ma carte e
   * numeri sono solo carte e numeri, cosi' un nome non confonde un modello. */
  const SHAPES = {
    card: "(?:10|[2-9JQKA])[HDCS]",
    n: "-?\\d+", total: "-?\\d+", cards: "-?\\d+", value: "-?\\d+",
  };
  const TRANSLATED_PARTS = new Set(["title", "kind", "suit"]);

  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const COMPILED = E.map(([it, en]) => {
    const names = [];
    const source = escapeRegex(it).replace(/\\\{(\w+)\\\}/g, (_m, name) => {
      names.push(name);
      return `(?<${name}>${SHAPES[name] || ".+?"})`;
    });
    return { it, en, names, re: new RegExp("^" + source + "$", "s") };
  });

  /* ------------------------------------------------------------------- stato */

  let current = "it";
  const listeners = [];

  function detect() {
    try {
      const saved = localStorage.getItem("trans.lang");
      if (LANGS.includes(saved)) return saved;
    } catch { /* memoria negata: si va a lingua del dispositivo */ }
    const wanted = (typeof navigator !== "undefined" && (navigator.language || "")) || "";
    return /^it\b/i.test(wanted) ? "it" : "en";
  }

  const escapeHtml = (text) =>
    String(text).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function fill(template, params, protect) {
    return template.replace(/\{(\w+)\}/g, (match, name) => {
      if (!params || !(name in params)) return match;
      const value = String(params[name]);
      return protect && !name.endsWith("Html") ? escapeHtml(value) : value;
    });
  }

  /** Testo per textContent. */
  function t(key, params) {
    const entry = S[key];
    if (!entry) return key;
    const text = entry[current === "en" ? 1 : 0];
    return fill(text === null || text === undefined ? entry[1] : text, params, false);
  }

  /** Testo per innerHTML: i parametri si proteggono, tranne quelli che finiscono in "Html". */
  function th(key, params) {
    const entry = S[key];
    if (!entry) return escapeHtml(key);
    const text = entry[current === "en" ? 1 : 0];
    return fill(text === null || text === undefined ? entry[1] : text, params, true);
  }

  /* Le frasi dei motori. In italiano si lasciano come sono. */
  function translate(text, depth) {
    for (const item of COMPILED) {
      const match = item.re.exec(text);
      if (!match) continue;
      const parts = {};
      for (const name of item.names) {
        const value = match.groups[name];
        parts[name] = depth < 2 && TRANSLATED_PARTS.has(name) ? translate(value, depth + 1) : value;
      }
      return fill(item.en, parts, false);
    }
    return text;
  }

  function engine(text) {
    if (current === "it" || typeof text !== "string") return text;
    return translate(text, 0);
  }

  /* --------------------------------------------------------------- la pagina */

  function applyTo(root) {
    if (typeof document === "undefined") return;
    const scope = root || document;
    const inOffice = document.documentElement.dataset.mode === "office";

    scope.querySelectorAll("[data-i18n], [data-i18n-html]").forEach((el) => {
      // Il testo italiano e' quello scritto nella pagina: si ricorda la prima volta.
      if (inOffice && el.hasAttribute("data-office-key")) return;
      const html = el.hasAttribute("data-i18n-html");
      const key = el.getAttribute(html ? "data-i18n-html" : "data-i18n");
      if (el.dataset.i18nOrig === undefined) el.dataset.i18nOrig = html ? el.innerHTML : el.textContent;
      const text = current === "it" && S[key] && S[key][0] === null ? el.dataset.i18nOrig : t(key);
      if (html) el.innerHTML = text;
      else el.textContent = text;
    });

    // data-i18n-attr="placeholder:chat.placeholder;title:top.office_title"
    scope.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      el.getAttribute("data-i18n-attr").split(";").forEach((pair) => {
        const [attr, key] = pair.split(":").map((s) => s.trim());
        if (!attr || !key) return;
        const slot = "i18nOrig" + attr.replace(/(^|-)(\w)/g, (_m, _d, c) => c.toUpperCase());
        if (el.dataset[slot] === undefined) el.dataset[slot] = el.getAttribute(attr) || "";
        const text = current === "it" && S[key] && S[key][0] === null ? el.dataset[slot] : t(key);
        el.setAttribute(attr, text);
      });
    });
  }

  function setLang(lang, quiet) {
    if (!LANGS.includes(lang)) return;
    current = lang;
    try { localStorage.setItem("trans.lang", lang); } catch { /* modalita' privata */ }
    if (typeof document !== "undefined") document.documentElement.lang = lang;
    applyTo();
    if (!quiet) listeners.slice().forEach((fn) => fn(lang));
  }

  function init() {
    current = detect();
    if (typeof document !== "undefined") document.documentElement.lang = current;
  }
  init();

  const api = {
    LANGS,
    lang: () => current,
    t, th, engine,
    apply: applyTo,
    setLang,
    toggle: () => setLang(current === "it" ? "en" : "it"),
    onChange: (fn) => { listeners.push(fn); },
    // Per i test.
    _dictionary: S,
    _engine: E,
    _which: (text) => COMPILED.findIndex((item) => item.re.test(text)),
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  else window.I18N = api;
})();
