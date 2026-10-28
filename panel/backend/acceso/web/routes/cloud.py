from fastapi import APIRouter, Depends

from acceso.cloud.identity import get_state
from acceso.web.deps import get_conn

router = APIRouter(prefix="/api/cloud")


@router.get("/status")
def status(conn=Depends(get_conn)):
    """Estado de la vinculación con la nube. Solo lee: nunca expone panel_secret ni el token."""
    panel_code = get_state(conn, "panel_code") or None
    state = get_state(conn, "state") or "unlinked"
    claim_code = (get_state(conn, "claim_code") or None) if panel_code and state == "unlinked" else None
    pending = conn.execute("SELECT COUNT(*) FROM sync_outbox").fetchone()[0]
    return {
        "panel_code": panel_code,
        "claim_code": claim_code,
        "state": state,
        "installation_name": get_state(conn, "installation_name") or None,
        "last_sync_at": get_state(conn, "last_sync_at") or None,
        "cloud_revision": int(get_state(conn, "cloud_revision") or 0),
        "pending_changes": pending,
        "last_error": get_state(conn, "last_error") or None,
    }
