from fastapi import APIRouter, Request

router = APIRouter()


@router.get("/api/system/clock")
def clock(request: Request):
    status = request.app.state.clock_reader()
    return {
        "now": status.now.isoformat(),
        "timezone": status.timezone,
        "ntp_synchronized": status.ntp_synchronized,
    }
