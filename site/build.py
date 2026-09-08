"""Assembla il sito statico per GitHub Pages.

La UI non viene duplicata: index.html, style.css e app.js sono quelli di
``web/``, gli stessi che serve il server Python. Qui vengono solo ricuciti con
il trasporto peer-to-peer, che parla lo stesso protocollo del WebSocket.

    python site/build.py        # scrive site/dist/
"""

from __future__ import annotations

import hashlib
import pathlib
import re
import shutil
from datetime import date

ROOT = pathlib.Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
SITE = ROOT / "site"
DIST = SITE / "dist"

PEERJS = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"

#: Dove vive il sito pubblicato. Serve agli indirizzi assoluti che vogliono
#: Open Graph e la sitemap: quelli relativi li' non funzionano.
SITE_URL = "https://dantonioluigi.github.io/trans-card-game/"

TITLE = "TRANS — il gioco di carte"
DESCRIPTION = (
    "Gioco di carte a prese e dichiarazioni: dichiari quante prese farai, e "
    "sbagliare costa. Si gioca nel browser con gli amici o contro i bot."
)

#: Quello che si vede quando il link finisce in una chat. Senza, appare
#: l'indirizzo nudo — ed e' cosi' che questo gioco si passa davvero di mano.
SOCIAL_CARD = f"""  <link rel="canonical" href="{SITE_URL}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="TRANS">
  <meta property="og:title" content="{TITLE}">
  <meta property="og:description" content="{DESCRIPTION}">
  <meta property="og:url" content="{SITE_URL}">
  <meta property="og:image" content="{SITE_URL}anteprima.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Il tavolo di TRANS a partita in corso">
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

HOME_NOTE = """    <p class="tagline small">Versione senza server: le partite passano da browser a browser.</p>
"""

LOBBY_NOTE = """      <p class="hint warn" id="p2pHostNote" hidden>Il tavolo vive in questa scheda:
      se la chiudi, la partita finisce per tutti.</p>
"""

EXTRA_CSS = """
/* --- aggiunte della versione peer-to-peer --- */
.tagline.small { font-size: .85rem; opacity: .75; margin-top: .6rem; }
.hint.warn { color: var(--gold); }
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


def transform_index(html: str, version: str) -> str:
    def swap(before: str, after: str) -> None:
        nonlocal html
        assert before in html, f"non trovo nel sorgente: {before[:60]!r}"
        html = html.replace(before, after, 1)

    swap('href="/static/style.css"', f'href="style.css?v={version}"')

    # La descrizione del sorgente e quella condivisa devono restare la stessa.
    swap(
        '<meta name="description" content="TRANS: gioco di carte a prese e scommesse, '
        'online o contro i bot.">\n',
        f'<meta name="description" content="{DESCRIPTION}">\n' + SOCIAL_CARD,
    )

    # Il trasporto va installato prima che app.js parta: i moduli sono
    # deferred, quindi girano comunque prima del DOMContentLoaded.
    swap(
        '<script src="/static/app.js"></script>',
        f'<script src="{PEERJS}"></script>\n'
        f'<script type="module" src="js/net-p2p.js?v={version}"></script>\n'
        f'<script src="app.js?v={version}"></script>',
    )

    swap(
        '      <p class="tagline">Dichiara quante prese farai. Sbagliare costa.</p>\n',
        '      <p class="tagline">Dichiara quante prese farai. Sbagliare costa.</p>\n' + HOME_NOTE,
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
    modules = sorted((SITE / "js").glob("*.js"))
    version = build_id([WEB / "index.html", WEB / "style.css", WEB / "app.js", *modules])

    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / "js").mkdir(parents=True)

    (DIST / "index.html").write_text(transform_index((WEB / "index.html").read_text(), version))
    (DIST / "style.css").write_text((WEB / "style.css").read_text() + EXTRA_CSS)
    shutil.copy2(WEB / "app.js", DIST / "app.js")

    for module in modules:
        (DIST / "js" / module.name).write_text(version_imports(module.read_text(), version))

    shutil.copy2(ROOT / "docs" / "social.png", DIST / "anteprima.png")

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
    print(f"site/dist pronto — versione {version} — {len(files)} file:")
    for f in files:
        print("  " + f)


if __name__ == "__main__":
    main()
