"""Registra partite giocate dal motore Python, per rigiocarle in JavaScript.

Le regole hanno una sola fonte di verita': ``trans/``. Questo script ne congela
il comportamento — mani distribuite, mosse legali offerte a ogni turno,
punteggi di ogni round — in un JSON che ``site/tests/run.mjs`` riesegue contro
``site/js/engine.js``. Se i due motori divergono, il confronto fallisce.

    python site/tests/make_fixtures.py
"""

from __future__ import annotations

import json
import pathlib
import random
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from trans import bots  # noqa: E402
from trans.engine import Game, Phase, Player  # noqa: E402
from trans.rules import GameMode, RoundKind, score_round  # noqa: E402

OUT = pathlib.Path(__file__).parent / "fixtures.json"


def record_game(n_players: int, mode: GameMode, seed: int) -> dict:
    players = [
        Player(id=f"p{i}", name=f"P{i}", is_bot=True, bot_level=["facile", "normale", "esperto"][i % 3])
        for i in range(n_players)
    ]
    game = Game(players, mode=mode, seed=seed)
    rng = random.Random(seed ^ 0xC0FFEE)

    def snapshot_hands() -> list[list[str]]:
        return [[c.code for c in p.hand] for p in game.players]

    rounds = []
    current = {"cards": game.spec.cards, "kind": game.spec.kind.value,
               "hands": snapshot_hands(), "actions": []}

    while not game.is_over:
        if game.phase is Phase.ROUND_OVER:
            current["rows"] = game.results[-1].rows
            rounds.append(current)
            game.advance_round()
            if game.is_over:
                break
            current = {"cards": game.spec.cards, "kind": game.spec.kind.value,
                       "hands": snapshot_hands(), "actions": []}
            continue

        actor = game.current_actor()
        assert actor is not None
        player_id = game.players[actor].id

        if game.phase is Phase.BIDDING:
            legal = game.legal_bids(actor)
            forbidden = game.forbidden_bid(actor)
            value = bots.choose_bid(game, actor, rng)
            current["actions"].append(
                {"kind": "bid", "player": player_id, "value": value,
                 "legal": legal, "forbidden": forbidden}
            )
            game.place_bid(player_id, value)
        else:
            legal = [c.code for c in game.legal_cards(actor)]
            card = bots.choose_card(game, actor, rng)
            current["actions"].append(
                {"kind": "play", "player": player_id, "card": card.code, "legal": legal}
            )
            game.play_card(player_id, card)

    return {
        "label": f"{n_players} giocatori · {mode.value} · seed {seed}",
        "mode": mode.value,
        "dealer": 0,
        "players": [{"id": p.id, "name": p.name} for p in game.players],
        "rounds": rounds,
        "final": [{"id": p.id, "score": p.score} for p in game.players],
    }


def scoring_table() -> list[dict]:
    """Ogni combinazione di punteggio, presa dal Python.

    Le partite registrate coprono quello che i bot capita di fare; questa
    tabella copre anche quello che non capita quasi mai — la luna dell'A
    PERDERE, per dirne una.
    """
    rows = []
    for kind in RoundKind:
        for cards in (1, 3, 5, 7):
            for tricks in range(cards + 1):
                bids = [None] if kind is RoundKind.MISERE else list(range(cards + 1))
                for bid in bids:
                    rows.append(
                        {
                            "kind": kind.value,
                            "bid": bid,
                            "tricks": tricks,
                            "cards": cards,
                            "score": score_round(kind, bid, tricks, cards),
                        }
                    )
    return rows


def main() -> None:
    games = []
    for n in (2, 3, 4, 5, 6, 7):
        games.append(record_game(n, GameMode.FAST, seed=100 + n))
    games.append(record_game(4, GameMode.LONG, seed=77))
    games.append(record_game(5, GameMode.LONG, seed=1234))

    scoring = scoring_table()
    OUT.write_text(json.dumps({"games": games, "scoring": scoring}, indent=1))
    actions = sum(len(r["actions"]) for g in games for r in g["rounds"])
    rounds = sum(len(g["rounds"]) for g in games)
    print(
        f"{len(games)} partite · {rounds} round · {actions} mosse "
        f"· {len(scoring)} punteggi → {OUT.name}"
    )


if __name__ == "__main__":
    main()
