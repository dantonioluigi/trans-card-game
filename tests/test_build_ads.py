"""La pubblicita' entra solo nella build dell'app, e con gli id giusti.

Il rischio da evitare: l'id vero messo per sbaglio in una build di prova (cliccare i
propri annunci puo' far sospendere l'account AdMob) o gli annunci nel sito web.
"""

import base64
import hashlib
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
TEST_INTERSTITIAL = "ca-app-pub-3940256099942544/1033173712"
TEST_APP_OPEN = "ca-app-pub-3940256099942544/9257395921"
LIVE_INTERSTITIAL = "ca-app-pub-1234567890123456/1234567890"
LIVE_APP_OPEN = "ca-app-pub-1234567890123456/0987654321"


def build(*args, **env):
    clean = {k: v for k, v in os.environ.items() if not k.startswith(("ADMOB_", "TRANS_"))}
    clean.update(env)
    return subprocess.run(
        [sys.executable, str(ROOT / "site" / "build.py"), *args],
        cwd=ROOT, env=clean, capture_output=True, text=True,
    )


def app_index(**env):
    result = build("--app", **env)
    assert result.returncode == 0, result.stderr
    return (ROOT / "site" / "dist-app" / "index.html").read_text(encoding="utf-8")


def test_senza_variabili_si_usano_gli_id_di_prova_di_google():
    html = app_index()
    assert TEST_INTERSTITIAL in html and TEST_APP_OPEN in html
    assert 'src="js/ads.js' in html


def test_con_le_variabili_si_usano_gli_id_veri():
    html = app_index(ADMOB_INTERSTITIAL_ID=LIVE_INTERSTITIAL, ADMOB_APP_OPEN_ID=LIVE_APP_OPEN)
    assert LIVE_INTERSTITIAL in html and LIVE_APP_OPEN in html
    assert TEST_INTERSTITIAL not in html and TEST_APP_OPEN not in html


def test_un_id_solo_e_un_errore():
    # Mezza build di prova e mezza vera non deve poter uscire.
    for env in ({"ADMOB_INTERSTITIAL_ID": LIVE_INTERSTITIAL}, {"ADMOB_APP_OPEN_ID": LIVE_APP_OPEN}):
        result = build("--app", **env)
        assert result.returncode != 0
        assert "insieme" in (result.stderr + result.stdout)


def test_id_malformati_sono_rifiutati():
    for bad in ("ca-app-pub-1/2", "<script>alert(1)</script>", LIVE_INTERSTITIAL + "x", '"; evil("'):
        result = build("--app", ADMOB_INTERSTITIAL_ID=bad, ADMOB_APP_OPEN_ID=LIVE_APP_OPEN)
        assert result.returncode != 0, f"accettato {bad!r}"


def test_lo_script_degli_id_e_nella_csp():
    html = app_index()
    body = re.search(r"<script>(window\.TRANS_ADS_IDS = .*?)</script>", html, re.S).group(1)
    digest = "'sha256-" + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode() + "'"
    csp = re.search(r'Content-Security-Policy" content="([^"]+)"', html).group(1)
    assert digest in csp, "lo script in linea con gli id non e' autorizzato dalla CSP"


def test_il_sito_web_non_ha_pubblicita():
    result = build()
    assert result.returncode == 0, result.stderr
    dist = ROOT / "site" / "dist"
    assert not (dist / "js" / "ads.js").exists()
    html = (dist / "index.html").read_text(encoding="utf-8")
    for marker in ("ads.js", "TRANS_ADS_IDS", "btnAdsPrivacy"):
        assert marker not in html, f"{marker} nel sito web"
    # Anche con le variabili impostate: il sito web le ignora.
    result = build(ADMOB_INTERSTITIAL_ID=LIVE_INTERSTITIAL, ADMOB_APP_OPEN_ID=LIVE_APP_OPEN)
    assert result.returncode == 0
    assert LIVE_INTERSTITIAL not in (dist / "index.html").read_text(encoding="utf-8")


def test_privacy_nel_sito_e_nell_app():
    assert build().returncode == 0
    web = (ROOT / "site" / "dist" / "index.html").read_text(encoding="utf-8")
    assert 'href="privacy.html"' in web
    assert (ROOT / "site" / "dist" / "privacy.html").exists()
    app = app_index()
    assert 'href="https://dantonioluigi.github.io/trans-card-game/privacy.html"' in app
    assert not (ROOT / "site" / "dist-app" / "privacy.html").exists()
