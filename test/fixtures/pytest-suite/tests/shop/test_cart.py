import pytest


@pytest.mark.smoke
def test_opens(browser_name):
    assert browser_name == "chromium"


class TestCart:
    @pytest.mark.parametrize("qty", [1, 2])
    def test_quantity(self, browser_name, qty):
        assert qty > 0


def test_total_is_wrong():
    assert 1 + 1 == 3, "the total is wrong"


@pytest.mark.skip(reason="not today")
def test_skipped():
    pass


@pytest.mark.xfail(reason="known bug")
def test_known_bug():
    assert False


def test_teardown_breaks(breaks_on_teardown):
    pass
