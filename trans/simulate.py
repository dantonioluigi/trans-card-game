"""Auto-partite fra bot: serve a validare l'engine e a confrontare i livelli.

    python -m trans.simulate --games 200 --levels normale esperto facile
"""

from __future__ import annotations

import argparse
import random
from collections import Counter, defaultdict

from . import bots
from .engine import Game, Phase, Player
from .rules import GameMode, RoundKind


def play_one(levels: list[str], mode: GameMode, seed: int) -> Game:
    players = [
        Player(id=f"p{i}", name=f"{lvl}-{i}", is_bot=True, bot_level=lvl)
        for i, lvl in enumerate(levels)
    ]
    game = Game(players, mode=mode, seed=seed)
    rng = random.Random(seed ^ 0x5EED)
    guard = 0
    while not game.is_over:
        guard += 1
        if guard > 100_000:
            raise RuntimeError("partita bloccata")
        if game.phase is Phase.ROUND_OVER:
            game.advance_round()
            continue
        actor = game.current_actor()
        assert actor is not None
        bots.act(game, actor, rng)
    return game


def main() -> None:
    ap = argparse.ArgumentParser(description="Simula partite di TRANS fra bot")
    ap.add_argument("--games", type=int, default=100)
    ap.add_argument("--levels", nargs="+", default=["normale", "normale", "esperto", "facile"])
    ap.add_argument("--mode", choices=[m.value for m in GameMode], default="fast")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    mode = GameMode(args.mode)
    wins: Counter[str] = Counter()
    points: defaultdict[str, int] = defaultdict(int)
    hit_rate: defaultdict[str, list[int]] = defaultdict(list)

    for g in range(args.games):
        game = play_one(args.levels, mode, seed=args.seed + g)
        best = max(p.score for p in game.players)
        for p in game.players:
            points[p.name] += p.score
            if p.score == best:
                wins[p.name] += 1
        for result in game.results:
            if result.kind is RoundKind.MISERE:
                continue
            for row in result.rows:
                hit_rate[row["name"]].append(int(row["bid"] == row["tricks"]))

    print(f"{args.games} partite · {mode.label} · {len(args.levels)} giocatori\n")
    print(f"{'giocatore':<14}{'vittorie':>10}{'punti medi':>13}{'scommesse ok':>15}")
    for p in sorted(points, key=lambda n: -points[n]):
        hits = hit_rate[p]
        pct = 100 * sum(hits) / len(hits) if hits else 0.0
        print(f"{p:<14}{wins[p]:>10}{points[p] / args.games:>13.1f}{pct:>14.1f}%")


if __name__ == "__main__":
    main()
