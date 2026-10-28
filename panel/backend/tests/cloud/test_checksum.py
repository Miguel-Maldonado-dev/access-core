"""Checksum de tabla: el mismo algoritmo y el mismo vector que la nube (cloud/tests/device/checksum.test.ts)."""
import hashlib

from acceso.cloud.checksum import canonical_json, table_checksum


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_fixed_vector_is_identical_to_the_cloud():
    rows = [
        {"id": "b", "data": {"x": 1}},
        {"id": "a", "data": {"y": True, "a": "ñ"}},
    ]
    assert table_checksum(rows) == sha256('a\t{"a":"ñ","y":true}\nb\t{"x":1}\n')
    assert table_checksum(rows) == "026fefb4433323a03b0674781e012f222872a6e79f204d1e6c01364e39a0e227"


def test_does_not_depend_on_input_order_and_empty_table_is_sha256_of_empty_string():
    rows = [{"id": "c", "data": {"n": 3}}, {"id": "a", "data": {"n": 1}}, {"id": "b", "data": {"n": 2}}]
    assert table_checksum(rows) == table_checksum(list(reversed(rows)))
    assert table_checksum([]) == sha256("")


def test_orders_by_id_with_plain_string_comparison():
    rows = [{"id": "a", "data": {}}, {"id": "B", "data": {}}]
    assert table_checksum(rows) == sha256("B\t{}\na\t{}\n")


def test_canonical_json_matches_the_cloud_output():
    data = {"b": 'a"\\\n\u0001\u007f é😀', "a": None, "c": [1, {"z": False, "y": None}]}
    assert canonical_json(data) == '{"a":null,"b":"a\\"\\\\\\n\\u0001\u007f é😀","c":[1,{"y":null,"z":false}]}'
