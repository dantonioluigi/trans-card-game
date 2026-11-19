"""Il codice versione di Android, ricavato dal tag.

Play lo vuole piccolo (il tetto e' 2,1 miliardi) e crescente. Il test esegue il
vero passo "versione" di .github/workflows/android.yml con tag diversi.
"""

import os
import pathlib
import subprocess

import pytest

WORKFLOW = pathlib.Path(__file__).resolve().parents[1] / ".github" / "workflows" / "android.yml"
MAX_CODE = 2_100_000_000


def version_step() -> str:
    """Il corpo del passo 'versione', preso dal testo del workflow."""
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    start = lines.index("      - name: versione")
    run = next(i for i in range(start, len(lines)) if lines[i] == "        run: |")
    body = []
    for line in lines[run + 1:]:
        if line.strip() and not line.startswith(" " * 10):
            break
        body.append(line[10:] if line.strip() else "")
    return "\n".join(body)


def run_step(tmp_path, ref, run_number="7"):
    out = tmp_path / "output"
    out.write_text("")
    env = {
        "PATH": os.environ["PATH"],
        "GITHUB_REF": ref,
        "GITHUB_REF_NAME": ref.rsplit("/", 1)[-1],
        "GITHUB_RUN_NUMBER": run_number,
        "GITHUB_OUTPUT": str(out),
    }
    result = subprocess.run(["bash", "-c", version_step()], env=env, capture_output=True, text=True)
    values = dict(line.split("=", 1) for line in out.read_text().splitlines() if "=" in line)
    return result, values


@pytest.mark.parametrize("tag, name, code", [
    ("v1.1.0-rc1", "1.1.0-rc1", 1010001),
    ("v1.1.0-rc2", "1.1.0-rc2", 1010002),
    ("v1.1.0", "1.1.0", 1010099),
    ("v1.1.1-rc1", "1.1.1-rc1", 1010101),
    ("v1.2.0", "1.2.0", 1020099),
    ("v2.0.0", "2.0.0", 2000099),
    ("v1.0.0-rc10", "1.0.0-rc10", 1000010),
    ("v01.02.03", "01.02.03", 1020399),   # niente ottali: 08 e 09 non sono numeri validi in bash
    ("v1.08.09-rc08", "1.08.09-rc08", 1080908),
])
def test_il_codice_si_ricava_dal_tag(tmp_path, tag, name, code):
    result, values = run_step(tmp_path, f"refs/tags/{tag}")
    assert result.returncode == 0, result.stdout + result.stderr
    assert values["name"] == name
    assert int(values["code"]) == code
    assert int(values["code"]) <= MAX_CODE


def test_ogni_versione_vale_piu_della_precedente(tmp_path):
    order = ["v1.1.0-rc1", "v1.1.0-rc2", "v1.1.0-rc10", "v1.1.0", "v1.1.1-rc1", "v1.1.1", "v1.2.0-rc1", "v1.10.0", "v2.0.0-rc1"]
    codes = [int(run_step(tmp_path, f"refs/tags/{tag}")[1]["code"]) for tag in order]
    assert codes == sorted(codes) and len(set(codes)) == len(codes), codes


@pytest.mark.parametrize("tag", [
    "v1.0.0-beta1", "v1.0.0-rc", "v1.0.0-rc0", "v1.0.0-rc99", "v1.100.0", "v1.0.100", "v2001.0.0",
    "v1.0", "v1.0.0.0", "v1.0.0-rc1.2", "v1.0.0;rm", "v1.0.0-rc1$(id)",
])
def test_i_tag_non_validi_fermano_la_build(tmp_path, tag):
    result, values = run_step(tmp_path, f"refs/tags/{tag}")
    assert result.returncode != 0, f"{tag} accettato con codice {values.get('code')}"
    assert "code" not in values


def test_senza_tag_il_codice_e_il_numero_dell_esecuzione(tmp_path):
    result, values = run_step(tmp_path, "refs/heads/main", run_number="42")
    assert result.returncode == 0
    assert values == {"name": "0.0.0-dev.42", "code": "42"}


def test_il_vecchio_schema_a_base_di_orologio_non_c_e_piu():
    assert "date +%s" not in WORKFLOW.read_text(encoding="utf-8")
