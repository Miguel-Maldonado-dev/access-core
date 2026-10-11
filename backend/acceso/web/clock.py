"""Hora y estado de sincronización NTP de la placa."""
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Optional


@dataclass(frozen=True)
class ClockStatus:
    now: datetime
    timezone: str
    ntp_synchronized: Optional[bool]


def _timedatectl(run: Callable, prop: str) -> Optional[str]:
    try:
        result = run(
            ["timedatectl", "show", "-p", prop, "--value"],
            capture_output=True, text=True, timeout=5,
        )
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        return None
    if result.returncode != 0:
        return None
    return (result.stdout or "").strip()


def read_clock(run: Callable = subprocess.run) -> ClockStatus:
    ntp = _timedatectl(run, "NTPSynchronized")
    synchronized = {"yes": True, "no": False}.get(ntp) if ntp is not None else None
    tz = _timedatectl(run, "Timezone") or time.strftime("%Z")
    return ClockStatus(datetime.now().astimezone(), tz, synchronized)
