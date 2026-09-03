import random

import pytest

from trans import bots
from trans.cards import Card, Suit
from trans.engine import Game, IllegalMove, Phase, Player
from trans.rules import GameMode, RoundKind


def C(code: str) -> Card:
    return Card.from_code(code)


def make_game(n=4, mode=GameMode.FAST, seed=42, **kw) -> Game:
    players = [Player(id=f"p{i}", name=f"P{i}") for i in range(n)]
    return Game(players, mode=mode, seed=seed, **kw)


def set_hands(game: Game, hands: dict[str, list[str]]) -> None:
    for pid, codes in hands.items():
        game.players[game.index_of(pid)].hand = [C(c) for c in codes]


def bid_all(game: Game, values: list[int]) -> None:
    """Scommette in ordine di turno partendo da chi tocca."""
    for value in values:
        actor = game.current_actor()
        assert actor is not None
        game.place_bid(game.players[actor].id, value)


# ----------------------------------------------------------------- struttura


def test_game_rejects_wrong_player_counts():
    with pytest.raises(ValueError):
        Game([Player(id="p0", name="solo")])
    with pytest.raises(ValueError):
        Game([Player(id=f"p{i}", name=str(i)) for i in range(7)])


def test_first_round_deals_seven_cards_each_and_bidding_starts_left_of_dealer():
    game = make_game(n=4)
    assert game.phase is Phase.BIDDING
    assert all(len(p.hand) == 7 for p in game.players)
    assert game.dealer == 0
    assert game.current_actor() == 1


def test_dealer_rotates_between_rounds():
    game = make_game(n=3)
    dealers = [game.dealer]
    for _ in range(3):
        finish_round_with_bots(game)
        game.advance_round()
        dealers.append(game.dealer)
    assert dealers == [0, 1, 2, 0]


# ---------------------------------------------------------------- scommesse


def test_bids_are_taken_in_turn_order_only():
    game = make_game(n=3)
    with pytest.raises(IllegalMove):
        game.place_bid("p0", 2)  # tocca a p1
    game.place_bid("p1", 2)
    assert game.current_actor() == 2


def test_bid_must_be_within_the_hand_size():
    game = make_game(n=3)
    with pytest.raises(IllegalMove):
        game.place_bid("p1", 8)
    with pytest.raises(IllegalMove):
        game.place_bid("p1", -1)


def test_play_is_blocked_until_everyone_has_bid():
    game = make_game(n=3)
    card = game.players[1].hand[0]
    with pytest.raises(IllegalMove):
        game.play_card("p1", card)
    bid_all(game, [1, 1, 1])
    assert game.phase is Phase.PLAYING
    assert game.current_actor() == 1


def test_the_last_bidder_cannot_make_the_total_exact():
    game = make_game(n=3)
    bid_all(game, [3, 2])  # p1 e p2, restano 2 prese sulle 7
    assert game.current_actor() == 0  # il mazziere chiude il giro
    assert game.forbidden_bid(0) == 2
    assert 2 not in game.legal_bids(0)
    with pytest.raises(IllegalMove, match="somma"):
        game.place_bid("p0", 2)
    game.place_bid("p0", 1)
    assert game.phase is Phase.PLAYING


def test_five_players_one_trick_each_leaves_the_last_one_stuck():
    """Il caso raccontato dall'utente: in cinque, con un round da 5 carte."""
    game = make_game(n=5)
    while game.spec.cards != 5:
        finish_round_with_bots(game)
        game.advance_round()
    bid_all(game, [1, 1, 1, 1])  # i primi quattro dicono 1: siamo a 4 su 5
    assert game.forbidden_bid(game.dealer) == 1
    assert game.legal_bids(game.dealer) == [0, 2, 3, 4, 5]
    with pytest.raises(IllegalMove):
        game.place_bid(game.players[game.dealer].id, 1)


def test_the_rule_binds_only_whoever_speaks_last():
    game = make_game(n=4)
    for i in range(4):
        # il mazziere e' p0, quindi parla per ultimo
        assert (game.forbidden_bid(i) is not None) == (i == game.dealer)


def test_no_forbidden_bid_when_the_total_is_already_impossible():
    game = make_game(n=3)
    bid_all(game, [7, 3])  # gia' 10 dichiarate su 7: nessun numero pareggia
    assert game.forbidden_bid(0) is None
    assert game.legal_bids(0) == [0, 1, 2, 3, 4, 5, 6, 7]


