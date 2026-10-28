"""Modelos pydantic de la API."""
import re
from typing import List, Optional

from pydantic import BaseModel, Field, StrictBool, StrictInt, field_validator, model_validator

from acceso.constants import (
    CONTROL_BUTTONS, HOLDER_KINDS, MAX_CODE, OUTPUT_ALIAS_MAX, PIN_MAX_DIGITS, PIN_MIN_DIGITS,
)


STALE_PANEL_MESSAGE = "El panel está desactualizado: recarga la página (Ctrl+F5) y vuelve a intentar."


class HolderIn(BaseModel):
    kind: str
    name: str
    department: str = ""
    address: str = ""
    notes: str = ""
    pin: Optional[str] = None
    permission_ids: List[int] = Field(default_factory=list)

    @field_validator("kind")
    @classmethod
    def _kind(cls, v: str) -> str:
        if v not in HOLDER_KINDS:
            raise ValueError("El tipo de titular debe ser: %s." % ", ".join(HOLDER_KINDS))
        return v

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("El nombre es obligatorio.")
        return v

    @field_validator("pin")
    @classmethod
    def _pin(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        if not re.fullmatch(r"[0-9]{%d,%d}" % (PIN_MIN_DIGITS, PIN_MAX_DIGITS), v):
            raise ValueError("El PIN debe tener de %d a %d dígitos." % (PIN_MIN_DIGITS, PIN_MAX_DIGITS))
        return v

    @field_validator("permission_ids")
    @classmethod
    def _perm_ids(cls, v: List[int]) -> List[int]:
        for pid in v:
            if not 0 <= pid <= 31:
                raise ValueError("El permiso debe estar entre 0 y 31.")
        return v


class PermissionBody(BaseModel):
    name: str = ""
    output_mask: int = Field(ge=0, le=15)
    card_reader_mask: StrictInt = Field(default=0, ge=0, le=15)
    pin_reader_mask: StrictInt = Field(default=0, ge=0, le=15)
    weekday_mask: int = Field(ge=0, le=127)
    start_minute: int = Field(ge=0, le=1439)
    end_minute: int = Field(ge=0, le=1439)
    allow_rf: StrictBool = False

    @model_validator(mode="before")
    @classmethod
    def _reject_v4_fields(cls, data):
        if isinstance(data, dict) and ("reader_mask" in data or "allow_pin" in data):
            raise ValueError(STALE_PANEL_MESSAGE)
        return data


class PermissionCreate(PermissionBody):
    card_reader_mask: StrictInt = Field(ge=0, le=15)
    pin_reader_mask: StrictInt = Field(ge=0, le=15)
    allow_rf: StrictBool
    permission_id: int = Field(ge=0, le=31)


class OutputIn(BaseModel):
    duration_ms: int = Field(ge=0, le=65535)
    reader_mask: int = Field(ge=0, le=15)
    enabled: bool
    alias: Optional[str] = None  # None: conservar el actual

    @field_validator("alias")
    @classmethod
    def _alias(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        if len(v) > OUTPUT_ALIAS_MAX:
            raise ValueError("El alias no puede pasar de %d caracteres." % OUTPUT_ALIAS_MAX)
        return v


def _check_code(v: Optional[int]) -> Optional[int]:
    if v is not None and not 0 <= v <= MAX_CODE:
        raise ValueError("El código debe estar entre 0 y %d." % MAX_CODE)
    return v


class CardIn(BaseModel):
    holder_id: int
    description: str = ""


class CardCreate(CardIn):
    card_code: int

    @field_validator("card_code")
    @classmethod
    def _code(cls, v: int) -> int:
        return _check_code(v)


class ButtonIn(BaseModel):
    rf_code: Optional[int] = None
    output_id: Optional[int] = None

    @field_validator("rf_code")
    @classmethod
    def _rf(cls, v: Optional[int]) -> Optional[int]:
        return _check_code(v)


class ControlIn(BaseModel):
    holder_id: int
    description: str = ""
    buttons: List[ButtonIn]

    @field_validator("buttons")
    @classmethod
    def _buttons(cls, v: List[ButtonIn]) -> List[ButtonIn]:
        if len(v) != CONTROL_BUTTONS:
            raise ValueError("El control debe tener exactamente %d botones." % CONTROL_BUTTONS)
        return v
