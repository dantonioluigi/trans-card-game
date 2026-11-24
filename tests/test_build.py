"""Le due build del sito (web e app): cosa c'e' e, soprattutto, cosa non c'e'.

La scheda di Play e l'informativa dicono che l'app non ha pubblicita' e non usa
l'ID pubblicitario. Se un SDK pubblicitario rientra per sbaglio, la scheda
diventerebbe falsa: questi test lo fanno vedere subito.
"""

import json
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
MARKERS = ("ads.js", "TRANS_ADS", "btnAdsPrivacy", "ca-app-pub", "admob", "AdMob")


def build(*args):
    env = {k: v for k, v in os.environ.items() if not k.startswith("TRANS_")}
    result = subprocess.run(
        [sys.executable, str(ROOT / "site" / "build.py"), *args],
        cwd=ROOT, env=env, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    return ROOT / "site" / ("dist-app" if "--app" in args else "dist")


def test_ne_il_sito_ne_l_app_hanno_pubblicita():
    for args in ((), ("--app",)):
        dist = build(*args)
        html = (dist / "index.html").read_text(encoding="utf-8")
        for marker in MARKERS:
            assert marker not in html, f"{marker!r} nella pagina ({'app' if args else 'web'})"
        files = [p.name for p in dist.rglob("*") if p.is_file()]
        assert "ads.js" not in files


def test_l_app_android_non_ha_un_sdk_pubblicitario():
    package = json.loads((ROOT / "app" / "package.json").read_text(encoding="utf-8"))
    deps = {**package.get("dependencies", {}), **package.get("devDependencies", {})}
    assert not [name for name in deps if "admob" in name.lower() or "ads" in name.lower().split("/")[-1]]
    lock = (ROOT / "app" / "package-lock.json").read_text(encoding="utf-8").lower()
    assert "admob" not in lock and "google-mobile-ads" not in lock


def test_privacy_nel_sito_e_nell_app():
    web = build()
    assert 'href="privacy.html"' in (web / "index.html").read_text(encoding="utf-8")
    assert (web / "privacy.html").exists()
    app = build("--app")
    page = (app / "index.html").read_text(encoding="utf-8")
    assert 'href="https://dantonioluigi.github.io/trans-card-game/privacy.html"' in page
    assert not (app / "privacy.html").exists()  # l'informativa sta online, non nell'app


def test_il_blocco_orizzontale_non_restringe_i_dispositivi():
    # "sensorLandscape" fa dedurre a Play il requisito screen.landscape: senza la
    # dichiarazione esplicita "required=false" la scheda perde dispositivi.
    script = (ROOT / "app" / "build.sh").read_text(encoding="utf-8")
    assert 'android:screenOrientation="sensorLandscape"' in script
    assert (
        'android:name="android.hardware.screen.landscape" android:required="false"' in script
    )


def test_la_pagina_resta_fuori_dalle_barre_di_sistema():
    # L'app Android disegna a tutto schermo ("viewport-fit=cover"): se la pagina non
    # tiene un margine, i tasti in alto finiscono sotto l'orario e non si toccano.
    css = (ROOT / "web" / "style.css").read_text(encoding="utf-8")
    for lato in ("top", "right", "bottom", "left"):
        assert f"env(safe-area-inset-{lato}" in css  # browser e WebView recenti
        assert f"var(--safe-area-inset-{lato}" in css  # variabili iniettate da Capacitor
    body = re.search(r"\nbody\s*\{([^}]*)\}", css)
    assert body and "padding: var(--safe-top) var(--safe-right)" in body.group(1)


def test_l_app_android_sceglie_colore_di_sfondo_e_icone_delle_barre():
    config = json.loads((ROOT / "app" / "capacitor.config.json").read_text(encoding="utf-8"))
    # Icone chiare: l'app e' scura, con icone scure l'orario sparirebbe.
    assert config["plugins"]["SystemBars"]["style"] == "DARK"
    script = (ROOT / "app" / "build.sh").read_text(encoding="utf-8")
    assert 'android:windowBackground">#0b1512' in script
    assert config["backgroundColor"] == "#0b1512"


def test_la_licenza_di_peerjs_viaggia_con_la_libreria():
    # PeerJS e' MIT e il file minimizzato non ha l'intestazione: l'avviso va distribuito.
    for args in ((), ("--app",)):
        dist = build(*args)
        licence = (dist / "peerjs-LICENSE.txt").read_text(encoding="utf-8")
        assert "MIT" in licence and "Copyright" in licence and "peerjs" in licence.lower()
        assert (dist / "peerjs-1.5.4.min.js").exists()


def test_l_app_avvisa_degli_aggiornamenti_di_play():
    # Il plugin e' nativo: senza, window.Capacitor.Plugins.AppUpdate non esiste e
    # l'app non avvisa mai nessuno. Versione esatta, come le altre dipendenze.
    package = json.loads((ROOT / "app" / "package.json").read_text(encoding="utf-8"))
    version = package["dependencies"].get("@capawesome/capacitor-app-update", "")
    assert re.fullmatch(r"\d+\.\d+\.\d+", version), f"versione non fissata: {version!r}"
    lock = json.loads((ROOT / "app" / "package-lock.json").read_text(encoding="utf-8"))
    assert lock["packages"]["node_modules/@capawesome/capacitor-app-update"]["version"] == version

    assert "Capacitor.Plugins.AppUpdate" in (ROOT / "web" / "app.js").read_text(encoding="utf-8")
    # L'avviso e' nascosto di default: sul sito nessuno lo accende, quindi non deve mai vedersi.
    for args in ((), ("--app",)):
        html = (build(*args) / "index.html").read_text(encoding="utf-8")
        assert 'id="updateOverlay" hidden' in html
