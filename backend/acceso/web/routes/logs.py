from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Query, Response

from acceso import logs
from acceso.db import transaction
from acceso.web.deps import get_conn

router = APIRouter(prefix="/api/logs")


@router.get("")
def list_(
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    holder_id: Optional[int] = None,
    allowed: Optional[bool] = None,
    source: Optional[int] = Query(None, ge=0, le=2),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    conn=Depends(get_conn),
):
    filters = logs.LogFilters(date_from, date_to, holder_id, allowed, source)
    items, total = logs.query_logs(conn, filters, page, page_size)
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.delete("", status_code=204)
def clear(conn=Depends(get_conn)):
    with transaction(conn):
        logs.clear_logs(conn)
    return Response(status_code=204)
