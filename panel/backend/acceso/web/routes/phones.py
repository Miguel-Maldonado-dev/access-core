from typing import Optional

from fastapi import APIRouter, Depends, Response

from acceso.store import call_settings, phones
from acceso.web.deps import get_conn
from acceso.web.schemas import PhoneIn

router = APIRouter(prefix="/api/phones")


@router.get("")
def list_(holder_id: Optional[int] = None, conn=Depends(get_conn)):
    return phones.list_phones(conn, holder_id)


@router.post("", status_code=201)
def create(body: PhoneIn, conn=Depends(get_conn)):
    call_settings.require_enabled(conn)
    phone_id = phones.create_phone(conn, body.holder_id, body.number, body.description)
    return phones.get_phone(conn, phone_id)


@router.put("/{phone_id}")
def update(phone_id: int, body: PhoneIn, conn=Depends(get_conn)):
    phones.update_phone(conn, phone_id, body.holder_id, body.number, body.description)
    return phones.get_phone(conn, phone_id)


@router.delete("/{phone_id}", status_code=204)
def delete(phone_id: int, conn=Depends(get_conn)):
    phones.delete_phone(conn, phone_id)
    return Response(status_code=204)
