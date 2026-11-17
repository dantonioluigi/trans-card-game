"""Tavoli TRANS: lobby, connessioni WebSocket e bot che giocano da soli."""

from __future__ import annotations

import asyncio
import hmac
import random
import re
import secrets
import time
import unicodedata
import uuid
from dataclasses import dataclass, field

from trans import bots
from trans.cards import Card
from trans.engine import MAX_PLAYERS, MIN_PLAYERS, Game, IllegalMove, Phase, Player
from trans.rules import GameMode

#: Pause che rendono leggibile la partita: i bot non devono giocare a raffica.
BOT_BID_DELAY = 0.55
BOT_PLAY_DELAY = 0.75
TRICK_PAUSE = 1.4
AUTO_ADVANCE_AFTER = 12.0

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # niente I/O/0/1


#: Tavoli aperti contemporaneamente. Servono a non finire in memoria se qualcuno
#: ne apre a raffica: i tavoli vivono nel processo e non c'e' nient'altro.
MAX_ROOMS = 500

CODE_RE = re.compile(f"[{CODE_ALPHABET}]{{4}}")


def new_room_code() -> str:
    # Il generatore sicuro, non random: il codice e' tutto quello che separa un
    # tavolo dagli sconosciuti.
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(4))


def new_player_id() -> str:
    """L'id e' pubblico: lo vedono tutti al tavolo. Dice chi e' un posto, non lo prova."""
    return uuid.uuid4().hex[:12]


def new_secret() -> str:
    """Il segreto di rientro: lo riceve solo chi si siede, e non compare in nessuno stato."""
    return secrets.token_urlsafe(16)


def normalize_code(code: object) -> str | None:
    """Il codice tavolo in forma canonica, o None se non ha la forma di un codice."""
    if not isinstance(code, str):
        return None
    code = code.strip().upper()
    return code if CODE_RE.fullmatch(code) else None


# Caratteri di controllo, di formato (zero-width, override destra-sinistra) e
# separatori di riga: permettono nomi che sembrano uguali a un altro.
_INVISIBLE = {"Cc", "Cf", "Zl", "Zp"}


def _visible(text: str) -> str:
    return "".join(ch for ch in text if unicodedata.category(ch) not in _INVISIBLE)


def clean_name(raw: object) -> str:
    text = unicodedata.normalize("NFKC", raw if isinstance(raw, str) else "")
    return " ".join(_visible(text).split())[:16]


def clean_chat(raw: object) -> str:
    return _visible(raw if isinstance(raw, str) else "").strip()[:200]


@dataclass
class Seat:
    id: str
    name: str
    is_bot: bool = False
    bot_level: str = "normale"
    connected: bool = False
    socket: object | None = field(default=None, repr=False)
    secret: str | None = field(default=None, repr=False)

    @property
    def plays_itself(self) -> bool:
        """Un bot, o un umano che si e' disconnesso: il computer gioca per lui."""
        return self.is_bot or not self.connected


class RoomError(Exception):
    pass


