"""Server TRANS: HTTP per la pagina, WebSocket per la partita."""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from trans.engine import IllegalMove
from trans.rules import GameMode

from .room import Room, RoomError, RoomRegistry, new_player_id

log = logging.getLogger("trans")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

app = FastAPI(title="TRANS", docs_url=None, redoc_url=None)
registry = RoomRegistry()


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "rooms": len(registry.rooms)}


@app.get("/api/rooms/{code}")
async def room_info(code: str) -> JSONResponse:
    try:
        room = registry.get(code)
    except RoomError as exc:
        return JSONResponse({"error": str(exc)}, status_code=404)
    return JSONResponse(
        {
            "room": room.code,
            "players": len(room.seats),
            "started": room.started,
            "mode": room.mode.value,
        }
    )


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
    await ws.accept()
    room: Room | None = None
    player_id: str | None = None

    try:
        while True:
            msg = await ws.receive_json()
            kind = msg.get("type")

            # ---------------------------------------------------------- join
            if kind == "join":
                try:
                    room = registry.get_or_create(msg.get("room"))
                    seat = room.join(msg.get("player_id"), msg.get("name", ""), ws)
                except RoomError as exc:
                    await _fail(ws, str(exc))
                    room = None
                    continue
                player_id = seat.id
                await ws.send_json(
                    {"type": "welcome", "room": room.code, "player_id": seat.id, "name": seat.name}
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
                        room.add_bot(player_id, msg.get("level", "normale"))
                    elif kind == "remove_player":
                        room.remove_seat(player_id, msg.get("player_id", ""))
                    elif kind == "set_mode":
                        room.set_mode(player_id, msg.get("mode", "fast"))
                    elif kind == "start":
                        room.start(player_id)
                    elif kind == "bid":
                        room.bid(player_id, msg.get("value", 0))
                    elif kind == "play":
                        room.play(player_id, msg.get("card", ""))
                    elif kind == "next_round":
                        room.next_round(player_id)
                    elif kind == "new_game":
                        room.back_to_lobby(player_id)
                    elif kind == "chat":
                        room.say(player_id, msg.get("text", ""))
                    elif kind == "ping":
                        await ws.send_json({"type": "pong"})
                        continue
                    else:
                        raise RoomError(f"messaggio sconosciuto: {kind}")
            except (RoomError, IllegalMove, ValueError, KeyError) as exc:
                await _fail(ws, str(exc) or "mossa non valida")
                continue

            await room.broadcast()
            room.pump()

    except WebSocketDisconnect:
        pass
    except Exception:  # pragma: no cover - difensivo
        log.exception("errore nella sessione websocket")
    finally:
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
        # Dietro il proxy dell'host: senza, uvicorn non si fida di
        # X-Forwarded-Proto e i log mostrano tutto come http.
        proxy_headers=True,
        forwarded_allow_ips=os.environ.get("TRANS_FORWARDED_IPS", "*"),
    )


if __name__ == "__main__":
    main()
