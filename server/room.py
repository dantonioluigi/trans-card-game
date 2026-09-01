"""Tavoli TRANS: lobby, connessioni WebSocket e bot che giocano da soli."""

from __future__ import annotations

import asyncio
import random
import string
import time
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


def new_room_code() -> str:
    return "".join(random.choice(CODE_ALPHABET) for _ in range(4))


def new_player_id() -> str:
    return uuid.uuid4().hex[:12]


@dataclass
class Seat:
    id: str
    name: str
    is_bot: bool = False
    bot_level: str = "normale"
    connected: bool = False
    socket: object | None = field(default=None, repr=False)

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
        wanted = (wanted or "Ospite").strip()[:16] or "Ospite"
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

    def join(self, player_id: str | None, name: str, socket: object) -> Seat:
        seat = self.seat_by_id(player_id) if player_id else None
        if seat is not None:
            if seat.is_bot:
                raise RoomError("quel posto e' occupato da un bot")
            seat.connected = True
            seat.socket = socket
        elif self.started:
            seat = self._take_over_bot(name, socket)
            if seat is None:
                raise RoomError(
                    "partita gia' iniziata e non ci sono bot di cui prendere il posto"
                )
        else:
            if len(self.seats) >= MAX_PLAYERS:
                raise RoomError(f"tavolo pieno (max {MAX_PLAYERS} giocatori)")
            seat = Seat(
                id=player_id or new_player_id(),
                name=self._unique_name(name),
                connected=True,
                socket=socket,
            )
            self.seats.append(seat)
        self._promote_host()
        return seat

    def _take_over_bot(self, name: str, socket: object) -> Seat | None:
        """Chi arriva a partita iniziata prende il posto di un bot.

        Senza questo, chi apre il tavolo deve aspettare fermo che arrivino
        tutti: per premere "Inizia" servono due giocatori, e se riempie i posti
        con i bot poi non entra piu' nessuno.
        """
        bot = next((s for s in self.seats if s.is_bot), None)
        if bot is None:
            return None
        was = bot.name
        bot.is_bot = False
        bot.name = self._unique_name(name, exclude_id=bot.id)
        bot.connected = True
        bot.socket = socket
        if self.game is not None:
            player = self.game.players[self.game.index_of(bot.id)]
            player.is_bot = False
            player.name = bot.name
            self.game._log(f"{bot.name} prende il posto di {was}.")
        return bot

    def leave(self, player_id: str) -> None:
        seat = self.seat_by_id(player_id)
        if seat is None:
            return
        seat.connected = False
        seat.socket = None
        if not self.started:
            self.seats = [s for s in self.seats if s.id != player_id]
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
        text = text.strip()[:200]
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
        for _ in range(50):
            code = new_room_code()
            if code not in self.rooms:
                room = Room(code)
                self.rooms[code] = room
                return room
        raise RoomError("non riesco a generare un codice libero")

    def get(self, code: str) -> Room:
        room = self.rooms.get(code.strip().upper())
        if room is None:
            raise RoomError(f"tavolo {code.strip().upper()} inesistente")
        return room

    def get_or_create(self, code: str | None) -> Room:
        if not code:
            return self.create()
        code = code.strip().upper()
        if code in self.rooms:
            return self.rooms[code]
        room = Room(code)
        self.rooms[code] = room
        return room

    def sweep(self, max_idle: float = 3 * 3600) -> None:
        """Butta via i tavoli vuoti e vecchi."""
        now = time.time()
        for code, room in list(self.rooms.items()):
            if room.is_empty() and now - room.created_at > max_idle:
                del self.rooms[code]