class Room:
    def __init__(self, code: str) -> None:
        self.code = code
        self.seats: list[Seat] = []
        self.game: Game | None = None
        self.mode = GameMode.FAST
        self.host_id: str | None = None
        self.chat: list[dict] = []
        self.rng = random.Random()
        self.created_at = time.time()
        self._lock = asyncio.Lock()
        self._pump_task: asyncio.Task | None = None
        self._advance_task: asyncio.Task | None = None

    # ------------------------------------------------------------- anagrafica

    @property
    def started(self) -> bool:
        return self.game is not None

    def seat_by_id(self, player_id: str) -> Seat | None:
        return next((s for s in self.seats if s.id == player_id), None)

    def index_of(self, player_id: str) -> int:
        return next(i for i, s in enumerate(self.seats) if s.id == player_id)

    def humans_online(self) -> int:
        return sum(1 for s in self.seats if not s.is_bot and s.connected)

    def is_empty(self) -> bool:
        return self.humans_online() == 0

    def _unique_name(self, wanted: str, exclude_id: str | None = None) -> str:
        wanted = clean_name(wanted) or "Ospite"
        taken = {s.name for s in self.seats if s.id != exclude_id}
        if wanted not in taken:
            return wanted
        for i in range(2, 100):
            candidate = f"{wanted} {i}"
            if candidate not in taken:
                return candidate
        return f"{wanted} {uuid.uuid4().hex[:3]}"

    def _promote_host(self) -> None:
        if self.host_id and (seat := self.seat_by_id(self.host_id)) and seat.connected:
            return
        nxt = next((s for s in self.seats if not s.is_bot and s.connected), None)
        self.host_id = nxt.id if nxt else None

    # ----------------------------------------------------------------- lobby

    def join(
        self, player_id: str | None, name: str, socket: object, secret: str | None = None
    ) -> Seat:
        seat = self.seat_by_id(player_id) if isinstance(player_id, str) and player_id else None
        # L'id e' pubblico: per riprendere un posto serve anche il segreto. Chi non
        # lo ha (o ne ha uno sbagliato) e' un giocatore nuovo, non quello di prima.
        if seat is not None and not (
            seat.secret
            and isinstance(secret, str)
            and hmac.compare_digest(seat.secret.encode(), secret.encode())
        ):
            seat = None
        if seat is not None:
            was_away = not seat.connected
            seat.connected = True
            seat.socket = socket
            if was_away and self.game is not None:
                self.game._log(f"{seat.name} rientra al tavolo.")
        elif self.started:
            seat = self._take_over_seat(name, socket)
            if seat is None:
                raise RoomError("partita gia' iniziata e non ci sono posti liberi da prendere")
        else:
            if len(self.seats) >= MAX_PLAYERS:
                raise RoomError(f"tavolo pieno (max {MAX_PLAYERS} giocatori)")
            seat = Seat(
                # Mai l'id proposto dal client: potrebbe coincidere con quello di un altro posto.
                id=new_player_id(),
                secret=new_secret(),
                name=self._unique_name(name),
                connected=True,
                socket=socket,
            )
            self.seats.append(seat)
        self._promote_host()
        return seat

    def _take_over_seat(self, name: str, socket: object) -> Seat | None:
        """Chi arriva a partita iniziata si siede dove gioca il computer.

        Prima al posto di un bot vero, poi a quello lasciato da chi e' uscito.
        Il posto riceve un id nuovo: chi era uscito, rientrando col vecchio id,
        non lo ritrova e non puo' scalzare chi nel frattempo si e' seduto li'.
        """
        seat = next((s for s in self.seats if s.is_bot), None) or next(
            (s for s in self.seats if not s.connected), None
        )
        if seat is None:
            return None
        was = seat.name
        fresh_id = new_player_id()
        player = self.game.players[self.game.index_of(seat.id)] if self.game else None

        seat.id = fresh_id
        seat.secret = new_secret()
        seat.is_bot = False
        seat.name = self._unique_name(name, exclude_id=fresh_id)
        seat.connected = True
        seat.socket = socket
        if player is not None:
            player.id = fresh_id
            player.is_bot = False
            player.name = seat.name
            self.game._log(f"{seat.name} prende il posto di {was}.")
        return seat

    def leave(self, player_id: str) -> None:
        """Chi esce a partita iniziata non la blocca: al suo posto gioca un bot."""
        seat = self.seat_by_id(player_id)
        if seat is None:
            return
        was_here = seat.connected
        seat.connected = False
        seat.socket = None
        if not self.started:
            self.seats = [s for s in self.seats if s.id != player_id]
        elif was_here and not seat.is_bot and not self.game.is_over:
            self.game._log(f"{seat.name} esce: al suo posto gioca un bot.")
        self._promote_host()

    def add_bot(self, requester: str, level: str = "normale") -> None:
        self._require_host(requester)
        if self.started:
            raise RoomError("partita gia' iniziata")
        if len(self.seats) >= MAX_PLAYERS:
            raise RoomError(f"tavolo pieno (max {MAX_PLAYERS} giocatori)")
        if level not in bots.LEVELS:
            raise RoomError(f"livello sconosciuto: {level}")
        n = sum(1 for s in self.seats if s.is_bot) + 1
        self.seats.append(
            Seat(id=new_player_id(), name=self._unique_name(f"Bot {n}"), is_bot=True, bot_level=level)
        )

    def remove_seat(self, requester: str, target_id: str) -> None:
        self._require_host(requester)
        if self.started:
            raise RoomError("partita gia' iniziata")
        target = self.seat_by_id(target_id)
        if target is None:
            raise RoomError("giocatore non trovato")
        if not target.is_bot and target.id != requester:
            raise RoomError("puoi rimuovere solo i bot")
        self.seats = [s for s in self.seats if s.id != target_id]
        self._promote_host()

    def set_mode(self, requester: str, mode: str) -> None:
        self._require_host(requester)
        if self.started:
            raise RoomError("partita gia' iniziata")
        try:
            self.mode = GameMode(mode)
        except ValueError as exc:
            raise RoomError(f"modalita' sconosciuta: {mode}") from exc

    def _require_host(self, requester: str) -> None:
        if requester != self.host_id:
            raise RoomError("solo chi ha creato il tavolo puo' farlo")

    # ---------------------------------------------------------------- partita

    def start(self, requester: str) -> None:
        self._require_host(requester)
        if self.started:
            raise RoomError("partita gia' iniziata")
        if len(self.seats) < MIN_PLAYERS:
            raise RoomError(f"servono almeno {MIN_PLAYERS} giocatori (aggiungi un bot)")
        players = [
            Player(id=s.id, name=s.name, is_bot=s.is_bot, bot_level=s.bot_level) for s in self.seats
        ]
        self.game = Game(players, mode=self.mode, seed=random.randrange(1 << 30))

    def back_to_lobby(self, requester: str) -> None:
        self._require_host(requester)
        self._cancel_auto_advance()
        self.game = None
        self.seats = [s for s in self.seats if s.is_bot or s.connected]
        self._promote_host()

    def rematch(self, requester: str) -> None:
        """Stessi giocatori, stessa durata, punteggi da zero.

        Passare dalla lobby per rigiocare identico e' un giro a vuoto: il
        tavolo e' gia' quello giusto, cambiano solo i punti.
        """
        self._require_host(requester)
        game = self._require_game()
        if not game.is_over:
            raise RoomError("la partita non e' ancora finita")
        self.back_to_lobby(requester)
        self.start(requester)

    def bid(self, player_id: str, value: int) -> None:
        game = self._require_game()
        game.place_bid(player_id, int(value))

    def play(self, player_id: str, code: str) -> None:
        game = self._require_game()
        game.play_card(player_id, Card.from_code(code))

    def next_round(self, player_id: str) -> None:
        game = self._require_game()
        if self.seat_by_id(player_id) is None:
            raise RoomError("non sei a questo tavolo")
        self._cancel_auto_advance()
        game.advance_round()

    def _require_game(self) -> Game:
        if self.game is None:
            raise RoomError("la partita non e' iniziata")
        return self.game

    def say(self, player_id: str, text: str) -> None:
        seat = self.seat_by_id(player_id)
        if seat is None:
            return
        text = clean_chat(text)
        if text:
            self.chat.append({"name": seat.name, "text": text, "ts": time.time()})
            del self.chat[:-50]

    # --------------------------------------------------------------- snapshot

    def snapshot_for(self, player_id: str | None) -> dict:
        base = {
            "type": "state",
            "room": self.code,
            "you": player_id,
            "host": self.host_id,
            "is_host": player_id is not None and player_id == self.host_id,
            "mode": self.mode.value,
            "mode_label": self.mode.label,
            "chat": self.chat[-30:],
            "min_players": MIN_PLAYERS,
            "max_players": MAX_PLAYERS,
            "bot_levels": list(bots.LEVELS),
        }
        if self.game is None:
            base["screen"] = "lobby"
            base["seats"] = [
                {
                    "id": s.id,
                    "name": s.name,
                    "is_bot": s.is_bot,
                    "bot_level": s.bot_level if s.is_bot else None,
                    "connected": s.connected,
                    "is_host": s.id == self.host_id,
                }
                for s in self.seats
            ]
            return base

        base["screen"] = "game"
        base["game"] = self.game.snapshot(player_id)
        for i, seat in enumerate(self.seats):
            base["game"]["players"][i]["connected"] = seat.connected
            base["game"]["players"][i]["auto"] = seat.plays_itself
        return base

    async def broadcast(self) -> None:
        dead: list[Seat] = []
        for seat in list(self.seats):
            socket = seat.socket
            if socket is None or not seat.connected:
                continue
            try:
                await socket.send_json(self.snapshot_for(seat.id))
            except Exception:
                dead.append(seat)
        for seat in dead:
            seat.connected = False
            seat.socket = None
        if dead:
            self._promote_host()

    # ------------------------------------------------------------ bot driver

    def pump(self) -> None:
        """Avvia (se serve) il task che fa muovere bot e disconnessi."""
        if self._pump_task is None or self._pump_task.done():
            self._pump_task = asyncio.create_task(self._pump_loop())

    async def _pump_loop(self) -> None:
        """Gira finche' il turno e' di un bot (o di un umano disconnesso)."""
        while True:
            game = self.game
            if game is None or game.is_over:
                return

            if game.phase is Phase.ROUND_OVER:
                if not self._everyone_is_automatic():
                    # C'e' un umano: gli lasciamo il tempo di leggere il tabellone.
                    # L'attesa vive in un task a parte, se no bloccherebbe i bot
                    # quando qualcuno preme "prossimo round" prima della scadenza.
                    self._schedule_auto_advance(game, game.round_index)
                    return
                await asyncio.sleep(TRICK_PAUSE)
                if not await self._advance_if_stuck(game, game.round_index):
                    return
                continue

            actor = game.current_actor()
            if actor is None or not self.seats[actor].plays_itself:
                return

            trick_was_closing = len(game.current_trick) == game.n - 1
            delay = BOT_BID_DELAY if game.phase is Phase.BIDDING else BOT_PLAY_DELAY
            await asyncio.sleep(delay)

            async with self._lock:
                if self.game is not game:
                    return
                actor = game.current_actor()
                if actor is None or not self.seats[actor].plays_itself:
                    return
                try:
                    bots.act(game, actor, self.rng)
                except (IllegalMove, RuntimeError):
                    return
            await self.broadcast()

            if trick_was_closing:
                await asyncio.sleep(TRICK_PAUSE)

    def _everyone_is_automatic(self) -> bool:
        return all(s.plays_itself for s in self.seats)

    def _schedule_auto_advance(self, game: Game, round_index: int) -> None:
        self._cancel_auto_advance()
        self._advance_task = asyncio.create_task(self._auto_advance(game, round_index))

    def _cancel_auto_advance(self) -> None:
        if self._advance_task is not None and not self._advance_task.done():
            self._advance_task.cancel()
        self._advance_task = None

    async def _auto_advance(self, game: Game, round_index: int) -> None:
        try:
            await asyncio.sleep(AUTO_ADVANCE_AFTER)
        except asyncio.CancelledError:
            return
        if await self._advance_if_stuck(game, round_index):
            self.pump()

    async def _advance_if_stuck(self, game: Game, round_index: int) -> bool:
        """Passa al round dopo solo se siamo ancora fermi su quello finito."""
        async with self._lock:
            if self.game is not game or game.phase is not Phase.ROUND_OVER:
                return False
            if game.round_index != round_index:
                return False
            game.advance_round()
        await self.broadcast()
        return True

    @property
    def lock(self) -> asyncio.Lock:
        return self._lock


