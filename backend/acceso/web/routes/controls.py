from typing import Optional

from fastapi import APIRouter, Depends, Response

from acceso.store import controls
from acceso.web.deps import get_conn
from acceso.web.schemas import ControlIn

router = APIRouter(prefix="/api/controls")


def _buttons(body: ControlIn):
    return [controls.ButtonData(b.rf_code, b.output_id) for b in body.buttons]


@router.get("")
def list_(holder_id: Optional[int] = None, conn=Depends(get_conn)):
    return controls.list_controls(conn, holder_id)


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
