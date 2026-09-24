"""A camera test suite the way a hardware team writes one: no browser, just
measurements, skips per model, and frames saved to disk."""

import pytest


class CameraError(Exception):
    pass


@pytest.fixture
def camera():
    raise CameraError("camera 2 did not answer")
