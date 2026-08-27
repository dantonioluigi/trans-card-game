"""Bot per TRANS.

Tre livelli:

- ``facile``   mosse legali a caso, scommessa approssimata;
- ``normale``  scommessa stimata con playout Monte Carlo, gioco euristico;
- ``esperto``  piu' simulazioni e conteggio delle carte gia' uscite.
"""

from __future__ import annotations

import random

from .cards import Card, Suit, full_deck, trick_key
from .engine import Game, Phase
from .rules import RoundKind

LEVELS = ("facile", "normale", "esperto")

_SAMPLES = {"facile": 0, "normale": 40, "esperto": 140}


# --------------------------------------------------------------------- utils


def _best_in_trick(trick: list[tuple[int, Card]], trump: Suit | None) -> tuple[int, Card] | None:
    if not trick:
        return None
    lead = trick[0][1].suit
    return max(trick, key=lambda pc: trick_key(pc[1], lead, trump))


def _currently_wins(card: Card, trick: list[tuple[int, Card]], trump: Suit | None) -> bool:
    """True se la carta batte tutto quello che c'e' gia' sul tavolo."""
    best = _best_in_trick(trick, trump)
    if best is None:
        return True  # apre lui la presa
    lead = trick[0][1].suit
    return card.beats(best[1], lead, trump)


def _strength(card: Card, lead: Suit | None, trump: Suit | None) -> tuple[int, int]:
    return trick_key(card, lead or card.suit, trump)


# ------------------------------------------------------------------ scommessa


def _greedy_playout(
    hands: list[list[Card]], leader: int, trump: Suit | None, rng: random.Random
) -> list[int]:
    """Gioca una mano intera con una politica rozza ma simmetrica.

    Ogni giocatore prende la presa se puo' farlo a poco prezzo, altrimenti
    scarta la carta piu' bassa. Serve solo a stimare quante prese vale una mano.
    """
    n = len(hands)
    tricks = [0] * n
    hands = [list(h) for h in hands]
    while hands[leader]:
        trick: list[tuple[int, Card]] = []
        for step in range(n):
            p = (leader + step) % n
            hand = hands[p]
            lead = trick[0][1].suit if trick else None
            legal = [c for c in hand if c.suit is lead] if lead else list(hand)
            if not legal:
                legal = list(hand)
            winners = [c for c in legal if _currently_wins(c, trick, trump)]
            if winners:
                card = min(winners, key=lambda c: _strength(c, lead, trump))
            else:
                card = min(legal, key=lambda c: _strength(c, lead, trump))
            hand.remove(card)
            trick.append((p, card))
        best = _best_in_trick(trick, trump)
        assert best is not None
        leader = best[0]
        tricks[leader] += 1
    return tricks


def estimate_tricks(
    hand: list[Card],
    n_players: int,
    trump: Suit | None,
    unseen: list[Card],
    samples: int,
    rng: random.Random,
) -> float:
    """Numero medio di prese che questa mano porta a casa, via Monte Carlo."""
    if not hand or samples <= 0:
        return len(hand) / max(n_players, 1)
    cards_each = len(hand)
    total = 0
    for _ in range(samples):
        pool = list(unseen)
        rng.shuffle(pool)
        hands = [list(hand)]
        ok = True
        for i in range(n_players - 1):
            chunk = pool[i * cards_each : (i + 1) * cards_each]
            if len(chunk) < cards_each:
                ok = False
                break
            hands.append(chunk)
        if not ok:
            return len(hand) / max(n_players, 1)
        total += _greedy_playout(hands, leader=0, trump=trump, rng=rng)[0]
    return total / samples


def choose_bid(game: Game, player_index: int, rng: random.Random | None = None) -> int:
    rng = rng or random.Random()
    player = game.players[player_index]
    spec = game.spec
    level = player.bot_level if player.bot_level in LEVELS else "normale"

    if spec.blind_bidding:
        # Al buio non si vede niente: si punta sulla quota equa, con un filo di varianza.
        fair = spec.cards / game.n
        guess = int(round(fair + rng.uniform(-0.6, 0.6)))
        return max(0, min(spec.cards, guess))

    if level == "facile":
        options = game.legal_bids(player_index)
        naive = max(0, min(spec.cards, int(round(spec.cards / game.n))))
        pool = [b for b in options if abs(b - naive) <= 1] or options
        return rng.choice(pool)

    unseen = [c for c in full_deck() if c not in player.hand]
    expected = estimate_tricks(
        player.hand, game.n, game.trump, unseen, _SAMPLES[level], rng
    )
    bid = int(round(expected))
    options = game.legal_bids(player_index)
    if bid not in options:
        bid = min(options, key=lambda b: (abs(b - expected), b))
    return bid


