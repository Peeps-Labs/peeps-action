"""Stands in for pytest-playwright where it is not installed: parametrizes
`browser_name` the way it does, so node ids carry `[chromium...]`, and offers
its `--output` option and `output_path` fixture, writing a `trace.zip` per test
there the way `--tracing on` would."""

import os
import re

import pytest


def pytest_addoption(parser):
    try:
        parser.addoption("--output", default=None)
    except ValueError:  # pytest-playwright is installed and owns it
        pass


def pytest_generate_tests(metafunc):
    if "browser_name" in metafunc.fixturenames and not metafunc.config.pluginmanager.hasplugin(
        "playwright"
    ):
        metafunc.parametrize("browser_name", ["chromium"], scope="session")


@pytest.fixture
def output_path(pytestconfig, request):
    output = pytestconfig.getoption("--output")
    if output is None:
        return None
    return os.path.join(os.path.abspath(output), re.sub(r"[^a-z0-9]+", "-", request.node.nodeid.lower()))


@pytest.fixture(autouse=True)
def _fake_trace(output_path):
    yield
    if output_path:
        os.makedirs(output_path, exist_ok=True)
        with open(os.path.join(output_path, "trace.zip"), "wb") as handle:
            handle.write(b"PK fake trace")


@pytest.fixture
def breaks_on_teardown():
    yield
    raise RuntimeError("teardown broke")
