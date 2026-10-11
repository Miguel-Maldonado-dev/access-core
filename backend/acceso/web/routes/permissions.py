from fastapi import APIRouter, Depends, Response

from acceso.store import permissions
from acceso.web.deps import get_conn
from acceso.web.schemas import PermissionBody, PermissionCreate

router = APIRouter(prefix="/api/permissions")


def _get(conn, permission_id: int) -> dict:
    return next(p for p in permissions.list_permissions(conn) if p["permission_id"] == permission_id)


@router.get("")
def list_(conn=Depends(get_conn)):
    return permissions.list_permissions(conn)


@router.post("", status_code=201)
def create(body: PermissionCreate, conn=Depends(get_conn)):
    permissions.create_permission(conn, body.model_dump())
    return _get(conn, body.permission_id)


@router.put("/{permission_id}")
def update(permission_id: int, body: PermissionBody, conn=Depends(get_conn)):
    permissions.update_permission(conn, permission_id, body.model_dump())
    return _get(conn, permission_id)


@router.delete("/{permission_id}", status_code=204)
def delete(permission_id: int, conn=Depends(get_conn)):
    permissions.delete_permission(conn, permission_id)
    return Response(status_code=204)
