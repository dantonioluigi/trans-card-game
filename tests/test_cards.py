import pytest

from trans.cards import Card, Suit, deal, full_deck, sort_hand, trick_winner


def C(code: str) -> Card:
    return Card.from_code(code)


def test_deck_has_52_unique_cards():
    deck = full_deck()
    assert len(deck) == 52
    assert len(set(deck)) == 52
    assert sum(1 for c in deck if c.suit is Suit.HEARTS) == 13


@pytest.mark.parametrize("code", ["AH", "KD", "QC", "JS", "10H", "2S"])
def test_code_roundtrip(code):
    assert Card.from_code(code).code == code


def test_ace_is_the_highest():
    assert C("AS").rank > C("KS").rank > C("QS").rank > C("JS").rank > C("10S").rank


def test_higher_card_of_lead_suit_wins():
    plays = [(0, C("9S")), (1, C("KS")), (2, C("3S"))]
    assert trick_winner(plays, Suit.HEARTS) == 1


def test_off_suit_discard_never_wins():
    plays = [(0, C("9S")), (1, C("AD")), (2, C("2S"))]
    assert trick_winner(plays, Suit.HEARTS) == 0


def test_trump_beats_any_lead_suit_card():
    plays = [(0, C("AS")), (1, C("2H"))]
    assert trick_winner(plays, Suit.HEARTS) == 1


def test_highest_trump_wins_among_trumps():
    plays = [(0, C("AS")), (1, C("2H")), (2, C("5H"))]
    assert trick_winner(plays, Suit.HEARTS) == 2


def test_without_trump_only_the_lead_suit_matters():
    plays = [(0, C("9S")), (1, C("AH")), (2, C("10S"))]
    assert trick_winner(plays, None) == 2


def test_deal_gives_disjoint_hands():
    hands = deal(n_players=6, cards_each=7)
    assert [len(h) for h in hands] == [7] * 6
    flat = [c for h in hands for c in h]
    assert len(set(flat)) == 42


def test_deal_refuses_impossible_sizes():
    with pytest.raises(ValueError):
        deal(n_players=8, cards_each=7)


def test_sort_hand_puts_trump_first_and_descends():
    hand = sort_hand([C("2H"), C("AS"), C("AH"), C("3C")])
    assert [c.code for c in hand] == ["AH", "2H", "AS", "3C"]