# ---------------------------------------------------------------------- gioco


def _wants_trick(game: Game, player_index: int) -> bool:
    """Se al bot conviene prendere questa presa."""
    spec = game.spec
    player = game.players[player_index]
    if spec.kind is RoundKind.MISERE:
        return False
    if player.bid is None:
        return False
    needed = player.bid - player.tricks
    remaining = len(player.hand)
    if needed <= 0:
        # Scommessa gia' raggiunta: prendere ancora la fa saltare.
        # Se e' gia' saltata, ogni presa in piu' vale comunque 1 punto.
        return needed < 0
    if needed > remaining:
        # Impossibile centrarla: tanto vale raccogliere punti da 1.
        return True
    return True


def _unseen_cards(game: Game, player_index: int) -> list[Card]:
    known = set(game.players[player_index].hand) | set(game.played_cards)
    known |= {c for _, c in game.current_trick}
    return [c for c in full_deck() if c not in known]


def choose_card(game: Game, player_index: int, rng: random.Random | None = None) -> Card:
    rng = rng or random.Random()
    legal = game.legal_cards(player_index)
    if not legal:
        raise RuntimeError("nessuna carta giocabile")
    if len(legal) == 1:
        return legal[0]

    player = game.players[player_index]
    level = player.bot_level if player.bot_level in LEVELS else "normale"
    if level == "facile":
        return rng.choice(legal)

    trump = game.trump
    trick = game.current_trick
    lead = game.lead_suit
    want = _wants_trick(game, player_index)
    last_to_play = len(trick) == game.n - 1

    if not trick:
        return _lead_card(game, player_index, legal, want, level, rng)

    winners = [c for c in legal if _currently_wins(c, trick, trump)]
    losers = [c for c in legal if c not in winners]

    if want:
        if not winners:
            return min(legal, key=lambda c: _strength(c, lead, trump))
        if last_to_play:
            return min(winners, key=lambda c: _strength(c, lead, trump))
        # Restano giocatori dopo di noi: serve una carta che regga davvero.
        safe = [c for c in winners if _is_safe(c, game, player_index, level)]
        pool = safe or winners
        return min(pool, key=lambda c: _strength(c, lead, trump))

    # Vogliamo perdere la presa: scarichiamo la carta piu' alta che non prende.
    if losers:
        return max(losers, key=lambda c: _strength(c, lead, trump))
    return max(legal, key=lambda c: _strength(c, lead, trump))


def _is_safe(card: Card, game: Game, player_index: int, level: str) -> bool:
    """La carta batte tutto quello che gli avversari possono ancora avere?"""
    if level != "esperto":
        return card.rank >= 12 or (game.trump is not None and card.suit is game.trump)
    trump = game.trump
    lead = game.lead_suit or card.suit
    threshold = trick_key(card, lead, trump)
    for other in _unseen_cards(game, player_index):
        if trick_key(other, lead, trump) > threshold:
            return False
    return True


def _lead_card(
    game: Game, player_index: int, legal: list[Card], want: bool, level: str, rng: random.Random
) -> Card:
    """Scelta della carta di uscita."""
    trump = game.trump
    if want:
        if level == "esperto":
            sure = [c for c in legal if _is_safe(c, game, player_index, level)]
            if sure:
                return max(sure, key=lambda c: _strength(c, c.suit, trump))
        non_trump_high = [c for c in legal if trump is None or c.suit is not trump]
        if non_trump_high and max(c.rank for c in non_trump_high) >= 13:
            return max(non_trump_high, key=lambda c: c.rank)
        return max(legal, key=lambda c: _strength(c, c.suit, trump))

    # Uscire perdendo: seme lungo e carta bassa, evitando la briscola.
    side = [c for c in legal if trump is None or c.suit is not trump]
    pool = side or legal
    return min(pool, key=lambda c: (c.rank, _strength(c, c.suit, trump)))


# ------------------------------------------------------------------- driver


def act(game: Game, player_index: int, rng: random.Random | None = None) -> dict:
    """Fa muovere il bot di turno e descrive la mossa (per il log della UI)."""
    player = game.players[player_index]
    if game.phase is Phase.BIDDING:
        bid = choose_bid(game, player_index, rng)
        game.place_bid(player.id, bid)
        return {"action": "bid", "value": bid}
    if game.phase is Phase.PLAYING:
        card = choose_card(game, player_index, rng)
        game.play_card(player.id, card)
        return {"action": "play", "card": card.code}
    raise RuntimeError(f"il bot non puo' agire in fase {game.phase}")
