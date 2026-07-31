from src.ui import fluent_support
from src.ui.styles.theme import Theme


def test_setup_fluent_app_returns_false_when_module_unavailable(monkeypatch):
    monkeypatch.setattr(fluent_support, "import_qfluentwidgets", lambda: None)

    assert fluent_support.setup_fluent_app(None) is False


def test_setup_fluent_app_applies_theme_when_available(monkeypatch):
    events = []

    class DummyTheme:
        AUTO = "AUTO"

    class DummyQfw:
        Theme = DummyTheme

        @staticmethod
        def setTheme(value):
            events.append(("setTheme", value))

        @staticmethod
        def setThemeColor(value):
            events.append(("setThemeColor", value))

    monkeypatch.setattr(fluent_support, "import_qfluentwidgets", lambda: DummyQfw)

    assert fluent_support.setup_fluent_app(None) is True
    assert ("setTheme", "AUTO") in events
    assert ("setThemeColor", Theme.PRIMARY) in events


def test_setup_fluent_app_uses_dark_theme_when_requested(monkeypatch):
    events = []

    class DummyTheme:
        AUTO = "AUTO"
        DARK = "DARK"
        LIGHT = "LIGHT"

    class DummyQfw:
        Theme = DummyTheme

        @staticmethod
        def setTheme(value):
            events.append(("setTheme", value))

        @staticmethod
        def setThemeColor(value):
            events.append(("setThemeColor", value))

    monkeypatch.setattr(fluent_support, "import_qfluentwidgets", lambda: DummyQfw)

    assert fluent_support.setup_fluent_app(None, "dark") is True
    assert ("setTheme", "DARK") in events


def test_get_fluent_widget_returns_none_when_unavailable(monkeypatch):
    fluent_support.reset_fluent_cache()
    monkeypatch.setattr(fluent_support, "import_qfluentwidgets", lambda: None)

    assert fluent_support.get_fluent_widget("PushButton") is None


def test_get_fluent_widget_returns_class_when_available(monkeypatch):
    fluent_support.reset_fluent_cache()

    class DummyPushButton:
        pass

    class DummyQfw:
        PushButton = DummyPushButton

    monkeypatch.setattr(fluent_support, "import_qfluentwidgets", lambda: DummyQfw)

    assert fluent_support.get_fluent_widget("PushButton") is DummyPushButton
