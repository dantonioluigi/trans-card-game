"""Server Dichiaro: HTTP per la pagina, WebSocket per la partita."""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from trans.engine import IllegalMove
from trans.rules import GameMode

from .room import Room, RoomError, RoomRegistry

log = logging.getLogger("trans")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

app = FastAPI(title="Dichiaro", docs_url=None, redoc_url=None)
registry = RoomRegistry()

#: Un messaggio vero e' di poche decine di byte. Tetti larghi, ma tetti: il
#: processo tiene tutto in memoria e non c'e' nessuno davanti a filtrare.
MAX_MESSAGE_CHARS = 2048
RATE_BURST = 30            # messaggi che una connessione puo' mandare di colpo
RATE_PER_SECOND = 10.0     # e poi al secondo, a regime
MAX_CONNECTIONS = 1000
MAX_CONNECTIONS_PER_IP = 12

SECURITY_HEADERS = {
    # La pagina non ha script in linea ne' risorse esterne: se un campo dello
    # stato finisse nell'HTML senza escape, il browser non lo eseguirebbe lo stesso.
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    for name, value in SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    return response


class Bucket:
    """Un secchiello di gettoni: lascia passare una raffica, poi un ritmo costante."""

    def __init__(self, capacity: int, per_second: float) -> None:
        self.capacity = capacity
        self.per_second = per_second
        self.tokens = float(capacity)
        self.stamp = time.monotonic()

    def take(self) -> bool:
        now = time.monotonic()
        self.tokens = min(self.capacity, self.tokens + (now - self.stamp) * self.per_second)
        self.stamp = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True


_connections: dict[str, int] = {}


def admit(ip: str) -> bool:
    if sum(_connections.values()) >= MAX_CONNECTIONS or _connections.get(ip, 0) >= MAX_CONNECTIONS_PER_IP:
        return False
    _connections[ip] = _connections.get(ip, 0) + 1
    return True


def release(ip: str) -> None:
    left = _connections.get(ip, 0) - 1
    if left > 0:
        _connections[ip] = left
    else:
        _connections.pop(ip, None)


def origin_allowed(ws: WebSocket) -> bool:
    """Da un browser, la pagina deve venire da questo stesso sito.

    Un'altra pagina potrebbe altrimenti usare il nostro server come proprio.
    Senza intestazione Origin (client che non sono browser) si lascia passare.
    TRANS_ALLOWED_ORIGINS, se impostata, e' l'elenco esatto, separato da virgole.
    """
    origin = ws.headers.get("origin")
    if origin is None:
        return True
    listed = [o.strip() for o in os.environ.get("TRANS_ALLOWED_ORIGINS", "").split(",") if o.strip()]
    if listed:
        return origin in listed
    return urlparse(origin).netloc == ws.headers.get("host", "")


def _text(msg: dict, key: str, default: str = "") -> str:
    value = msg.get(key, default)
    if not isinstance(value, str):
        raise RoomError("messaggio non valido")
    return value


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "rooms": len(registry.rooms)}


@app.get("/api/modes")
async def modes() -> dict:
    return {"modes": [{"value": m.value, "label": m.label} for m in GameMode]}


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


