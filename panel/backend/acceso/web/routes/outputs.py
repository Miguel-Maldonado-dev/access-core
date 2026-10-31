from fastapi import APIRouter, Depends, HTTPException, Request

from acceso.daemon_socket import DaemonUnavailable, request_daemon
from acceso.store import outputs
from acceso.store.errors import NotFound
from acceso.web.deps import get_conn
from acceso.web.schemas import OutputIn

router = APIRouter(prefix="/api/outputs")


@router.get("")
def list_(conn=Depends(get_conn)):
    return outputs.list_outputs(conn)


@router.put("/{output_id}")
def update(output_id: int, body: OutputIn, conn=Depends(get_conn)):
    outputs.update_output(conn, output_id, body.duration_ms, body.reader_mask, body.enabled,
                          body.alias)
    return next(o for o in outputs.list_outputs(conn) if o["output_id"] == output_id)


@router.post("/{output_id}/test")
def test_output(output_id: int, request: Request, conn=Depends(get_conn)):
    """Pide al daemon activar la salida (no valida titulares ni permisos; sirve también si está deshabilitada)."""
    if not any(o["output_id"] == output_id for o in outputs.list_outputs(conn)):
        raise NotFound("La salida %d no existe." % (output_id + 1))  # numeración visible, base 1
    # `app.state.daemon_request` permite sustituir al daemon en las pruebas.
    ask = getattr(request.app.state, "daemon_request", request_daemon)
    try:
        reply = ask(request.app.state.settings.daemon_socket,
                    {"op": "test_output", "output": output_id, "requested_by": "web local"})
    except DaemonUnavailable:
        raise HTTPException(status_code=503, detail="El daemon no responde")
    if reply.get("ok") is True:
        return {"detail": "Salida activada"}
    raise HTTPException(status_code=409, detail=str(reply.get("detail") or "No se pudo activar la salida."))
