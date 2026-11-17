"""Test d'integrazione sul server: lobby, WebSocket, bot, partita intera."""

import contextlib
import json
import signal

import pytest
from fastapi.testclient import TestClient

from starlette.websockets import WebSocketDisconnect

from server import main as main_module
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


@pytest.fixture(autouse=True)
def relaxed_limits(monkeypatch):
    """Il limite di frequenza e' fatto per le persone: i test giocano a velocita' di macchina."""
    monkeypatch.setattr(main_module, "RATE_BURST", 100_000)
    monkeypatch.setattr(main_module, "RATE_PER_SECOND", 100_000.0)
    main_module._connections.clear()


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@contextlib.contextmanager
def deadline(seconds):
    """Se il bot non subentra, il test resterebbe appeso ad aspettare una mossa
    che non arriva mai: meglio fallire con un messaggio."""
    def boom(*_):
        raise AssertionError(f"nessun progresso in {seconds}s: il tavolo e' bloccato")
    previous = signal.signal(signal.SIGALRM, boom)
    signal.alarm(seconds)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def join(ws, name, room=None, player_id=None, secret=None):
    ws.send_json({"type": "join", "room": room, "name": name, "player_id": player_id, "secret": secret})
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
    assert page.status_code == 200 and "DICHIARO" in page.text
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
            # C'e' un bot al tavolo, quindi il ritardatario ne prende il posto.
            join(late, "Tardi", room=code)
            assert next_state(late, tolerate_errors=True)["screen"] == "game"


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


def test_rematch_restarts_with_the_same_table(client):
    """Rigiocare non deve costringere a rifare la stanza."""
    with client.websocket_connect("/ws") as host:
        join(host, "Luigi")
        next_state(host)
        host.send_json({"type": "add_bot", "level": "facile"})
        next_state(host)
        host.send_json({"type": "start"})
        final = play_full_game(host)
        assert final["winner"]
        names_before = [p["name"] for p in final["players"]]

        host.send_json({"type": "rematch"})
        fresh = state_until(host, lambda s: s["screen"] == "game"
                            and s["game"]["round"]["number"] == 1)["game"]
        assert [p["name"] for p in fresh["players"]] == names_before
        assert all(p["score"] == 0 for p in fresh["players"])
        assert len(fresh["hand"]) == 7
        assert fresh["round"]["total"] == 10


def test_rematch_keeps_the_chosen_length(client):
    with client.websocket_connect("/ws") as host:
        join(host, "Luigi")
        next_state(host)
        host.send_json({"type": "set_mode", "mode": "long"})
        next_state(host)
        host.send_json({"type": "add_bot", "level": "facile"})
        next_state(host)
        host.send_json({"type": "start"})
        play_full_game(host)
        host.send_json({"type": "rematch"})
        fresh = state_until(host, lambda s: s["screen"] == "game"
                            and s["game"]["round"]["number"] == 1)["game"]
        assert fresh["round"]["total"] == 20


def test_rematch_is_refused_before_the_end_and_to_guests(client):
    with client.websocket_connect("/ws") as host:
        code = join(host, "Luigi")["room"]
        next_state(host)
        with client.websocket_connect("/ws") as guest:
            join(guest, "Anna", room=code)
            next_state(guest)
            next_state(host)
            host.send_json({"type": "start"})
            state_until(host, lambda s: s["screen"] == "game")

            host.send_json({"type": "rematch"})
            assert "non e' ancora finita" in next_error(host)["message"]
            guest.send_json({"type": "rematch"})
            assert "solo chi ha creato" in next_error(guest)["message"]


def start_with_guest(client, host):
    """Luigi apre, Anna entra, si parte: nessun bot al tavolo."""
    welcome = join(host, "Luigi")
    next_state(host)
    guest = client.websocket_connect("/ws")
    guest_ws = guest.__enter__()
    anna = join(guest_ws, "Anna", room=welcome["room"])
    next_state(guest_ws)
    host.send_json({"type": "start"})
    state_until(host, lambda s: s["screen"] == "game")
    return welcome["room"], guest, guest_ws, anna["player_id"], anna["secret"]


