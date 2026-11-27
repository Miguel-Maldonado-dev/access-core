import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response

from acceso.qr import get_qr_settings
from acceso.store import qr_codes
from acceso.web.deps import get_conn
from acceso.web.schemas import QrCreate, QrSettingsIn

router = APIRouter(prefix="/api")


def _iso(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


def _out(qr: dict) -> dict:
    return {**qr, "valid_from": _iso(qr["valid_from"]), "valid_until": _iso(qr["valid_until"])}


@router.get("/qr-codes")
def list_(holder_id: Optional[int] = None, conn=Depends(get_conn)):
    return [_out(q) for q in qr_codes.list_qr(conn, holder_id, int(time.time()))]


@router.post("/qr-codes", status_code=201)
def create(body: QrCreate, conn=Depends(get_conn)):
    try:
        qr = qr_codes.create_qr(conn, body.holder_id, body.label, body.valid_from, body.valid_until,
                                body.max_uses, int(time.time()))
    except qr_codes.QrUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    return _out(qr)


@router.delete("/qr-codes/{qr_id}", status_code=204)
def delete(qr_id: int, conn=Depends(get_conn)):
    qr_codes.delete_qr(conn, qr_id)
    return Response(status_code=204)


def _settings(conn) -> dict:
    s = get_qr_settings(conn)
    return {"digit": s.digit, "max_active": s.max_active, "editable": not qr_codes.is_linked(conn)}


@router.get("/qr-settings")
def get_settings(conn=Depends(get_conn)):
    return _settings(conn)


@router.put("/qr-settings")
def put_settings(body: QrSettingsIn, conn=Depends(get_conn)):
    qr_codes.update_qr_settings(conn, body.digit, body.max_active)
    return _settings(conn)
