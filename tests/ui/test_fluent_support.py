from src.ui import fluent_support


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
    assert ("setThemeColor", "#4A90E2") in events


def test_get_fluent_widget_returns_none_when_unavailable(monkeypatch):
    monkeypatch.setattr(fluent_support, "import_qfluentwidgets", lambda: None)

    assert fluent_support.get_fluent_widget("PushButton") is None


def test_get_fluent_widget_returns_class_when_available(monkeypatch):
    class DummyPushButton:
        pass

    class DummyQfw:
        PushButton = DummyPushButton

    monkeypatch.setattr(fluent_support, "import_qfluentwidgets", lambda: DummyQfw)

    assert fluent_support.get_fluent_widget("PushButton") is DummyPushButton
