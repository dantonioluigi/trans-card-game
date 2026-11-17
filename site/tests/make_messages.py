"""Estrae dal codice le frasi italiane che il client deve saper tradurre.

Le scrivono i motori (JS e Python), il tavolo e la rete: sono italiano dentro
il codice, che resta com'e'. Il client le traduce con una tabella in
web/i18n.js, e site/tests/i18n.mjs pretende che ogni frase trovata qui abbia la
sua traduzione. Se aggiungi o cambi una frase, rigenera il file:

    python site/tests/make_messages.py

CI controlla che messages.json sia aggiornato, come per le partite registrate.
"""

import ast
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path(__file__).with_name("messages.json")

PY_FILES = ["trans/engine.py", "server/room.py", "server/main.py"]
JS_FILES = ["site/js/engine.js", "site/js/room.js", "site/js/net-p2p.js"]

#: Chi scrive una frase che finisce davanti a un giocatore.
PY_CALLS = {"IllegalMove", "RoomError", "_fail", "_log"}
JS_CALLS = r"(?:IllegalMove|TableError|_log|kick|deliver|post)"


def sample(expr: str) -> str:
    """Un valore plausibile per un pezzo variabile, secondo come si chiama."""
    e = expr.lower()
    if "card" in e and "cards" not in e:
        return "7H"
    if "name" in e or e.strip() in {"was", "who"}:
        return "Anna"
    if "italian" in e or "suit" in e or "lead" in e:
        return "cuori"
    if "level" in e:
        return "facile"
    if "summary" in e:
        return "Anna +10, Bob -3"
    if "title" in e:
        return "5 carte"
    if "code" in e or "shown" in e:
        return "ABCD"
    if "type" in e:
        return "foo"
    return "7"


def py_strings(node: ast.AST) -> list[str]:
    """Le frasi dentro un argomento: ogni f-string e' una frase intera, non i suoi pezzi."""
    if isinstance(node, ast.JoinedStr):
        parts = []
        for value in node.values:
            if isinstance(value, ast.Constant):
                parts.append(str(value.value))
            elif isinstance(value, ast.FormattedValue):
                parts.append(sample(ast.unparse(value.value)))
        return ["".join(parts)]
    if isinstance(node, ast.Constant):
        return [node.value] if isinstance(node.value, str) else []
    found: list[str] = []
    for child in ast.iter_child_nodes(node):
        found += py_strings(child)
    return found


def from_python(path: str) -> list[str]:
    tree = ast.parse((ROOT / path).read_text(encoding="utf-8"))
    out: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else ""
        if name in PY_CALLS:
            for arg in node.args:
                out += py_strings(arg)
    return out


def js_literal(text: str) -> str:
    """Il contenuto di un letterale JS, con ${...} sostituiti da un valore plausibile."""
    return re.sub(r"\$\{([^}]*)\}", lambda m: sample(m.group(1)), text)


def from_javascript(path: str) -> list[str]:
    source = (ROOT / path).read_text(encoding="utf-8")
    out: list[str] = []
    call = re.compile(JS_CALLS + r"\(\s*(?:[A-Za-z_.]+,\s*)?(`[^`]*`|\"[^\"]*\")")
    for match in call.finditer(source):
        out.append(js_literal(match.group(1)[1:-1]))
    # { type: "error", message: "..." }, { fatal: true, message: "..." }, ... ? "..." : "..."
    for match in re.finditer(r"message:\s*(`[^`]*`|\"[^\"]*\")", source):
        out.append(js_literal(match.group(1)[1:-1]))
    # err.message || "mossa non valida"
    for match in re.finditer(r"\|\|\s*(\"[^\"]+\")", source):
        out.append(js_literal(match.group(1)[1:-1]))
    # return "questo browser non supporta WebRTC";
    if path.endswith("net-p2p.js"):
        for match in re.finditer(r"return\s+(\"[^\"]+\");", source):
            out.append(js_literal(match.group(1)[1:-1]))
    return out


def main() -> None:
    messages: dict[str, set[str]] = {}
    for path in PY_FILES:
        for text in from_python(path):
            messages.setdefault(text, set()).add(path)
    for path in JS_FILES:
        for text in from_javascript(path):
            messages.setdefault(text, set()).add(path)

    # Solo frasi per persone: niente identificatori o nomi di campi.
    rows = [
        {"text": text, "src": sorted(srcs)}
        for text, srcs in sorted(messages.items())
        if (" " in text or text.isupper()) and re.search(r"[A-Za-zà-ÿ]{2,}", text)
    ]
    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)}: {len(rows)} frasi")


if __name__ == "__main__":
    main()
