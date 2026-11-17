"""Assembla il sito statico per GitHub Pages.

La UI non viene duplicata: index.html, style.css e app.js sono quelli di
``web/``, gli stessi che serve il server Python. Qui vengono solo ricuciti con
il trasporto peer-to-peer, che parla lo stesso protocollo del WebSocket.

    python site/build.py        # scrive site/dist/
    python site/build.py --app  # scrive site/dist-app/, per l'app Android

La variante ``--app`` e' lo stesso sito con due differenze: il link d'invito
punta al sito pubblico invece che a https://localhost, e mancano i file che
servono solo ai motori di ricerca.

PeerJS e' una copia locale in entrambe le varianti: caricarlo da un CDN darebbe
a un terzo il controllo della pagina, e la pagina conosce le carte di tutti.
Alla pagina si aggiunge una Content-Security-Policy: se un giorno un campo
dello stato finisse nell'HTML senza escape, il browser non eseguirebbe lo
stesso lo script.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import pathlib
import re
import shutil
import sys
import urllib.parse
from datetime import date

ROOT = pathlib.Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
SITE = ROOT / "site"
APP = "--app" in sys.argv[1:]
DIST = SITE / ("dist-app" if APP else "dist")

PEERJS_VERSION = "1.5.4"
PEERJS_FILE = f"peerjs-{PEERJS_VERSION}.min.js"
PEERJS_LOCAL = SITE / "vendor" / PEERJS_FILE

#: Il broker pubblico di PeerJS (host di default della libreria).
PEERJS_CLOUD_HOST = "0.peerjs.com"

LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]"}

#: Le unita' pubblicitarie di PROVA di Google: pubbliche, stanno nella documentazione
#: di AdMob e mostrano sempre annunci finti ("Test Ad"). Sono il default: gli id veri
#: si danno solo con le variabili ADMOB_*, e app/build.sh lo permette solo in una
#: build di rilascio firmata. Cliccare i propri annunci veri puo' costare l'account.
ADMOB_TEST_UNITS = {
    "interstitial": "ca-app-pub-3940256099942544/1033173712",
    "appOpen": "ca-app-pub-3940256099942544/9257395921",
}
ADMOB_UNIT_RE = re.compile(r"^ca-app-pub-[0-9]{16}/[0-9]{10}$")

# Un raw string: niente ambiguita' di doppio escaping. E' la sequenza JS
# per '<', usata per evitare che un "</script>" dentro un valore incorporato
# chiuda il blocco prima del tempo.
ESCAPED_LT = '\\u003c'

#: Dove vive il sito pubblicato. Serve agli indirizzi assoluti che vogliono
#: Open Graph e la sitemap: quelli relativi li' non funzionano.
SITE_URL = "https://dantonioluigi.github.io/trans-card-game/"

TITLE = "Dichiaro — il gioco di carte"
DESCRIPTION = (
    "Tra Re e Asso, non sbagliare: un mix tra tresette e briscola. Prevedi "
    "quante prese farai, e sbagliare costa. Si gioca online con gli amici o "
    "contro i bot."
)

#: Quello che si vede quando il link finisce in una chat. Senza, appare
#: l'indirizzo nudo — ed e' cosi' che questo gioco si passa davvero di mano.
SOCIAL_CARD = f"""  <link rel="canonical" href="{SITE_URL}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Dichiaro">
  <meta property="og:title" content="{TITLE}">
  <meta property="og:description" content="{DESCRIPTION}">
  <meta property="og:url" content="{SITE_URL}">
  <meta property="og:image" content="{SITE_URL}anteprima.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Il tavolo di Dichiaro a partita in corso">
  <meta property="og:locale" content="it_IT">
  <meta name="twitter:card" content="summary_large_image">
"""

#: File di verifica di Google Search Console. Il nome lo assegna Google e il
#: contenuto e' una riga sola che ripete il nome del file: deve restare
#: raggiungibile per sempre, se sparisce la proprieta' torna non verificata.
GOOGLE_VERIFICATION = "googled3de7d3fb246b92b.html"

ROBOTS = f"""User-agent: *
Allow: /

