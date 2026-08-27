"""Calendario dei round e punteggio di TRANS."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .cards import TRUMP_SUIT, Suit

#: Carte distribuite nei tre round speciali.
SPECIAL_ROUND_CARDS = 7

#: Mano piu' lunga di un round normale.
MAX_NORMAL_CARDS = 7

#: Punti base per una scommessa indovinata, piu' 5 per ogni presa dichiarata.
HIT_BASE = 10
HIT_PER_TRICK = 5

#: Punti per presa quando la scommessa e' sbagliata.
MISS_PER_TRICK = 1

#: Penalita' per presa nel round A PERDERE.
MISERE_PER_TRICK = -5


class RoundKind(Enum):
    NORMAL = "normal"
    NO_TRUMP = "no_trump"
    BLIND = "blind"
    MISERE = "misere"

    @property
    def label(self) -> str:
        return {
            "normal": "Normale",
            "no_trump": "NO BRISCOLA",
            "blind": "BUIO",
            "misere": "A PERDERE",
        }[self.value]


@dataclass(frozen=True)
class RoundSpec:
    """Un round del calendario."""

    number: int  # 1-based
    cards: int
    kind: RoundKind

    @property
    def trump(self) -> Suit | None:
        """Cuori, tranne in NO BRISCOLA dove non c'e' briscola."""
        return None if self.kind is RoundKind.NO_TRUMP else TRUMP_SUIT

    @property
    def has_bidding(self) -> bool:
        """A PERDERE non si scommette: si cerca solo di non prendere."""
        return self.kind is not RoundKind.MISERE

    @property
    def blind_bidding(self) -> bool:
        """Nel BUIO si scommette senza aver visto le proprie carte."""
        return self.kind is RoundKind.BLIND

    @property
    def title(self) -> str:
        if self.kind is RoundKind.NORMAL:
            return f"{self.cards} carte"
        return f"{self.kind.label} · {self.cards} carte"


SPECIAL_SEQUENCE = (RoundKind.NO_TRUMP, RoundKind.BLIND, RoundKind.MISERE)


class GameMode(Enum):
    FAST = "fast"
    LONG = "long"

    @property
    def label(self) -> str:
        return {"fast": "Partita veloce (10 round)", "long": "Partita lunga (20 round)"}[self.value]


def _descending() -> list[tuple[int, RoundKind]]:
    return [(n, RoundKind.NORMAL) for n in range(MAX_NORMAL_CARDS, 0, -1)]


def _ascending() -> list[tuple[int, RoundKind]]:
    return [(n, RoundKind.NORMAL) for n in range(1, MAX_NORMAL_CARDS + 1)]


def _specials() -> list[tuple[int, RoundKind]]:
    return [(SPECIAL_ROUND_CARDS, kind) for kind in SPECIAL_SEQUENCE]


def build_schedule(mode: GameMode) -> list[RoundSpec]:
    """Sequenza dei round.

    Veloce  (10): 7,6,5,4,3,2,1 + NO BRISCOLA, BUIO, A PERDERE.
    Lunga   (20): come sopra, poi la risalita 1..7 e di nuovo i tre speciali.
    """
    plan = _descending() + _specials()
    if mode is GameMode.LONG:
        plan += _ascending() + _specials()
    return [RoundSpec(number=i + 1, cards=c, kind=k) for i, (c, k) in enumerate(plan)]


def score_round(kind: RoundKind, bid: int | None, tricks: int) -> int:
    """Punti guadagnati (o persi) da un giocatore alla fine di un round.

    - A PERDERE: -5 per ogni presa incassata.
    - Scommessa centrata: 10 + 5 x prese dichiarate (0->10, 1->15, 2->20, ...).
    - Scommessa sbagliata: 1 punto per ogni presa fatta.
    """
    if kind is RoundKind.MISERE:
        return MISERE_PER_TRICK * tricks
    if bid is not None and bid == tricks:
        return HIT_BASE + HIT_PER_TRICK * bid
    return MISS_PER_TRICK * tricks


def max_players_for(cards_each: int) -> int:
    return 52 // cards_each
