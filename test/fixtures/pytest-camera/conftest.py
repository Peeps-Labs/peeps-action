"""A camera test suite the way a hardware team writes one: no browser, just
measurements, skips per model, and frames saved to disk."""

import pytest


class CameraError(Exception):
    pass


@pytest.fixture
def camera():
    raise CameraError("camera 2 did not answer")


def pytest_collection_modifyitems(items):
    # Set at collection, before any attempt: belongs to every attempt.
    for item in items:
        if item.name == "test_sharpness":
            item.user_properties.append(("rig", "bench-2"))


@pytest.fixture
def session_log(tmp_path, record_property):
    # Attached while tearing down, into a tmp_path that is deleted right after.
    yield
    log = tmp_path / "session.log"
    log.write_text("closed\n")
    record_property("peeps_attachment", str(log))
