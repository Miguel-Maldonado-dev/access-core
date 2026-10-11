import pytest

from acceso.protocol import (
    SOF, EOF_MARKER, CardRead, RfRead, ExitButton, InvalidFrame,
    FrameParser, build_relay_command, checksum,
)


def frame(cmd, payload):
    return bytes([SOF, cmd, *payload, checksum(bytes([cmd, *payload])), EOF_MARKER])


def test_card_frame_from_protocol_doc():
    assert FrameParser().feed(bytes.fromhex("AA10000081FB6F0555")) == [CardRead(reader=0, code=8518511)]


def test_rf_and_exit_frames_from_protocol_doc():
    assert FrameParser().feed(bytes.fromhex("AA11A1234567B155") + bytes.fromhex("AA12011355")) == [RfRead(0xA1234567), ExitButton(1)]


def test_frame_split_across_reads():
    p = FrameParser(); data = bytes.fromhex("AA10000081FB6F0555")
    assert p.feed(data[:4]) == [] and p.feed(data[4:]) == [CardRead(0, 8518511)]


def test_garbage_and_unknown_command_are_skipped():   # riesgo 1
    assert FrameParser().feed(b"\x00\xff\xaa\x99" + b"\xaa" + frame(0x11, [0, 0, 0, 1])) == [RfRead(1)]


def test_bad_checksum_reported_then_parser_recovers():
    out = FrameParser().feed(bytes.fromhex("AA11A12345670055") + frame(0x12, [0]))
    assert isinstance(out[0], InvalidFrame) and out[0].reason == "checksum" and out[1] == ExitButton(0)


def test_out_of_range_ids_are_invalid():
    out = FrameParser().feed(frame(0x10, [7, 0, 0, 0, 1]) + frame(0x12, [2]))
    assert [o.reason for o in out] == ["lector 7 fuera de rango", "botón de salida 2 fuera de rango"]


def test_build_relay_command_matches_doc_and_validates():
    assert build_relay_command(1, 5000) == bytes.fromhex("AA20011388BA55")
    for bad in [(4, 1000), (-1, 1000), (0, 65536)]:
        with pytest.raises(ValueError):
            build_relay_command(*bad)
