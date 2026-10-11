from typing import List, Optional

from fastapi import APIRouter, Depends, Response

from acceso.store import holders
from acceso.web.deps import get_conn
from acceso.web.schemas import HolderIn

router = APIRouter(prefix="/api/holders")


def _data(body: HolderIn) -> holders.HolderData:
    return holders.HolderData(
        kind=body.kind, name=body.name, department=body.department,
        address=body.address, notes=body.notes, permission_ids=tuple(body.permission_ids),
    )


@router.get("")
def list_(q: Optional[str] = None, conn=Depends(get_conn)):
    return holders.list_holders(conn, q)


@router.post("", status_code=201)
def create(body: HolderIn, conn=Depends(get_conn)):
    return holders.get_holder(conn, holders.create_holder(conn, _data(body)))


@router.get("/{holder_id}")
def get(holder_id: int, conn=Depends(get_conn)):
    return holders.get_holder(conn, holder_id)


@router.put("/{holder_id}")
def update(holder_id: int, body: HolderIn, conn=Depends(get_conn)):
    holders.update_holder(conn, holder_id, _data(body))
    return holders.get_holder(conn, holder_id)


@router.delete("/{holder_id}", status_code=204)
def delete(holder_id: int, conn=Depends(get_conn)):
    holders.delete_holder(conn, holder_id)
    return Response(status_code=204)
