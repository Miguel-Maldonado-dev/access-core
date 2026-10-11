"""Modelos pydantic de la API."""
from typing import List, Optional

from pydantic import BaseModel, Field, field_validator

from acceso.constants import CONTROL_BUTTONS, HOLDER_KINDS, MAX_CODE, OUTPUT_COUNT


class HolderIn(BaseModel):
    kind: str
    name: str
    department: str = ""
    address: str = ""
    notes: str = ""
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
    reader_mask: int = Field(ge=0, le=15)
    weekday_mask: int = Field(ge=0, le=127)
    start_minute: int = Field(ge=0, le=1439)
    end_minute: int = Field(ge=0, le=1439)


class PermissionCreate(PermissionBody):
    permission_id: int = Field(ge=0, le=31)


class OutputIn(BaseModel):
    duration_ms: int = Field(ge=0, le=65535)
    reader_mask: int = Field(ge=0, le=15)
    enabled: bool


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

    @field_validator("output_id")
    @classmethod
    def _output(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and not 0 <= v < OUTPUT_COUNT:
            raise ValueError("La salida debe estar entre 0 y %d." % (OUTPUT_COUNT - 1))
        return v


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