def test_a_player_who_leaves_is_replaced_by_a_bot(client):
    with client.websocket_connect("/ws") as host:
        code, guest, guest_ws, anna_id, anna_secret = start_with_guest(client, host)
        guest.__exit__(None, None, None)  # Anna chiude la scheda

        state = state_until(host, lambda s: any(
            p["name"] == "Anna" and p["connected"] is False for p in s["game"]["players"]))
        anna = next(p for p in state["game"]["players"] if p["name"] == "Anna")
        assert anna["auto"] is True
        assert any("Anna esce: al suo posto gioca un bot." in line for line in state["game"]["log"])

        # La partita va avanti da sola: il bot gioca le mani di Anna.
        with deadline(20):
            final = play_full_game(host)
        assert final["winner"]


def test_a_latecomer_can_sit_where_someone_left(client):
    with client.websocket_connect("/ws") as host:
        code, guest, guest_ws, anna_id, anna_secret = start_with_guest(client, host)
        guest.__exit__(None, None, None)
        state_until(host, lambda s: any(p["connected"] is False for p in s["game"]["players"]))

        with client.websocket_connect("/ws") as late:
            welcome = join(late, "Marco", room=code)
            assert welcome["player_id"] != anna_id  # id nuovo, non quello di Anna
            view = next_state(late, tolerate_errors=True)["game"]
            assert [p["name"] for p in view["players"]] == ["Luigi", "Marco"]
            assert any("Marco prende il posto di Anna." in line for line in view["log"])

            # Anna rientra col vecchio id: il suo posto e' preso e non ce n'e' un altro.
            with client.websocket_connect("/ws") as back:
                back.send_json({"type": "join", "room": code, "name": "Anna", "player_id": anna_id})
                assert "non ci sono posti liberi" in next_error(back)["message"]


def test_whoever_comes_back_first_gets_the_seat_back(client):
    with client.websocket_connect("/ws") as host:
        code, guest, guest_ws, anna_id, anna_secret = start_with_guest(client, host)
        guest.__exit__(None, None, None)
        state_until(host, lambda s: any(p["connected"] is False for p in s["game"]["players"]))

        with client.websocket_connect("/ws") as back:
            welcome = join(back, "Anna", room=code, player_id=anna_id, secret=anna_secret)
            assert welcome["player_id"] == anna_id
            view = next_state(back, tolerate_errors=True)["game"]
            anna = next(p for p in view["players"] if p["name"] == "Anna")
            assert anna["connected"] is True and anna["auto"] is False
            assert any("Anna rientra al tavolo." in line for line in view["log"])


def test_a_latecomer_takes_over_a_bot(client):
    """Chi arriva a partita iniziata non resta fuori: entra al posto di un bot."""
    with client.websocket_connect("/ws") as host:
        code = join(host, "Luigi")["room"]
        next_state(host)
        host.send_json({"type": "add_bot", "level": "facile"})
        next_state(host)
        host.send_json({"type": "start"})
        state_until(host, lambda s: s["screen"] == "game")

        with client.websocket_connect("/ws") as late:
            welcome = join(late, "Anna", room=code)
            assert welcome["name"] == "Anna"
            state = next_state(late, tolerate_errors=True)
            assert state["screen"] == "game"
            game = state["game"]
            # Ha preso il posto del bot, con le sue carte.
            assert game["you"] is not None
            assert game["players"][game["you"]]["name"] == "Anna"
            assert game["players"][game["you"]]["is_bot"] is False
            assert len(game["hand"]) > 0
            assert [p["name"] for p in game["players"]] == ["Luigi", "Anna"]


def test_without_bots_a_started_game_stays_closed(client):
    with client.websocket_connect("/ws") as a:
        code = join(a, "Luigi")["room"]
        next_state(a)
        with client.websocket_connect("/ws") as b:
            join(b, "Anna", room=code)
            next_state(b)
            next_state(a)
            a.send_json({"type": "start"})
            state_until(a, lambda s: s["screen"] == "game")
            with client.websocket_connect("/ws") as late:
                late.send_json({"type": "join", "room": code, "name": "Tardi"})
                assert "non ci sono posti liberi" in next_error(late)["message"]


