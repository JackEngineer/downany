from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
ELECTRON_BUILDER_CONFIG = REPO_ROOT / "desktop" / "electron-builder.yml"
NSIS_INCLUDE = REPO_ROOT / "desktop" / "build" / "installer.nsh"


def test_windows_installer_loads_protocol_cleanup_include() -> None:
    config = ELECTRON_BUILDER_CONFIG.read_text(encoding="utf-8")

    assert "  include: build/installer.nsh\n" in config
    assert NSIS_INCLUDE.is_file()


def test_protocol_cleanup_only_deletes_registration_owned_by_install() -> None:
    script = NSIS_INCLUDE.read_text(encoding="utf-8")

    read_owned_command = (
        'ReadRegStr $0 ${ROOT_KEY} '
        '"Software\\Classes\\downany\\shell\\open\\command" ""'
    )
    expected_command = (
        "StrCpy $1 '\"$INSTDIR\\${APP_EXECUTABLE_FILENAME}\" \"%1\"'"
    )
    guarded_delete = (
        'DeleteRegKey ${ROOT_KEY} "Software\\Classes\\downany"'
    )

    assert "!macro deleteDownanyProtocolIfOwned ROOT_KEY" in script
    assert read_owned_command in script
    assert expected_command in script
    assert "${If} $0 == $1" in script
    assert guarded_delete in script
    assert script.index(read_owned_command) < script.index(expected_command)
    assert script.index(expected_command) < script.index("${If} $0 == $1")
    assert script.index("${If} $0 == $1") < script.index(guarded_delete)
    assert "!insertmacro deleteDownanyProtocolIfOwned SHELL_CONTEXT" in script
    assert "!insertmacro deleteDownanyProtocolIfOwned HKCU" in script


def test_custom_uninstall_removes_the_empty_install_directory() -> None:
    script = NSIS_INCLUDE.read_text(encoding="utf-8")

    custom_uninstall = script.index("!macro customUnInstall")
    leave_install_dir = script.index('SetOutPath "$TEMP"')
    remove_install_dir = script.index('RMDir "$INSTDIR"')

    assert custom_uninstall < leave_install_dir < remove_install_dir
