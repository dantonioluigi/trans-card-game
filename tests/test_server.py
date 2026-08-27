"""Test d'integrazione sul server: lobby, WebSocket, bot, partita intera."""

import pytest
from fastapi.testclient import TestClient

from server import room as room_module
from server.main import app, registry


@pytest.fixture(autouse=True)
def fast_bots(monkeypatch):
    """Niente pause: i bot devono muovere subito nei test."""
    monkeypatch.setattr(room_module, "BOT_BID_DELAY", 0)
    monkeypatch.setattr(room_module, "BOT_PLAY_DELAY", 0)
    monkeypatch.setattr(room_module, "TRICK_PAUSE", 0)
    monkeypatch.setattr(room_module, "AUTO_ADVANCE_AFTER", 3600)
    registry.rooms.clear()


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def join(ws, name, room=None, player_id=None):
    ws.send_json({"type": "join", "room": room, "name": name, "player_id": player_id})
    welcome = ws.receive_json()
    assert welcome["type"] == "welcome", welcome
    return welcome


def next_state(ws, tolerate_errors=False):
    """Scarta gli echi finche' non arriva uno stato."""
    for _ in range(400):
        msg = ws.receive_json()
        if msg["type"] == "state":
            return msg
        if msg["type"] == "error" and not tolerate_errors:
            raise AssertionError(f"errore dal server: {msg['message']}")
    raise AssertionError("nessuno stato ricevuto")


def next_error(ws):
    """Il primo errore, ignorando gli stati che i bot fanno passare nel mezzo."""
    for _ in range(400):
        msg = ws.receive_json()
        if msg["type"] == "error":
            return msg
    raise AssertionError("nessun errore ricevuto")


def state_until(ws, predicate):
    for _ in range(4000):
        state = next_state(ws)
        if predicate(state):
            return state
    raise AssertionError("condizione mai raggiunta")


# ------------------------------------------------------------------- lobby


def test_port_comes_from_TRANS_PORT_then_PORT_then_the_default(monkeypatch):
    from server.main import listen_port

    monkeypatch.delenv("TRANS_PORT", raising=False)
    monkeypatch.delenv("PORT", raising=False)
    assert listen_port() == 8000

    # Gli host tipo Fly o Render passano solo PORT.
    monkeypatch.setenv("PORT", "10000")
    assert listen_port() == 10000

    # Se ci sono entrambe vince la nostra.
    monkeypatch.setenv("TRANS_PORT", "8123")
    assert listen_port() == 8123


def test_health_and_index_are_served(client):
    assert client.get("/health").json()["ok"] is True
    page = client.get("/")
    assert page.status_code == 200 and "TRANS" in page.text
    assert client.get("/static/app.js").status_code == 200


def test_creating_a_room_returns_a_code_and_makes_you_host(client):
    with client.websocket_connect("/ws") as ws:
        welcome = join(ws, "Luigi")
        assert len(welcome["room"]) == 4
        state = next_state(ws)
        assert state["screen"] == "lobby"
        assert state["is_host"] is True
        assert [s["name"] for s in state["seats"]] == ["Luigi"]


def test_a_second_player_joins_the_same_room(client):
    with client.websocket_connect("/ws") as host:
        code = join(host, "Luigi")["room"]
        next_state(host)
        with client.websocket_connect("/ws") as guest:
            join(guest, "Anna", room=code)
            state = next_state(guest)
            assert [s["name"] for s in state["seats"]] == ["Luigi", "Anna"]
            assert state["is_host"] is False


def test_duplicate_names_are_disambiguated(client):
    with client.websocket_connect("/ws") as host:
        code = join(host, "Luigi")["room"]
        next_state(host)
        with client.websocket_connect("/ws") as guest:
            assert join(guest, "Luigi", room=code)["name"] == "Luigi 2"


def test_joining_a_missing_room_creates_it_but_a_started_one_is_closed(client):
    with client.websocket_connect("/ws") as host:
        code = join(host, "Luigi")["room"]
        next_state(host)
        host.send_json({"type": "add_bot", "level": "facile"})
        next_state(host)
        host.send_json({"type": "start"})
        state_until(host, lambda s: s["screen"] == "game")

        with client.websocket_connect("/ws") as late:
            late.send_json({"type": "join", "room": code, "name": "Tardi"})
            assert "gia' iniziata" in next_error(late)["message"]


def test_only_the_host_can_add_bots_or_start(client):
    with client.websocket_connect("/ws") as host:
        code = join(host, "Luigi")["room"]
        next_state(host)
        with client.websocket_connect("/ws") as guest:
            join(guest, "Anna", room=code)
            next_state(guest)
            guest.send_json({"type": "add_bot", "level": "normale"})
            assert "solo chi ha creato" in next_error(guest)["message"]
            guest.send_json({"type": "start"})
            assert "solo chi ha creato" in next_error(guest)["message"]


def test_a_single_player_cannot_start(client):
    with client.websocket_connect("/ws") as host:
        join(host, "Luigi")
        next_state(host)
        host.send_json({"type": "start"})
        assert "almeno" in next_error(host)["message"]


def test_host_can_choose_the_long_game(client):
    with client.websocket_connect("/ws") as host:
        join(host, "Luigi")
        next_state(host)
        host.send_json({"type": "set_mode", "mode": "long"})
        assert next_state(host)["mode"] == "long"
        host.send_json({"type": "add_bot", "level": "facile"})
        next_state(host)
        host.send_json({"type": "start"})
        state = state_until(host, lambda s: s["screen"] == "game")
        assert state["game"]["round"]["total"] == 20


