"""Le due build del sito (web e app): cosa c'e' e, soprattutto, cosa non c'e'.

La scheda di Play e l'informativa dicono che l'app non ha pubblicita' e non usa
l'ID pubblicitario. Se un SDK pubblicitario rientra per sbaglio, la scheda
diventerebbe falsa: questi test lo fanno vedere subito.
"""

import json
import os
import pathlib
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


def test_la_licenza_di_peerjs_viaggia_con_la_libreria():
    # PeerJS e' MIT e il file minimizzato non ha l'intestazione: l'avviso va distribuito.
    for args in ((), ("--app",)):
        dist = build(*args)
        licence = (dist / "peerjs-LICENSE.txt").read_text(encoding="utf-8")
        assert "MIT" in licence and "Copyright" in licence and "peerjs" in licence.lower()
        assert (dist / "peerjs-1.5.4.min.js").exists()
