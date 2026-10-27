from typing import Optional

from fastapi import APIRouter, Depends, Response

from acceso.store import cards
from acceso.web.deps import get_conn
from acceso.web.schemas import CardCreate, CardIn

router = APIRouter(prefix="/api/cards")


@router.get("")
def list_(holder_id: Optional[int] = None, conn=Depends(get_conn)):
    return cards.list_cards(conn, holder_id)


@router.post("", status_code=201)
def create(body: CardCreate, conn=Depends(get_conn)):
    cards.create_card(conn, body.card_code, body.holder_id, body.description)
    return cards.get_card(conn, body.card_code)


@router.put("/{code}")
def update(code: int, body: CardIn, conn=Depends(get_conn)):
    cards.update_card(conn, code, body.holder_id, body.description)
    return cards.get_card(conn, code)


@router.delete("/{code}", status_code=204)
def delete(code: int, conn=Depends(get_conn)):
    cards.delete_card(conn, code)
    return Response(status_code=204)