async def _fail(ws: WebSocket, message: str) -> None:
    await ws.send_json({"type": "error", "message": message})


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    ip = ws.client.host if ws.client else "?"
    if not origin_allowed(ws) or not admit(ip):
        await ws.close(code=1008)
        return
    await ws.accept()
    room: Room | None = None
    player_id: str | None = None
    bucket = Bucket(RATE_BURST, RATE_PER_SECOND)

    try:
        while True:
            frame = await ws.receive()
            if frame["type"] == "websocket.disconnect":
                break
            raw = frame.get("text")
            if raw is None:
                await _fail(ws, "solo messaggi di testo")
                continue
            if len(raw) > MAX_MESSAGE_CHARS:
                await ws.close(code=1009)
                break
            if not bucket.take():
                await ws.close(code=1008)
                break
            try:
                msg = json.loads(raw)
            except ValueError:
                await _fail(ws, "messaggio non valido")
                continue
            if not isinstance(msg, dict) or not isinstance(msg.get("type"), str):
                await _fail(ws, "messaggio non valido")
                continue
            kind = msg["type"]

            # ---------------------------------------------------------- join
            if kind == "join":
                # Una connessione, un posto: il "finally" libera solo l'ultimo.
                if player_id is not None:
                    await _fail(ws, "sei gia' al tavolo")
                    continue
                try:
                    room = registry.get_or_create(msg.get("room"))
                    seat = room.join(msg.get("player_id"), msg.get("name"), ws, msg.get("secret"))
                except RoomError as exc:
                    await _fail(ws, str(exc))
                    room = None
                    continue
                player_id = seat.id
                await ws.send_json(
                    {
                        "type": "welcome",
                        "room": room.code,
                        "player_id": seat.id,
                        # Solo a chi si siede: nessuno stato lo contiene.
                        "secret": seat.secret,
                        "name": seat.name,
                    }
                )
                await room.broadcast()
                room.pump()
                continue

            if room is None or player_id is None:
                await _fail(ws, "prima entra in un tavolo")
                continue

            # ------------------------------------------------------- azioni
            try:
                async with room.lock:
                    if kind == "add_bot":
                        room.add_bot(player_id, _text(msg, "level", "normale"))
                    elif kind == "remove_player":
                        room.remove_seat(player_id, _text(msg, "player_id"))
                    elif kind == "set_mode":
                        room.set_mode(player_id, _text(msg, "mode", "fast"))
                    elif kind == "start":
                        room.start(player_id)
                    elif kind == "bid":
                        value = msg.get("value", 0)
                        if isinstance(value, bool) or not isinstance(value, int):
                            raise RoomError("messaggio non valido")
                        room.bid(player_id, value)
                    elif kind == "play":
                        room.play(player_id, _text(msg, "card"))
                    elif kind == "next_round":
                        room.next_round(player_id)
                    elif kind == "rematch":
                        room.rematch(player_id)
                    elif kind == "new_game":
                        room.back_to_lobby(player_id)
                    elif kind == "chat":
                        room.say(player_id, _text(msg, "text"))
                    elif kind == "ping":
                        await ws.send_json({"type": "pong"})
                        continue
                    else:
                        raise RoomError("messaggio sconosciuto")
            except (RoomError, IllegalMove, ValueError, KeyError, TypeError, AttributeError) as exc:
                await _fail(ws, str(exc) or "mossa non valida")
                continue

            await room.broadcast()
            room.pump()

    except Exception:  # pragma: no cover - difensivo
        log.exception("errore nella sessione websocket")
    finally:
        release(ip)
        if room is not None and player_id is not None:
            room.leave(player_id)
            try:
                await room.broadcast()
            except Exception:
                pass
            room.pump()
            registry.sweep()


def listen_port() -> int:
    """Porta di ascolto.

    ``TRANS_PORT`` vince, ma quasi tutti gli host (Fly, Render, Cloud Run,
    Heroku...) passano la porta in ``PORT``: senza questo fallback il processo
    ascolta sulla 8000 e la piattaforma lo dichiara morto.
    """
    for name in ("TRANS_PORT", "PORT"):
        value = os.environ.get(name)
        if value:
            return int(value)
    return 8000


def main() -> None:
    import uvicorn

    uvicorn.run(
        "server.main:app",
        host=os.environ.get("TRANS_HOST", "0.0.0.0"),
        port=listen_port(),
        reload=bool(os.environ.get("TRANS_RELOAD")),
        log_level=os.environ.get("TRANS_LOG_LEVEL", "info"),
        # Un messaggio vero e' di poche decine di byte: il default e' 16 MiB.
        ws_max_size=65536,
        # Dietro il proxy dell'host: senza, uvicorn non si fida di
        # X-Forwarded-Proto e i log mostrano tutto come http.
        proxy_headers=True,
        forwarded_allow_ips=os.environ.get("TRANS_FORWARDED_IPS", "*"),
    )


if __name__ == "__main__":
    main()
