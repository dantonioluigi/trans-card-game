"""Mazzo francese da 52 carte (niente jolly) usato da TRANS.

Ordine dei valori: 2 < 3 < ... < 10 < J < Q < K < A.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from enum import Enum


class Suit(Enum):
    HEARTS = "H"
    DIAMONDS = "D"
    CLUBS = "C"
    SPADES = "S"

    @property
    def symbol(self) -> str:
        return {"H": "♥", "D": "♦", "C": "♣", "S": "♠"}[self.value]

    @property
    def italian(self) -> str:
        return {"H": "cuori", "D": "quadri", "C": "fiori", "S": "picche"}[self.value]

    @property
    def is_red(self) -> bool:
        return self in (Suit.HEARTS, Suit.DIAMONDS)


#: La briscola di TRANS e' sempre cuori (tranne nel round NO BRISCOLA).
TRUMP_SUIT = Suit.HEARTS

MIN_RANK = 2
MAX_RANK = 14
RANKS = tuple(range(MIN_RANK, MAX_RANK + 1))

_RANK_LABELS = {11: "J", 12: "Q", 13: "K", 14: "A"}
_LABEL_RANKS = {v: k for k, v in _RANK_LABELS.items()}

# Ordine di visualizzazione dei semi in mano: briscola per prima, poi gli altri.
_DISPLAY_ORDER = (Suit.HEARTS, Suit.SPADES, Suit.DIAMONDS, Suit.CLUBS)


@dataclass(frozen=True)
class Card:
    rank: int
    suit: Suit

    def __post_init__(self) -> None:
        if self.rank not in RANKS:
            raise ValueError(f"valore carta non valido: {self.rank}")

    @property
    def rank_label(self) -> str:
        return _RANK_LABELS.get(self.rank, str(self.rank))

    @property
    def code(self) -> str:
        """Identificatore compatto, es. ``AH``, ``10S``, ``2C``."""
        return f"{self.rank_label}{self.suit.value}"

    @classmethod
    def from_code(cls, code: str) -> "Card":
        code = code.strip().upper()
        if len(code) < 2:
            raise ValueError(f"codice carta non valido: {code!r}")
        rank_part, suit_part = code[:-1], code[-1]
        try:
            suit = Suit(suit_part)
        except ValueError as exc:
            raise ValueError(f"seme non valido in {code!r}") from exc
        if rank_part in _LABEL_RANKS:
            rank = _LABEL_RANKS[rank_part]
        elif rank_part.isdigit():
            rank = int(rank_part)
        else:
            raise ValueError(f"valore non valido in {code!r}")
        return cls(rank=rank, suit=suit)

    def beats(self, other: "Card", lead_suit: Suit, trump: Suit | None) -> bool:
        """True se ``self`` batte ``other`` in una presa aperta da ``lead_suit``."""
        return _trick_key(self, lead_suit, trump) > _trick_key(other, lead_suit, trump)

    def __str__(self) -> str:
        return f"{self.rank_label}{self.suit.symbol}"

    def __repr__(self) -> str:
        return f"Card({self.code})"


def _trick_key(card: Card, lead_suit: Suit, trump: Suit | None) -> tuple[int, int]:
    """Chiave d'ordinamento: briscola > seme di uscita > scarto."""
    if trump is not None and card.suit is trump:
        tier = 2
    elif card.suit is lead_suit:
        tier = 1
    else:
        tier = 0
    return (tier, card.rank)


def trick_key(card: Card, lead_suit: Suit, trump: Suit | None) -> tuple[int, int]:
    """Alias pubblico di :func:`_trick_key`, usato dai bot per confrontare carte."""
    return _trick_key(card, lead_suit, trump)


def full_deck() -> list[Card]:
    """Le 52 carte, in ordine canonico."""
    return [Card(rank, suit) for suit in _DISPLAY_ORDER for rank in RANKS]


def shuffled_deck(rng: random.Random | None = None) -> list[Card]:
    deck = full_deck()
    (rng or random).shuffle(deck)
    return deck


def deal(n_players: int, cards_each: int, rng: random.Random | None = None) -> list[list[Card]]:
    """Distribuisce ``cards_each`` carte a testa da un mazzo mescolato.

    Le carte non distribuite restano fuori dal gioco: in TRANS non c'e' tallone.
    """
    needed = n_players * cards_each
    if needed > len(RANKS) * len(Suit):
        raise ValueError(
            f"servono {needed} carte ma il mazzo ne ha 52 "
            f"({n_players} giocatori x {cards_each} carte)"
        )
    deck = shuffled_deck(rng)
    return [sort_hand(deck[i * cards_each : (i + 1) * cards_each]) for i in range(n_players)]


def sort_hand(cards: list[Card]) -> list[Card]:
    """Ordina una mano per seme (briscola prima) e valore decrescente."""
    return sorted(cards, key=lambda c: (_DISPLAY_ORDER.index(c.suit), -c.rank))


def trick_winner(
    plays: list[tuple[int, Card]], trump: Suit | None
) -> int:
    """Indice del giocatore che vince la presa.

    ``plays`` e' la lista ordinata ``(player_index, card)`` di una presa completa.
    """
    if not plays:
        raise ValueError("presa vuota")
    lead_suit = plays[0][1].suit
    best_player, best_card = plays[0]
    for player, card in plays[1:]:
        if card.beats(best_card, lead_suit, trump):
            best_player, best_card = player, card
    return best_player