# ------------------------------------------------------------------ partita


def test_hand_is_private_to_its_owner(client):
    with client.websocket_connect("/ws") as host:
        code = join(host, "Luigi")["room"]
        next_state(host)
        with client.websocket_connect("/ws") as guest:
            join(guest, "Anna", room=code)
            next_state(guest)
            host.send_json({"type": "start"})
            host_state = state_until(host, lambda s: s["screen"] == "game")
            guest_state = state_until(guest, lambda s: s["screen"] == "game")
            assert len(host_state["game"]["hand"]) == 7
            assert len(guest_state["game"]["hand"]) == 7
            assert set(host_state["game"]["hand"]) != set(guest_state["game"]["hand"])
            for player in host_state["game"]["players"]:
                assert "hand" not in player


def test_illegal_moves_are_rejected_with_an_error(client):
    with client.websocket_connect("/ws") as host:
        join(host, "Luigi")
        next_state(host)
        host.send_json({"type": "add_bot", "level": "facile"})
        next_state(host)
        host.send_json({"type": "start"})
        state_until(host, lambda s: s["screen"] == "game")
        # Siamo in fase di dichiarazione: le carte non si toccano.
        host.send_json({"type": "play", "card": "AH"})
        assert "momento di giocare" in next_error(host)["message"]
        # E non si dichiarano piu' prese di quante carte si hanno in mano.
        host.send_json({"type": "bid", "value": 99})
        assert "non valida" in next_error(host)["message"]


def test_unknown_message_is_reported(client):
    with client.websocket_connect("/ws") as host:
        join(host, "Luigi")
        next_state(host)
        host.send_json({"type": "banana"})
        assert "sconosciuto" in next_error(host)["message"]


def test_chat_reaches_the_other_players(client):
    with client.websocket_connect("/ws") as host:
        code = join(host, "Luigi")["room"]
        next_state(host)
        with client.websocket_connect("/ws") as guest:
            join(guest, "Anna", room=code)
            next_state(guest)
            next_state(host)
            guest.send_json({"type": "chat", "text": "ciao a tutti"})
            state = state_until(host, lambda s: s["chat"])
            assert state["chat"][-1] == {
                "name": "Anna",
                "text": "ciao a tutti",
                "ts": state["chat"][-1]["ts"],
            }


def play_full_game(ws, host_ws=None):
    """Gioca una partita intera rispondendo sempre con la prima mossa legale."""
    control = host_ws or ws
    for _ in range(6000):
        state = next_state(ws, tolerate_errors=True)
        if state["screen"] != "game":
            continue
        g = state["game"]
        if g["phase"] == "game_over":
            return g
        if g["phase"] == "round_over":
            control.send_json({"type": "next_round"})
            continue
        if g["legal_bids"]:
            ws.send_json({"type": "bid", "value": g["legal_bids"][0]})
        elif g["legal_cards"]:
            ws.send_json({"type": "play", "card": g["legal_cards"][0]})
    raise AssertionError("la partita non e' finita")


def test_a_full_fast_game_against_bots_reaches_a_winner(client):
    with client.websocket_connect("/ws") as host:
        join(host, "Luigi")
        next_state(host)
        for level in ("facile", "normale", "esperto"):
            host.send_json({"type": "add_bot", "level": level})
            next_state(host)
        host.send_json({"type": "start"})
        final = play_full_game(host)
        assert final["round"]["number"] == 10
        assert final["winner"]
        assert len(final["standings"]) == 4
        assert sum(p["cards_left"] for p in final["players"]) == 0


def test_blind_round_hides_the_hand_over_the_wire(client):
    with client.websocket_connect("/ws") as host:
        join(host, "Luigi")
        next_state(host)
        host.send_json({"type": "add_bot", "level": "facile"})
        next_state(host)
        host.send_json({"type": "start"})

        seen_blind = False
        for _ in range(6000):
            state = next_state(host, tolerate_errors=True)
            g = state["game"]
            if g["phase"] == "game_over":
                break
            if g["round"]["kind"] == "blind" and g["phase"] == "bidding":
                assert g["hand"] == [] and g["hand_hidden"] is True
                seen_blind = True
            if g["round"]["kind"] == "blind" and g["phase"] == "playing" and g["hand"]:
                assert g["hand_hidden"] is False
            if g["phase"] == "round_over":
                host.send_json({"type": "next_round"})
            elif g["legal_bids"]:
                host.send_json({"type": "bid", "value": g["legal_bids"][0]})
            elif g["legal_cards"]:
                host.send_json({"type": "play", "card": g["legal_cards"][0]})
        assert seen_blind


def test_reconnecting_with_the_same_id_gets_the_seat_back(client):
    with client.websocket_connect("/ws") as host:
        welcome = join(host, "Luigi")
        code, pid = welcome["room"], welcome["player_id"]
        next_state(host)
        host.send_json({"type": "add_bot", "level": "facile"})
        next_state(host)
        host.send_json({"type": "start"})
        state_until(host, lambda s: s["screen"] == "game")

    # Il socket e' caduto: il bot gioca al posto suo, ma il posto resta.
    with client.websocket_connect("/ws") as again:
        back = join(again, "Luigi", room=code, player_id=pid)
        assert back["player_id"] == pid
        state = next_state(again)
        assert state["screen"] == "game"
        assert state["game"]["you"] is not None
