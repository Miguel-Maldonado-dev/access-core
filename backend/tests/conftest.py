import pytest

from acceso.db import connect
from acceso.schema import create_schema


@pytest.fixture
def conn(tmp_path):
    connection = connect(tmp_path / "test.sqlite")
    create_schema(connection)
    yield connection
    connection.close()
