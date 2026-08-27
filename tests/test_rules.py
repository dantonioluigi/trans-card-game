import pytest

from trans.cards import Suit
from trans.rules import GameMode, RoundKind, build_schedule, score_round


def test_fast_game_is_seven_descending_rounds_plus_three_specials():
    sched = build_schedule(GameMode.FAST)
    assert len(sched) == 10
    assert [r.cards for r in sched[:7]] == [7, 6, 5, 4, 3, 2, 1]
    assert [r.kind for r in sched[7:]] == [
        RoundKind.NO_TRUMP,
        RoundKind.BLIND,
        RoundKind.MISERE,
    ]
    assert all(r.cards == 7 for r in sched[7:])


def test_long_game_mirrors_the_fast_one():
    sched = build_schedule(GameMode.LONG)
    assert len(sched) == 20
    assert [r.cards for r in sched[:7]] == [7, 6, 5, 4, 3, 2, 1]
    assert [r.cards for r in sched[10:17]] == [1, 2, 3, 4, 5, 6, 7]
    assert [r.kind for r in sched[17:]] == [
        RoundKind.NO_TRUMP,
        RoundKind.BLIND,
        RoundKind.MISERE,
    ]
    assert [r.number for r in sched] == list(range(1, 21))


def test_rounds_are_numbered_and_hearts_is_trump_except_no_trump():
    for r in build_schedule(GameMode.LONG):
        if r.kind is RoundKind.NO_TRUMP:
            assert r.trump is None
        else:
            assert r.trump is Suit.HEARTS


def test_misere_has_no_bidding_and_blind_is_bid_before_looking():
    sched = build_schedule(GameMode.FAST)
    no_trump, blind, misere = sched[7], sched[8], sched[9]
    assert no_trump.has_bidding and not no_trump.blind_bidding
    assert blind.has_bidding and blind.blind_bidding
    assert not misere.has_bidding


@pytest.mark.parametrize("bid,expected", [(0, 10), (1, 15), (2, 20), (3, 25), (7, 45)])
def test_hitting_the_bid_pays_ten_plus_five_per_trick(bid, expected):
    assert score_round(RoundKind.NORMAL, bid=bid, tricks=bid) == expected


@pytest.mark.parametrize("bid,tricks", [(0, 2), (3, 1), (1, 4), (5, 0)])
def test_missing_the_bid_pays_one_per_trick(bid, tricks):
    assert score_round(RoundKind.NORMAL, bid=bid, tricks=tricks) == tricks


def test_misere_costs_five_per_trick_and_ignores_the_bid():
    assert score_round(RoundKind.MISERE, bid=None, tricks=0) == 0
    assert score_round(RoundKind.MISERE, bid=None, tricks=3) == -15
    assert score_round(RoundKind.MISERE, bid=2, tricks=2) == -10


def test_special_rounds_score_like_normal_ones():
    assert score_round(RoundKind.NO_TRUMP, bid=2, tricks=2) == 20
    assert score_round(RoundKind.BLIND, bid=0, tricks=0) == 10
    assert score_round(RoundKind.BLIND, bid=4, tricks=2) == 2
