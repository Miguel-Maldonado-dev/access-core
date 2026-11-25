from fastapi import APIRouter, Depends, HTTPException, Request

from acceso.daemon_socket import DaemonUnavailable, request_daemon
from acceso.store import call_settings
from acceso.web.deps import get_conn
from acceso.web.schemas import CallSettingsIn

router = APIRouter(prefix="/api/calls")


@router.get("/settings")
def get_settings(conn=Depends(get_conn)):
    return call_settings.get_settings(conn)


@router.put("/settings")
def put_settings(body: CallSettingsIn, conn=Depends(get_conn)):
    call_settings.update_settings(conn, body.model_dump())
    return call_settings.get_settings(conn)


@router.get("/status")
def status(request: Request):
    # `app.state.daemon_request` permite sustituir al daemon en las pruebas.
    ask = getattr(request.app.state, "daemon_request", request_daemon)
    try:
        return ask(request.app.state.settings.daemon_socket, {"op": "gsm_status"})
    except DaemonUnavailable:
        raise HTTPException(status_code=503, detail="El daemon no responde")
