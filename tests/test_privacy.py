"""L'informativa sulla privacy deve restare vera.

Elenca i servizi esterni con cui l'app parla: se qualcuno ne aggiunge uno nel
codice e dimentica la pagina, questi test falliscono.
"""

import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
PAGE = (ROOT / "site" / "privacy.html").read_text(encoding="utf-8")


def test_gli_host_del_codice_sono_nell_informativa():
    net = (ROOT / "site" / "js" / "net-p2p.js").read_text(encoding="utf-8")
    build = (ROOT / "site" / "build.py").read_text(encoding="utf-8")

    stun = set(re.findall(r"stun:([a-z0-9.-]+)", net))
    broker = re.search(r'PEERJS_CLOUD_HOST = "([^"]+)"', build)
    assert stun, "nessun server STUN trovato: la regex non vede piu' net-p2p.js"
    assert broker, "PEERJS_CLOUD_HOST non trovato in build.py"

    for host in stun | {broker.group(1)}:
        assert host in PAGE, f"{host} e' usato dall'app ma non e' nell'informativa"


def test_ci_sono_italiano_e_inglese_e_un_contatto():
    assert 'id="it"' in PAGE and 'lang="it"' in PAGE
    assert 'id="en"' in PAGE and 'lang="en"' in PAGE
    assert "mailto:" in PAGE
    assert "AdMob" in PAGE


def test_la_pagina_non_carica_nulla_da_fuori():
    # Solo testo e un po' di stile: niente script, immagini o font esterni.
    assert "<script" not in PAGE.lower()
    assert not re.search(r'\s(src|srcset)\s*=', PAGE, re.IGNORECASE)
    assert "@import" not in PAGE and "url(" not in PAGE
