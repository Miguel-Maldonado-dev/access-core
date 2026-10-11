"""Errores de dominio; la web los traduce a 404, 409 y 422."""


class NotFound(Exception):
    """El registro pedido no existe."""


class Conflict(Exception):
    """La operación choca con datos existentes."""


class Invalid(Exception):
    """Los datos recibidos no son válidos."""
