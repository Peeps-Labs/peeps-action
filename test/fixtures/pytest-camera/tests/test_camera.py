import logging
import sys

import pytest

MODEL = "X"


def test_unsupported_model():
    pytest.skip(f"not supported on model {MODEL}")


@pytest.mark.skipif(MODEL == "X", reason="needs a thermal sensor")
def test_thermal():
    pass


def test_sharpness(record_property):
    sharpness = 0.41
    record_property("sharpness", sharpness)
    record_property("exposure_ms", 12)
    record_property("lens", "wide")
    record_property("roi", {"x": 10, "y": 20})
    record_property("noise", float("nan"))
    print("focusing on target 3")
    print("sensor warm", file=sys.stderr)
    logging.getLogger("camera").warning("autofocus hunting")
    assert sharpness >= 0.6


def test_saves_frame(peeps_artifacts_dir, record_property, tmp_path):
    (peeps_artifacts_dir / "frame.png").write_bytes(b"\x89PNG\r\n\x1a\n fake frame")
    (peeps_artifacts_dir / "raw").mkdir()
    (peeps_artifacts_dir / "raw" / "frame.npy").write_bytes(b"\x93NUMPY fake")
    # Refused even in the artifacts directory, as the agent tools refuse it.
    (peeps_artifacts_dir / ".env").write_text("CAMERA_TOKEN=secret\n")
    histogram = tmp_path / "histogram.csv"
    histogram.write_text("bin,count\n0,1\n")
    record_property("peeps_attachment", str(histogram))
    # Outside the workspace and pytest's temporary directory: refused.
    record_property("peeps_attachment", "/etc/hosts")
    record_property("frames", 2)


def test_camera_offline(camera):
    pass
