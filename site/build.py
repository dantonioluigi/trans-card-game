"""Assembla il sito statico per GitHub Pages.

La UI non viene duplicata: index.html, style.css e app.js sono quelli di
``web/``, gli stessi che serve il server Python. Qui vengono solo ricuciti con
il trasporto peer-to-peer, che parla lo stesso protocollo del WebSocket.

    python site/build.py        # scrive site/dist/
"""

from __future__ import annotations

import pathlib
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


def transform_index(html: str) -> str:
    def swap(before: str, after: str) -> None:
        nonlocal html
        assert before in html, f"non trovo nel sorgente: {before[:60]!r}"
        html = html.replace(before, after, 1)

    swap('href="/static/style.css"', 'href="style.css"')

    # Il trasporto va installato prima che app.js parta: i moduli sono
    # deferred, quindi girano comunque prima del DOMContentLoaded.
    swap(
        '<script src="/static/app.js"></script>',
        f'<script src="{PEERJS}"></script>\n'
        '<script type="module" src="js/net-p2p.js"></script>\n'
        '<script src="app.js"></script>',
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


def main() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / "js").mkdir(parents=True)

    (DIST / "index.html").write_text(transform_index((WEB / "index.html").read_text()))
    (DIST / "style.css").write_text((WEB / "style.css").read_text() + EXTRA_CSS)
    shutil.copy2(WEB / "app.js", DIST / "app.js")

    for module in sorted((SITE / "js").glob("*.js")):
        shutil.copy2(module, DIST / "js" / module.name)

    # Senza .nojekyll, Pages passa tutto da Jekyll e ignora certe cartelle.
    (DIST / ".nojekyll").write_text("")

    files = sorted(p.relative_to(DIST).as_posix() for p in DIST.rglob("*") if p.is_file())
    print(f"site/dist pronto — {len(files)} file:")
    for f in files:
        print("  " + f)


if __name__ == "__main__":
    main()
