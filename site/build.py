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

ROOT = pathlib.Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
SITE = ROOT / "site"
DIST = SITE / "dist"

PEERJS = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"

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

    # Senza .nojekyll, Pages passa tutto da Jekyll e ignora certe cartelle.
    (DIST / ".nojekyll").write_text("")

    files = sorted(p.relative_to(DIST).as_posix() for p in DIST.rglob("*") if p.is_file())
    print(f"site/dist pronto — versione {version} — {len(files)} file:")
    for f in files:
        print("  " + f)


if __name__ == "__main__":
    main()
