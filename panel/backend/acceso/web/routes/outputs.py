from fastapi import APIRouter, Depends

from acceso.store import outputs
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
