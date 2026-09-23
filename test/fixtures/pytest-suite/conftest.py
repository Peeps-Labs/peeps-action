"""Stands in for pytest-playwright where it is not installed: parametrizes
`browser_name` the way it does, so node ids carry `[chromium...]`."""

import pytest


def pytest_generate_tests(metafunc):
    if "browser_name" in metafunc.fixturenames and not metafunc.config.pluginmanager.hasplugin(
        "playwright"
    ):
        metafunc.parametrize("browser_name", ["chromium"], scope="session")


@pytest.fixture
def breaks_on_teardown():
    yield
    raise RuntimeError("teardown broke")