def test_reconnecting_with_the_same_id_gets_the_seat_back(client):
    with client.websocket_connect("/ws") as host:
        welcome = join(host, "Luigi")
        code, pid, secret = welcome["room"], welcome["player_id"], welcome["secret"]
        next_state(host)
        host.send_json({"type": "add_bot", "level": "facile"})
        next_state(host)
        host.send_json({"type": "start"})
        state_until(host, lambda s: s["screen"] == "game")

    # Il socket e' caduto: il bot gioca al posto suo, ma il posto resta.
    with client.websocket_connect("/ws") as again:
        back = join(again, "Luigi", room=code, player_id=pid, secret=secret)
        assert back["player_id"] == pid
        state = next_state(again)
        assert state["screen"] == "game"
        assert state["game"]["you"] is not None


# --------------------------------------------------------------------- sicurezza


def test_the_public_id_alone_does_not_take_the_hosts_seat(client):
    """L'id di ogni posto e' in ogni stato, quindi non puo' bastare a prendere quel posto."""
    with client.websocket_connect("/ws") as host:
        welcome = join(host, "Luigi")
        code, host_id = welcome["room"], welcome["player_id"]
        next_state(host)
        with client.websocket_connect("/ws") as bob:
            join(bob, "Bob", room=code)
            assert next_state(bob)["host"] == host_id  # l'id dell'host e' visibile a tutti

            with client.websocket_connect("/ws") as mallory:
                got = join(mallory, "Mallory", room=code, player_id=host_id)
                assert got["player_id"] != host_id
                state = next_state(mallory)
                assert state["is_host"] is False and state["host"] == host_id

                mallory.send_json({"type": "add_bot", "level": "facile"})
                assert "solo chi ha creato" in next_error(mallory)["message"]

            # L'host vero riceve ancora gli stati e comanda ancora.
            host.send_json({"type": "add_bot", "level": "facile"})
            state = state_until(host, lambda s: len(s.get("seats", [])) >= 3)
            assert state["is_host"] is True


def test_a_wrong_secret_does_not_take_the_seat_either(client):
    with client.websocket_connect("/ws") as host:
        welcome = join(host, "Luigi")
        next_state(host)
        with client.websocket_connect("/ws") as mallory:
            got = join(mallory, "Mallory", room=welcome["room"],
                       player_id=welcome["player_id"], secret="x" * 22)
            assert got["player_id"] != welcome["player_id"]
            assert next_state(mallory)["is_host"] is False


def test_the_secret_never_appears_in_any_state(client):
    with client.websocket_connect("/ws") as host:
        h = join(host, "Luigi")
        seen = [next_state(host)]
        with client.websocket_connect("/ws") as guest:
            g = join(guest, "Anna", room=h["room"])
            guest_seen = [next_state(guest)]
            host.send_json({"type": "start"})
            seen.append(state_until(host, lambda s: s["screen"] == "game"))
            guest_seen.append(state_until(guest, lambda s: s["screen"] == "game"))
            everything = json.dumps(seen + guest_seen)
            assert h["secret"] and g["secret"] and h["secret"] != g["secret"]
            assert h["secret"] not in everything and g["secret"] not in everything


def test_a_second_join_on_the_same_connection_is_refused(client):
    with client.websocket_connect("/ws") as ws:
        welcome = join(ws, "Luigi")
        next_state(ws)
        ws.send_json({"type": "join", "room": welcome["room"], "name": "Fantasma"})
        assert "gia' al tavolo" in next_error(ws)["message"]
        ws.send_json({"type": "chat", "text": "ci sono"})
        assert len(next_state(ws)["seats"]) == 1


def test_an_unknown_room_code_is_refused_and_creates_nothing(client):
    with client.websocket_connect("/ws") as ws:
        for code in ("ZZZZ", "A" * 100, "ab", 12345, ["A"]):
            ws.send_json({"type": "join", "room": code, "name": "Luigi"})
            message = next_error(ws)["message"]
            assert "inesistente" in message and len(message) < 40
    assert registry.rooms == {}


