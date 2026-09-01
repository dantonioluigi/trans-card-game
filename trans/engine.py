"""Macchina a stati di una partita di TRANS.

L'engine e' puro: nessuna dipendenza da rete o UI, e deterministico a parita'
di seed. Il server ci costruisce sopra il multiplayer, i bot ci girano contro.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from enum import Enum

from .cards import Card, Suit, deal, sort_hand, trick_winner
from .rules import GameMode, RoundKind, RoundSpec, build_schedule, max_players_for, score_round

MIN_PLAYERS = 2
MAX_PLAYERS = 6


class Phase(Enum):
    BIDDING = "bidding"
    PLAYING = "playing"
    ROUND_OVER = "round_over"
    GAME_OVER = "game_over"


class IllegalMove(Exception):
    """Mossa rifiutata dalle regole (turno sbagliato, carta non giocabile, ...)."""


@dataclass
class Player:
    id: str
    name: str
    is_bot: bool = False
    bot_level: str = "normale"
    score: int = 0
    hand: list[Card] = field(default_factory=list)
    bid: int | None = None
    tricks: int = 0


@dataclass
class RoundResult:
    round_number: int
    kind: RoundKind
    rows: list[dict]  # {player_id, name, bid, tricks, delta, total}


class Game:
    def __init__(
        self,
        players: list[Player],
        mode: GameMode = GameMode.FAST,
        seed: int | None = None,
        dealer: int = 0,
        forbid_exact_total: bool = True,
    ) -> None:
        if not MIN_PLAYERS <= len(players) <= MAX_PLAYERS:
            raise ValueError(f"servono da {MIN_PLAYERS} a {MAX_PLAYERS} giocatori")
        if len(players) > max_players_for(7):
            raise ValueError("troppi giocatori per un mazzo da 52 carte")
        if len({p.id for p in players}) != len(players):
            raise ValueError("id giocatori duplicati")

        self.players = players
        self.mode = mode
        self.schedule: list[RoundSpec] = build_schedule(mode)
        self.rng = random.Random(seed)
        self.seed = seed
        # Regola dell'impiccato: l'ultimo a parlare non puo' pareggiare il conto,
        # cosi' almeno un giocatore sbaglia per forza la dichiarazione.
        self.forbid_exact_total = forbid_exact_total

        self.round_index = 0
        self.dealer = dealer % len(players)
        self.turn = 0
        self.phase = Phase.BIDDING
        self.current_trick: list[tuple[int, Card]] = []
        self.last_trick: dict | None = None
        self.played_cards: list[Card] = []
        self.results: list[RoundResult] = []
        self.log: list[str] = []

        self._start_round()

    # ------------------------------------------------------------------ info

    @property
    def n(self) -> int:
        return len(self.players)

    @property
    def spec(self) -> RoundSpec:
        return self.schedule[self.round_index]

    @property
    def trump(self) -> Suit | None:
        return self.spec.trump

    @property
    def is_over(self) -> bool:
        return self.phase is Phase.GAME_OVER

    def index_of(self, player_id: str) -> int:
        for i, p in enumerate(self.players):
            if p.id == player_id:
                return i
        raise KeyError(player_id)

    def current_actor(self) -> int | None:
        """Indice del giocatore che deve muovere, o None se non tocca a nessuno."""
        if self.phase in (Phase.BIDDING, Phase.PLAYING):
            return self.turn
        return None

    def hand_visible_to_owner(self) -> bool:
        """Nel BUIO le proprie carte restano coperte finche' non si e' scommesso."""
        return not (self.spec.blind_bidding and self.phase is Phase.BIDDING)

    # ------------------------------------------------------------------ setup

    def _start_round(self) -> None:
        spec = self.spec
        hands = deal(self.n, spec.cards, self.rng)
        for player, hand in zip(self.players, hands):
            player.hand = hand
            player.bid = None
            player.tricks = 0
        self.current_trick = []
        self.last_trick = None
        self.played_cards = []
        self.turn = (self.dealer + 1) % self.n
        self.phase = Phase.BIDDING if spec.has_bidding else Phase.PLAYING
        self._log(f"Round {spec.number}/{len(self.schedule)} — {spec.title}")
        if not spec.has_bidding:
            self._log("A PERDERE: nessuna scommessa, ogni presa vale -5.")

    def _log(self, message: str) -> None:
        self.log.append(message)
        del self.log[:-200]

    # -------------------------------------------------------------- scommesse

    def legal_bids(self, player_index: int) -> list[int]:
        if self.phase is not Phase.BIDDING or player_index != self.turn:
            return []
        forbidden = self.forbidden_bid(player_index)
        return [b for b in range(self.spec.cards + 1) if b != forbidden]

    def forbidden_bid(self, player_index: int) -> int | None:
        """La dichiarazione vietata all'ultimo a parlare, se ce n'e' una.

        La somma delle dichiarazioni non puo' fare esattamente il numero di
        prese in palio: chi chiude il giro deve sbilanciare il conto.
        """
        if not self.forbid_exact_total or not self._is_last_bidder(player_index):
            return None
        declared = sum(p.bid for p in self.players if p.bid is not None)
        forbidden = self.spec.cards - declared
        return forbidden if 0 <= forbidden <= self.spec.cards else None

    def _is_last_bidder(self, player_index: int) -> bool:
        """Si parla da sinistra del mazziere, quindi il mazziere chiude."""
        return player_index == self.dealer

    def place_bid(self, player_id: str, value: int) -> None:
        idx = self.index_of(player_id)
        if self.phase is not Phase.BIDDING:
            raise IllegalMove("non e' il momento di scommettere")
        if idx != self.turn:
            raise IllegalMove("non e' il tuo turno di scommettere")
        if value == self.forbidden_bid(idx):
            raise IllegalMove(
                f"chiudi tu il giro: con {value} la somma farebbe esattamente "
                f"{self.spec.cards}, e non e' permesso"
            )
        if value not in self.legal_bids(idx):
            raise IllegalMove(f"scommessa non valida: {value}")

        player = self.players[idx]
        player.bid = value
        self._log(f"{player.name} scommette {value}.")

        if all(p.bid is not None for p in self.players):
            self.phase = Phase.PLAYING
            self.turn = (self.dealer + 1) % self.n
            total = sum(p.bid or 0 for p in self.players)
            self._log(f"Scommesse chiuse: {total} prese dichiarate su {self.spec.cards}.")
        else:
            self.turn = (self.turn + 1) % self.n

    # ------------------------------------------------------------------ gioco

    @property
    def lead_suit(self) -> Suit | None:
        return self.current_trick[0][1].suit if self.current_trick else None

    def legal_cards(self, player_index: int) -> list[Card]:
        """Obbligo di rispondere al seme; se non lo hai, giochi quello che vuoi."""
        if self.phase is not Phase.PLAYING or player_index != self.turn:
            return []
        hand = self.players[player_index].hand
        lead = self.lead_suit
        if lead is None:
            return list(hand)
        same_suit = [c for c in hand if c.suit is lead]
        return same_suit or list(hand)

    def play_card(self, player_id: str, card: Card) -> None:
        idx = self.index_of(player_id)
        if self.phase is not Phase.PLAYING:
            raise IllegalMove("non e' il momento di giocare una carta")
        if idx != self.turn:
            raise IllegalMove("non e' il tuo turno")
        player = self.players[idx]
        if card not in player.hand:
            raise IllegalMove(f"non hai {card} in mano")
        if card not in self.legal_cards(idx):
            lead = self.lead_suit
            raise IllegalMove(
                f"devi rispondere a {lead.italian}" if lead else "carta non giocabile"
            )

        player.hand.remove(card)
        self.current_trick.append((idx, card))
        self.played_cards.append(card)
        self._log(f"{player.name} gioca {card}.")

        if len(self.current_trick) == self.n:
            self._resolve_trick()
        else:
            self.turn = (self.turn + 1) % self.n

    def _resolve_trick(self) -> None:
        winner = trick_winner(self.current_trick, self.trump)
        self.players[winner].tricks += 1
        self.last_trick = {
            "plays": [{"player": i, "card": c.code} for i, c in self.current_trick],
            "winner": winner,
        }
        self._log(f"Presa a {self.players[winner].name}.")
        self.current_trick = []
        self.turn = winner
        if not any(p.hand for p in self.players):
            self._end_round()

    # ---------------------------------------------------------- fine round

    def _end_round(self) -> None:
        spec = self.spec
        rows = []
        for player in self.players:
            delta = score_round(spec.kind, player.bid, player.tricks, spec.cards)
            player.score += delta
            rows.append(
                {
                    "player_id": player.id,
                    "name": player.name,
                    "bid": player.bid,
                    "tricks": player.tricks,
                    "delta": delta,
                    "total": player.score,
                }
            )
        self.results.append(RoundResult(spec.number, spec.kind, rows))
        self.phase = Phase.ROUND_OVER
        summary = ", ".join(f"{r['name']} {r['delta']:+d}" for r in rows)
        self._log(f"Fine round {spec.number}: {summary}.")

    def advance_round(self) -> None:
        """Passa al round successivo (o chiude la partita)."""
        if self.phase is not Phase.ROUND_OVER:
            raise IllegalMove("il round non e' finito")
        if self.round_index + 1 >= len(self.schedule):
            self.phase = Phase.GAME_OVER
            self._log(f"Partita finita. Vince {self.winner_names()}.")
            return
        self.round_index += 1
        self.dealer = (self.dealer + 1) % self.n
        self._start_round()

    def standings(self) -> list[Player]:
        return sorted(self.players, key=lambda p: -p.score)

    def winner_names(self) -> str:
        best = max(p.score for p in self.players)
        names = [p.name for p in self.players if p.score == best]
        return " e ".join(names) + f" ({best} punti)"

    # ------------------------------------------------------------ snapshot

    def snapshot(self, viewer_id: str | None = None) -> dict:
        """Stato serializzabile, con la mano visibile solo al proprietario."""
        viewer = None
        if viewer_id is not None:
            try:
                viewer = self.index_of(viewer_id)
            except KeyError:
                viewer = None

        spec = self.spec
        players = [
            {
                "id": p.id,
                "name": p.name,
                "is_bot": p.is_bot,
                "bot_level": p.bot_level if p.is_bot else None,
                "score": p.score,
                "bid": p.bid,
                "tricks": p.tricks,
                "cards_left": len(p.hand),
                "is_dealer": i == self.dealer,
                "is_turn": self.current_actor() == i,
            }
            for i, p in enumerate(self.players)
        ]

        hand: list[str] = []
        legal_cards: list[str] = []
        legal_bids: list[int] = []
        forbidden_bid: int | None = None
        if viewer is not None:
            if self.hand_visible_to_owner():
                hand = [c.code for c in sort_hand(self.players[viewer].hand)]
            legal_cards = [c.code for c in self.legal_cards(viewer)]
            legal_bids = self.legal_bids(viewer)
            forbidden_bid = self.forbidden_bid(viewer)

        return {
            "phase": self.phase.value,
            "mode": self.mode.value,
            "round": {
                "number": spec.number,
                "total": len(self.schedule),
                "cards": spec.cards,
                "kind": spec.kind.value,
                "kind_label": spec.kind.label,
                "title": spec.title,
                "trump": spec.trump.value if spec.trump else None,
                "blind": spec.blind_bidding,
                "has_bidding": spec.has_bidding,
            },
            "players": players,
            "you": viewer,
            "hand": hand,
            "hand_hidden": viewer is not None and not self.hand_visible_to_owner(),
            "legal_cards": legal_cards,
            "legal_bids": legal_bids,
            "forbidden_bid": forbidden_bid,
            "trick": [{"player": i, "card": c.code} for i, c in self.current_trick],
            "lead_suit": self.lead_suit.value if self.lead_suit else None,
            "played": [c.code for c in self.played_cards],
            "last_trick": self.last_trick,
            "last_result": (
                {"round": self.results[-1].round_number, "rows": self.results[-1].rows}
                if self.results
                else None
            ),
            "standings": [{"id": p.id, "name": p.name, "score": p.score} for p in self.standings()],
            "schedule": [
                {"number": s.number, "cards": s.cards, "kind": s.kind.value, "title": s.title}
                for s in self.schedule
            ],
            "round_index": self.round_index,
            "log": self.log[-40:],
            "winner": self.winner_names() if self.is_over else None,
        }