def test_the_declared_total_never_matches_the_tricks_in_play():
    """Vale in tutti i round dichiarati, buio compreso."""
    game = make_game(n=4, mode=GameMode.LONG, seed=3)
    checked = 0
    while not game.is_over:
        if game.phase is Phase.ROUND_OVER:
            game.advance_round()
            continue
        spec = game.spec
        finish_round_with_bots(game)
        if spec.has_bidding:
            assert sum(p.bid for p in game.players) != spec.cards
            checked += 1
    assert checked == 18  # 20 round meno i due A PERDERE


def test_the_rule_can_be_switched_off():
    game = make_game(n=3, forbid_exact_total=False)
    bid_all(game, [3, 2])
    assert game.forbidden_bid(0) is None
    game.place_bid("p0", 2)
    assert sum(p.bid for p in game.players) == 7


# ------------------------------------------------------------------- gioco


def test_must_follow_the_lead_suit_when_possible():
    game = make_game(n=2)
    bid_all(game, [1, 1])
    set_hands(game, {"p1": ["AS", "2S", "3H"], "p0": ["KS", "4D", "5H"]})
    game.play_card("p1", C("AS"))
    with pytest.raises(IllegalMove):
        game.play_card("p0", C("4D"))
    assert [c.code for c in game.legal_cards(0)] == ["KS"]
    game.play_card("p0", C("KS"))


def test_any_card_is_legal_when_you_are_void_in_the_lead_suit():
    game = make_game(n=2)
    bid_all(game, [1, 1])
    set_hands(game, {"p1": ["AS", "2S"], "p0": ["4D", "5H"]})
    game.play_card("p1", C("AS"))
    assert {c.code for c in game.legal_cards(0)} == {"4D", "5H"}
    game.play_card("p0", C("5H"))  # briscola: prende lui
    assert game.players[0].tricks == 1
    assert game.current_actor() == 0


def test_trick_winner_leads_the_next_trick():
    game = make_game(n=3)
    bid_all(game, [1, 1, 1])
    set_hands(game, {"p1": ["2S"], "p2": ["AS"], "p0": ["3S"]})
    game.play_card("p1", C("2S"))
    game.play_card("p2", C("AS"))
    game.play_card("p0", C("3S"))
    assert game.players[2].tricks == 1
    assert game.last_trick["winner"] == 2
    assert game.phase is Phase.ROUND_OVER


def test_you_cannot_play_a_card_you_do_not_hold():
    game = make_game(n=2)
    bid_all(game, [0, 0])
    set_hands(game, {"p1": ["2S"], "p0": ["3S"]})
    with pytest.raises(IllegalMove):
        game.play_card("p1", C("AH"))


# ------------------------------------------------------------ fine round


def test_round_scores_reward_the_exact_bid():
    game = make_game(n=2)
    bid_all(game, [1, 0])  # p1 dice 1, p0 dice 0
    set_hands(game, {"p1": ["AS", "2S"], "p0": ["KS", "3S"]})
    game.play_card("p1", C("AS"))
    game.play_card("p0", C("KS"))   # p1 prende con l'asso
    game.play_card("p1", C("2S"))
    game.play_card("p0", C("3S"))   # p0 prende la seconda
    assert game.players[1].tricks == 1 and game.players[0].tricks == 1
    assert game.players[1].score == 15  # 1 dichiarata, 1 fatta: 10 + 5
    assert game.players[0].score == 1   # 0 dichiarate, 1 fatta: 1 punto a presa


def test_misere_round_skips_bidding_and_subtracts_five_per_trick():
    game = make_game(n=2, mode=GameMode.FAST)
    while game.spec.kind is not RoundKind.MISERE:
        finish_round_with_bots(game)
        game.advance_round()
    assert game.phase is Phase.PLAYING
    assert all(p.bid is None for p in game.players)
    before = [p.score for p in game.players]
    finish_round_with_bots(game)
    for player, was in zip(game.players, before):
        assert player.score - was == -5 * player.tricks


def test_blind_round_hides_your_own_hand_until_bids_are_in():
    game = make_game(n=3)
    while game.spec.kind is not RoundKind.BLIND:
        finish_round_with_bots(game)
        game.advance_round()
    assert game.phase is Phase.BIDDING
    snap = game.snapshot("p0")
    assert snap["hand"] == [] and snap["hand_hidden"] is True
    bid_all(game, [1, 1, 1])
    snap = game.snapshot("p0")
    assert len(snap["hand"]) == 7 and snap["hand_hidden"] is False