def test_malformed_fields_are_answered_without_killing_the_session(client):
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "join", "room": None, "name": ["a"], "player_id": {"x": 1}, "secret": 5})
        welcome = ws.receive_json()
        assert welcome["type"] == "welcome" and welcome["name"] == "Ospite"
        next_state(ws)

        for bad in (
            {"type": "add_bot", "level": ["x"]},
            {"type": "set_mode", "mode": {"a": 1}},
            {"type": "bid", "value": "1"},
            {"type": "play", "card": 7},
            {"type": "remove_player", "player_id": ["x"]},
            {"type": 5},
            [1, 2, 3],
            "testo",
        ):
            ws.send_json(bad)
            assert next_error(ws)["type"] == "error", bad
        ws.send_bytes(b"\x00\x01")
        assert "solo messaggi di testo" in next_error(ws)["message"]
        ws.send_text("{non e' json")
        assert "non valido" in next_error(ws)["message"]

        # Dopo tutto questo il tavolo funziona ancora.
        ws.send_json({"type": "add_bot", "level": "facile"})
        next_state(ws)
        ws.send_json({"type": "start"})
        assert state_until(ws, lambda s: s["screen"] == "game")["screen"] == "game"


def test_an_oversized_message_closes_the_connection(client):
    with client.websocket_connect("/ws") as ws:
        join(ws, "Luigi")
        ws.send_text("x" * 5000)
        with pytest.raises(WebSocketDisconnect) as closed:
            for _ in range(5):
                ws.receive_json()
        assert closed.value.code == 1009


def test_a_flood_of_messages_closes_the_connection(client, monkeypatch):
    monkeypatch.setattr(main_module, "RATE_BURST", 5)
    monkeypatch.setattr(main_module, "RATE_PER_SECOND", 0.001)
    with client.websocket_connect("/ws") as ws:
        join(ws, "Luigi")
        for _ in range(12):
            ws.send_json({"type": "ping"})
        with pytest.raises(WebSocketDisconnect) as closed:
            for _ in range(30):
                ws.receive_json()
        assert closed.value.code == 1008


def test_only_the_same_site_may_open_a_websocket(client, monkeypatch):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", headers={"origin": "http://evil.example"}):
            pass
    with client.websocket_connect("/ws", headers={"origin": "http://testserver"}) as ws:
        assert join(ws, "Luigi")["type"] == "welcome"
    # Un elenco esplicito vince sul confronto con l'host.
    monkeypatch.setenv("TRANS_ALLOWED_ORIGINS", "https://gioco.example")
    with client.websocket_connect("/ws", headers={"origin": "https://gioco.example"}) as ws:
        assert join(ws, "Anna")["type"] == "welcome"
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", headers={"origin": "http://testserver"}):
            pass


def test_connections_and_rooms_have_a_ceiling(client, monkeypatch):
    monkeypatch.setattr(main_module, "MAX_CONNECTIONS_PER_IP", 2)
    with client.websocket_connect("/ws") as a, client.websocket_connect("/ws") as b:
        join(a, "A")
        join(b, "B")
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws"):
                pass
    monkeypatch.setattr(room_module, "MAX_ROOMS", 2)
    registry.rooms.clear()
    for name in ("A", "B"):
        with client.websocket_connect("/ws") as ws:
            join(ws, name)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "join", "room": None, "name": "C"})
        assert "pieno" in next_error(ws)["message"]


def test_names_lose_invisible_and_direction_characters(client):
    with client.websocket_connect("/ws") as ws:
        welcome = join(ws, "A​B‮  C\n")
        assert welcome["name"] == "AB C"
    with client.websocket_connect("/ws") as ws:
        assert join(ws, "Ｌｕｉｇｉ")["name"] == "Luigi"  # a larghezza piena
    with client.websocket_connect("/ws") as ws:
        assert join(ws, "​‮")["name"] == "Ospite"


def test_pages_carry_security_headers_and_no_room_oracle(client):
    page = client.get("/")
    assert "script-src 'self'" in page.headers["content-security-policy"]
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
    assert page.headers["x-content-type-options"] == "nosniff"
    assert page.headers["x-frame-options"] == "DENY"
    # Prima diceva 200 o 404 per ogni codice: un modo gratis per cercare tavoli aperti.
    assert client.get("/api/rooms/ABCD").status_code == 404
