"""TRANS — engine di gioco, regole e bot."""

from .cards import Card, Suit, TRUMP_SUIT
from .engine import Game, IllegalMove, Phase, Player
from .rules import GameMode, RoundKind, RoundSpec, build_schedule, score_round

__all__ = [
    "Card",
    "Suit",
    "TRUMP_SUIT",
    "Game",
    "IllegalMove",
    "Phase",
    "Player",
    "GameMode",
    "RoundKind",
    "RoundSpec",
    "build_schedule",
    "score_round",
]