Sitemap: {SITE_URL}sitemap.xml
"""

#: La riga sotto il titolo della home, com'e' in web/index.html: dopo di lei
#: la build aggiunge la nota e i link.
TAGLINE = (
    '      <p class="tagline" data-office-key="office.tagline" data-i18n="home.tagline">'
    "Dichiara quante prese farai. Sbagliare costa.</p>\n"
)

HOME_NOTE = """    <p class="tagline small" data-i18n="home.p2p_note">Versione senza server: le partite passano da browser a browser.</p>
"""

LOBBY_NOTE = """      <p class="hint warn" id="p2pHostNote" data-i18n="lobby.host_note" hidden>Il tavolo vive in questa scheda:
      se la chiudi, la partita finisce per tutti.</p>
"""

def home_links() -> str:
    """Privacy sempre; nell'app anche il pulsante delle scelte sulla pubblicita'
    (nascosto: lo mostra ads.js solo dove il consenso lo richiede)."""
    href = SITE_URL + "privacy.html" if APP else "privacy.html"
    button = (
        '<button class="linklike" id="btnAdsPrivacy" type="button" data-i18n="home.ads_choices" hidden>'
        "Pubblicità: le tue scelte</button>"
        if APP else ""
    )
    return f'    <p class="tagline small links"><a href="{href}">Privacy</a>{button}</p>\n'


EXTRA_CSS = """
/* --- aggiunte della versione peer-to-peer --- */
.tagline.small { font-size: .85rem; opacity: .75; margin-top: .6rem; }
.hint.warn { color: var(--gold); }
/* Privacy e scelte sulla pubblicita': devono restare raggiungibili anche nel
   layout compatto da telefono in orizzontale, che nasconde le altre note. */
