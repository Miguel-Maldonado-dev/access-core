from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from acceso.daemon_socket import DaemonUnavailable, request_daemon
from acceso.rf_listen import LISTEN_CLIENT_TIMEOUT_S
from acceso.store import controls
from acceso.web.deps import get_conn
from acceso.web.schemas import ControlIn

router = APIRouter(prefix="/api/controls")


def _buttons(body: ControlIn):
    return [controls.ButtonData(b.rf_code, b.output_id) for b in body.buttons]


@router.get("")
def list_(holder_id: Optional[int] = None, conn=Depends(get_conn)):
    return controls.list_controls(conn, holder_id)


@router.post("/listen")
def listen(request: Request):
    """Espera hasta 10 s el siguiente control RF y devuelve su código (y el control, si ya existe)."""
    # `app.state.daemon_request` permite sustituir al daemon en las pruebas.
    ask = getattr(request.app.state, "daemon_request", request_daemon)
    try:
        reply = ask(request.app.state.settings.daemon_socket, {"op": "listen_rf"},
                    timeout=LISTEN_CLIENT_TIMEOUT_S)
    except DaemonUnavailable:
        raise HTTPException(status_code=503, detail="El daemon no responde")
    if reply.get("ok") is True:
        code = reply.get("code")
        if isinstance(code, bool) or not isinstance(code, int) or not 0 <= code <= 4294967295:
            raise HTTPException(status_code=503, detail="Código RF inválido")
        return {"code": code, "control": reply.get("control")}
    detail = str(reply.get("detail") or "")
    if detail == "Ya hay una escucha en curso.":
        raise HTTPException(status_code=409, detail=detail)
    if detail == "No se recibió ningún control.":
        return {"code": None, "control": None}
    raise HTTPException(status_code=503, detail=detail or "El daemon no responde")


@router.post("", status_code=201)
def create(body: ControlIn, conn=Depends(get_conn)):
    control_id = controls.create_control(conn, body.holder_id, body.description, _buttons(body))
    return controls.get_control(conn, control_id)


@router.put("/{control_id}")
def update(control_id: int, body: ControlIn, conn=Depends(get_conn)):
    controls.update_control(conn, control_id, body.holder_id, body.description, _buttons(body))
    return controls.get_control(conn, control_id)


@router.delete("/{control_id}", status_code=204)
def delete(control_id: int, conn=Depends(get_conn)):
    controls.delete_control(conn, control_id)
    return Response(status_code=204)
