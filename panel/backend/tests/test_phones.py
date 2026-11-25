import pytest

from acceso.phones import normalize_phone, parse_phone_input


@pytest.mark.parametrize("raw,expected", [
    ("+5215512345678", "5512345678"), ("525512345678", "5512345678"),
    ("55 1234-5678", "5512345678"), ("5512345678", "5512345678"),
    ("", None), ("12345", None), ("15551234567", None)])
def test_normalize_phone(raw, expected):
    assert normalize_phone(raw) == expected


def test_parse_phone_input_cleans_spaces_and_dashes():
    assert parse_phone_input(" 55 1234-5678 ") == "5512345678"


@pytest.mark.parametrize("raw", ["551234", "55123456789", "55123456a8", "", "١٢٣٤٥٦٧٨٩٠"])
def test_parse_phone_input_rejects_bad(raw):
    with pytest.raises(ValueError, match="10 dígitos"):
        parse_phone_input(raw)