class RoomRegistry:
    """Tavoli in memoria. Un riavvio del server azzera tutto: e' voluto."""

    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}

    def create(self) -> Room:
        self.sweep()
        if len(self.rooms) >= MAX_ROOMS:
            raise RoomError("il server e' pieno: riprova fra poco")
        for _ in range(50):
            code = new_room_code()
            if code not in self.rooms:
                room = Room(code)
                self.rooms[code] = room
                return room
        raise RoomError("non riesco a generare un codice libero")

    def get(self, code: object) -> Room:
        canonical = normalize_code(code)
        room = self.rooms.get(canonical) if canonical else None
        if room is None:
            # Il codice e' roba altrui: lo si mostra corto e senza spazi di troppo.
            shown = " ".join(str(code).split())[:8] if code is not None else ""
            raise RoomError(f"tavolo {shown} inesistente".replace("  ", " "))
        return room

    def get_or_create(self, code: object | None) -> Room:
        """Senza codice si apre un tavolo; con un codice si entra in uno che c'e'.

        Prima un codice sconosciuto creava un tavolo con quel nome, qualunque
        fosse: un refuso diventava una stanza vuota, e una stringa di megabyte
        restava in memoria.
        """
        if code is None or code == "":
            return self.create()
        return self.get(code)

    def sweep(self, max_idle: float = 3 * 3600) -> None:
        """Butta via i tavoli vuoti e vecchi."""
        now = time.time()
        for code, room in list(self.rooms.items()):
            if room.is_empty() and now - room.created_at > max_idle:
                del self.rooms[code]