.tagline.small.links { display: flex; flex-wrap: wrap; gap: .2rem 1.2rem; justify-content: center; }
.tagline.small.links a, .tagline.small.links .linklike { color: inherit; font-size: inherit; }
[data-mode="office"] .tagline.small.links { display: none; }
@media (orientation: landscape) and (max-height: 520px) {
  .tagline.small.links { font-size: .72rem; margin-top: 0; }
  /* Bersagli da toccare con un dito: piccoli a vedersi, non da centrare. */
  .tagline.small.links a, .tagline.small.links .linklike { padding: .45rem .5rem; }
}
"""


def build_id(sources: list[pathlib.Path]) -> str:
    """Impronta di tutto il codice del sito.

    GitHub Pages serve gli asset con cache-control: max-age=600 e non lascia
    cambiare le intestazioni. Senza un indirizzo diverso a ogni build, chi ha
    gia' aperto il gioco continua a vedere la versione vecchia per dieci minuti
    dopo ogni pubblicazione. Con ?v=<impronta> l'indirizzo cambia solo quando
    cambia davvero il contenuto.
    """
    digest = hashlib.sha256()
    for path in sources:
        digest.update(path.read_bytes())
    return digest.hexdigest()[:10]


def _inline_script(var_name: str, value) -> str:
    # json.dumps protegge le virgolette; "<" va protetto a mano, se no un
    # chiusura di script anticipata nel valore chiuderebbe il blocco prima del
    # tempo.
    literal = json.dumps(value).replace("<", ESCAPED_LT)
    return "<script>window." + var_name + " = " + literal + ";</script>\n"


def relay_config() -> str:
    """Come il browser trova il relay TURN, se ce n'e' uno.

    Due modi, entrambi dall'ambiente e non dal codice: in pubblicazione li
    passano le variabili del repo.

    - TRANS_TURN_ICE: un elenco di server gia' pronto (le credenziali statiche
      di un piano gratuito, che non scadono). Va incorporato cosi' com'e':
      nessuna richiesta in piu' per aprire una connessione.
    - TRANS_TURN_URL: un indirizzo che genera credenziali temporanee al volo,
      per chi preferisce quel meccanismo.

    Senza nessuno dei due il sito funziona lo stesso, ma solo fra browser che
    riescono a collegarsi direttamente.
    """
    ice_json = os.environ.get("TRANS_TURN_ICE", "").strip()
    url = os.environ.get("TRANS_TURN_URL", "").strip()

    out = []
    if ice_json:
        try:
            servers = json.loads(ice_json)
        except json.JSONDecodeError as exc:
            raise SystemExit("TRANS_TURN_ICE non e' un JSON valido: " + str(exc)) from exc
        if not isinstance(servers, list) or not servers:
            raise SystemExit("TRANS_TURN_ICE deve essere un array non vuoto di server ICE")
        out.append(_inline_script("TRANS_TURN_ICE", servers))
    if url:
        out.append(_inline_script("TRANS_TURN_URL", url))
    return "".join(out)


def _origin(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}"


def broker_config() -> str:
    """Un broker PeerJS proprio, scelto in pubblicazione e non nell'indirizzo.

    Prima bastava ``?broker=https://...`` in un link: chiunque poteva costruirne
    uno che portava la vittima su un falso tavolo. Ora si imposta qui, con la
    variabile TRANS_BROKER, e vale per tutti.
    """
    url = os.environ.get("TRANS_BROKER", "").strip()
    if not url:
        return ""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("https", "http") or not parsed.hostname:
        raise SystemExit("TRANS_BROKER deve essere un indirizzo http(s) completo")
    if parsed.scheme != "https" and parsed.hostname not in LOCAL_HOSTS:
        raise SystemExit("TRANS_BROKER deve essere https, tranne che in locale")
    return _inline_script("TRANS_BROKER", url)


def ads_config() -> str:
    """Gli id delle unita' pubblicitarie, solo per la build dell'app.

    ADMOB_INTERSTITIAL_ID e ADMOB_APP_OPEN_ID vanno dati insieme o per niente:
    una build mezza di prova e mezza vera sarebbe un errore difficile da vedere.
    Senza, si usano quelli di prova di Google.
    """
    given = {
        "interstitial": os.environ.get("ADMOB_INTERSTITIAL_ID", "").strip(),
        "appOpen": os.environ.get("ADMOB_APP_OPEN_ID", "").strip(),
    }
    if any(given.values()) and not all(given.values()):
        raise SystemExit("ADMOB_INTERSTITIAL_ID e ADMOB_APP_OPEN_ID vanno impostati insieme")
    units = given if all(given.values()) else dict(ADMOB_TEST_UNITS)
    for name, value in units.items():
        if not ADMOB_UNIT_RE.match(value):
            raise SystemExit(f"id AdMob non valido per {name}: {value!r} (atteso ca-app-pub-0000000000000000/0000000000)")
    return _inline_script("TRANS_ADS_IDS", units)


def content_security_policy(inline_scripts: str) -> str:
    """La CSP della pagina, con gli hash degli script in linea di questa build."""
    hashes = [
        "'sha256-" + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode() + "'"
        for body in re.findall(r"<script>(.*?)</script>", inline_scripts, re.S)
    ]
    connect = ["'self'", f"https://{PEERJS_CLOUD_HOST}", f"wss://{PEERJS_CLOUD_HOST}"]
    broker = os.environ.get("TRANS_BROKER", "").strip()
    if broker:
        origin = _origin(broker)
        connect += [origin, origin.replace("http", "ws", 1)]
    turn = os.environ.get("TRANS_TURN_URL", "").strip()
    if turn:
        connect.append(_origin(turn))
    return "; ".join([
        "default-src 'none'",
        "script-src " + " ".join(["'self'"] + hashes),
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src " + " ".join(connect),
        "base-uri 'none'",
        "form-action 'none'",
    ])


def transform_index(html: str, version: str) -> str:
    def swap(before: str, after: str) -> None:
        nonlocal html
        assert before in html, f"non trovo nel sorgente: {before[:60]!r}"
        html = html.replace(before, after, 1)

    swap('href="/static/style.css"', f'href="style.css?v={version}"')
    swap('<script src="/static/i18n.js"></script>', f'<script src="i18n.js?v={version}"></script>')

    # La descrizione del sorgente e quella condivisa devono restare la stessa.
    swap(
        '<meta name="description" content="Dichiaro: gioco di carte a prese e previsioni, '
        'a metà tra tresette e briscola, online o contro i bot.">\n',
        f'<meta name="description" content="{DESCRIPTION}">\n' + ("" if APP else SOCIAL_CARD),
    )

    # Nell'app la pagina vive su https://localhost: il link d'invito deve
    # puntare al sito pubblico, dove chi lo riceve puo' aprirlo.
    share = _inline_script("TRANS_SHARE_URL", SITE_URL) if APP else ""
    inline = share + relay_config() + broker_config() + (ads_config() if APP else "")

    swap(
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n',
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        f'  <meta http-equiv="Content-Security-Policy" content="{content_security_policy(inline)}">\n',
    )

    # Il trasporto va installato prima che app.js parta: i moduli sono
    # deferred, quindi girano comunque prima del DOMContentLoaded.
    swap(
        '<script src="/static/app.js"></script>',
        f'<script src="{PEERJS_FILE}"></script>\n'
        + inline
        + f'<script type="module" src="js/net-p2p.js?v={version}"></script>\n'
        + (f'<script type="module" src="js/ads.js?v={version}"></script>\n' if APP else "")
        + f'<script src="app.js?v={version}"></script>',
    )

    swap(
        TAGLINE,
        TAGLINE + HOME_NOTE + home_links(),
    )

    swap(
        "      <ul class=\"seats\" id=\"seatList\"></ul>\n",
        LOBBY_NOTE + "\n      <ul class=\"seats\" id=\"seatList\"></ul>\n",
    )
    return html


def version_imports(source: str, version: str) -> str:
    """Anche gli import fra moduli vanno versionati, se no restano in cache."""
    return re.sub(r'from "\./([A-Za-z0-9_.-]+\.js)"', rf'from "./\1?v={version}"', source)


def main() -> None:
    # La pubblicita' esiste solo nell'app: il sito web non riceve nemmeno il file.
    modules = [m for m in sorted((SITE / "js").glob("*.js")) if APP or m.name != "ads.js"]
    version = build_id([WEB / "index.html", WEB / "style.css", WEB / "app.js", WEB / "i18n.js", *modules])

    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / "js").mkdir(parents=True)

    (DIST / "index.html").write_text(transform_index((WEB / "index.html").read_text(), version))
    (DIST / "style.css").write_text((WEB / "style.css").read_text() + EXTRA_CSS)
    shutil.copy2(WEB / "app.js", DIST / "app.js")
    shutil.copy2(WEB / "i18n.js", DIST / "i18n.js")

    for module in modules:
        (DIST / "js" / module.name).write_text(version_imports(module.read_text(), version))

    shutil.copy2(PEERJS_LOCAL, DIST / PEERJS_FILE)
    if not APP:
        shutil.copy2(ROOT / "docs" / "social.png", DIST / "anteprima.png")

        # L'informativa sulla privacy: Play e AdMob ne vogliono un indirizzo pubblico.
        shutil.copy2(SITE / "privacy.html", DIST / "privacy.html")

        # Una pagina sola, ma Search Console la sitemap la chiede lo stesso.
        (DIST / "sitemap.xml").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            f"  <url>\n    <loc>{SITE_URL}</loc>\n"
            f"    <lastmod>{date.today().isoformat()}</lastmod>\n"
            "    <changefreq>monthly</changefreq>\n  </url>\n"
            "</urlset>\n"
        )
        (DIST / "robots.txt").write_text(ROBOTS)
        (DIST / GOOGLE_VERIFICATION).write_text(
            f"google-site-verification: {GOOGLE_VERIFICATION}\n"
        )

        # Senza .nojekyll, Pages passa tutto da Jekyll e ignora certe cartelle.
        (DIST / ".nojekyll").write_text("")

    files = sorted(p.relative_to(DIST).as_posix() for p in DIST.rglob("*") if p.is_file())
    if os.environ.get("TRANS_TURN_ICE"):
        relay = "relay statico configurato"
    elif os.environ.get("TRANS_TURN_URL"):
        relay = "relay dinamico configurato"
    else:
        relay = "SENZA relay"
    print(f"{DIST.relative_to(ROOT)} pronto — versione {version} — {relay} — {len(files)} file:")
    for f in files:
        print("  " + f)


if __name__ == "__main__":
    main()