def test_sweeping_the_misere_round_pays_fifteen():
    """La luna: chi prende tutte le prese a perdere incassa invece di pagare."""
    game = make_game(n=2)
    while game.spec.kind is not RoundKind.MISERE:
        finish_round_with_bots(game)
        game.advance_round()
    for player in game.players:
        player.is_bot = False

    # p1 ha sette briscole, p0 nemmeno una: p1 le prende tutte per forza.
    set_hands(game, {
        "p1": ["AH", "KH", "QH", "JH", "10H", "9H", "8H"],
        "p0": ["2S", "3S", "4S", "5S", "6S", "7S", "8S"],
    })
    before = [p.score for p in game.players]
    while game.phase is Phase.PLAYING:
        actor = game.current_actor()
        assert actor is not None
        pid = game.players[actor].id
        game.play_card(pid, game.legal_cards(actor)[0])

    assert game.players[1].tricks == 7 and game.players[0].tricks == 0
    assert game.players[1].score - before[1] == 30   # le ha prese tutte
    assert game.players[0].score - before[0] == 0    # non ne ha prese


def test_missing_the_sweep_by_one_trick_is_the_worst_outcome():
    game = make_game(n=2)
    while game.spec.kind is not RoundKind.MISERE:
        finish_round_with_bots(game)
        game.advance_round()
    for player in game.players:
        player.is_bot = False

    # p0 tiene l'asso di briscola: strappa una presa, e p1 ne incassa sei.
    set_hands(game, {
        "p1": ["KH", "QH", "JH", "10H", "9H", "8H", "7H"],
        "p0": ["AH", "3H", "4S", "5S", "6S", "7S", "8S"],
    })
    before = [p.score for p in game.players]
    while game.phase is Phase.PLAYING:
        actor = game.current_actor()
        assert actor is not None
        pid = game.players[actor].id
        legal = game.legal_cards(actor)
        game.play_card(pid, legal[0])

    assert sum(p.tricks for p in game.players) == 7
    assert game.players[1].tricks == 6 and game.players[0].tricks == 1
    assert game.players[1].score - before[1] == -30  # a una presa dalla luna
    assert game.players[0].score - before[0] == -5


def test_advance_round_only_after_the_round_is_over():
    game = make_game(n=3)
    with pytest.raises(IllegalMove):
        game.advance_round()


# -------------------------------------------------------------- snapshot


def test_snapshot_never_leaks_another_players_hand():
    game = make_game(n=4)
    snap = game.snapshot("p0")
    assert len(snap["hand"]) == 7
    assert snap["you"] == 0
    assert all("hand" not in p for p in snap["players"])
    assert [p["cards_left"] for p in snap["players"]] == [7, 7, 7, 7]


def test_spectator_snapshot_shows_no_hand_at_all():
    game = make_game(n=3)
    snap = game.snapshot(None)
    assert snap["hand"] == [] and snap["you"] is None


# ------------------------------------------------------------ partite intere


def finish_round_with_bots(game: Game, rng=None) -> None:
    rng = rng or random.Random(0)
    for player in game.players:
        player.is_bot = True
    while game.phase in (Phase.BIDDING, Phase.PLAYING):
        actor = game.current_actor()
        assert actor is not None
        bots.act(game, actor, rng)


@pytest.mark.parametrize("n", [2, 3, 4, 5, 6])
@pytest.mark.parametrize("mode", [GameMode.FAST, GameMode.LONG])
def test_full_games_terminate_with_consistent_scores(n, mode):
    game = make_game(n=n, mode=mode, seed=n * 100 + len(mode.value))
    rounds = 0
    while not game.is_over:
        if game.phase is Phase.ROUND_OVER:
            game.advance_round()
            rounds += 1
            continue
        finish_round_with_bots(game)
    assert rounds == (10 if mode is GameMode.FAST else 20)
    assert len(game.results) == rounds
    for result in game.results:
        spec = game.schedule[result.round_number - 1]
        assert sum(row["tricks"] for row in result.rows) == spec.cards
    for player in game.players:
        assert player.score == sum(
            row["delta"] for r in game.results for row in r.rows if row["player_id"] == player.id
        )


def test_same_seed_gives_the_same_game():
    a = make_game(n=4, seed=7)
    b = make_game(n=4, seed=7)
    assert [c.code for c in a.players[0].hand] == [c.code for c in b.players[0].hand]
    c = make_game(n=4, seed=8)
    assert [x.code for x in a.players[0].hand] != [x.code for x in c.players[0].hand]
