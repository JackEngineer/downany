import json
import sqlite3
from unittest.mock import MagicMock, patch
import pytest
from src.core.download_task import DownloadOptions, DownloadTask, VideoInfo, Platform, TaskStatus
from src.core.login_policy import effective_login_options
from src.core.output_contract import compile_output_plan
from src.core.download_manager import DownloadManager
from src.core.url_parser import ParseResult
from src.data.json_config import JsonConfig
from src.data.queue_store import QueueStore
from src.data.database import HistoryDB
from src.sidecar.handlers import HandlerContext, dispatch, HandlerError
from src.sidecar.paths import AppPaths
from src.sidecar.protocol import Method
import src.sidecar.handlers as handlers

def config_and_manager(tmp_path):
    cfg = JsonConfig(str(tmp_path / "config.json"))
    cfg.set_download_dir(str(tmp_path / "downloads"))
    cfg.update_from_dict({"cookies_from_browser": "chrome", "cookiefile": str(tmp_path / "unused-cookie-file")})
    store = QueueStore(str(tmp_path / "queue.db"))
    manager = DownloadManager(config=cfg, db=MagicMock(), queue_store=store)
    return cfg, store, manager

def test_none_removes_credentials_without_mutating_default_options():
    original = DownloadOptions(cookies_from_browser="chrome", cookiefile="/unused/cookie-file",
        http_headers={"Cookie":"not-a-real-cookie","Authorization":"not-a-real-token","X-CSRF-Token":"not-real",
                      "Referer":"https://example.com","User-Agent":"public-test-agent"})
    result = effective_login_options(original, "none")
    assert result.cookies_from_browser == result.cookiefile == ""
    assert result.http_headers == {"Referer":"https://example.com","User-Agent":"public-test-agent"}
    assert original.cookies_from_browser == "chrome"
    assert original.http_headers["Cookie"] == "not-a-real-cookie"

def test_plan_defensively_ignores_stale_auth_for_none():
    task = DownloadTask(video_info=VideoInfo(url="https://x.com/example/status/123"),
        options=DownloadOptions(login_mode="none",cookies_from_browser="chrome",cookiefile="/unused/cookie-file",
                                http_headers={"Cookie":"not-real","Referer":"https://x.com"}))
    opts = compile_output_plan(task).to_ydl_options()
    assert "cookiesfrombrowser" not in opts and "cookiefile" not in opts
    assert opts["http_headers"]["Referer"] == "https://x.com"
    assert "Cookie" not in opts["http_headers"] and "Authorization" not in opts["http_headers"]

@pytest.mark.parametrize("status",[TaskStatus.FAILED,TaskStatus.CANCELLED,TaskStatus.PAUSED])
def test_queue_restore_persists_explicit_none(tmp_path,status):
    _, store, manager = config_and_manager(tmp_path)
    task = DownloadTask(video_info=VideoInfo(url="https://example.com"),status=status,
                        options=effective_login_options(DownloadOptions(cookies_from_browser="chrome"),"none"))
    store.upsert_task(task)
    restored = store.load_tasks()[0]
    assert restored.id == task.id and restored.status == status
    assert restored.options.login_mode == "none"
    assert restored.options.cookies_from_browser == ""
    assert restored.to_snapshot().login_mode == "none"
    manager.tasks[restored.id] = restored
    if status != TaskStatus.PAUSED:
        manager.retry_task(restored.id)
        assert restored.options.cookies_from_browser == ""
        assert restored.options.login_mode == "none"

def test_legacy_options_restore_as_inherit(tmp_path):
    _,store,_=config_and_manager(tmp_path)
    task=DownloadTask(video_info=VideoInfo(url="https://example.com"),options=DownloadOptions(cookies_from_browser="chrome"))
    store.upsert_task(task)
    with sqlite3.connect(tmp_path/"queue.db") as conn:
        raw=json.loads(conn.execute("SELECT options_json FROM task_queue WHERE id=?",(task.id,)).fetchone()[0])
        raw.pop("login_mode")
        conn.execute("UPDATE task_queue SET options_json=? WHERE id=?",(json.dumps(raw),task.id))
    restored=store.load_tasks()[0]
    assert restored.options.login_mode=="inherit" and restored.options.cookies_from_browser=="chrome"

@pytest.mark.parametrize("status",[TaskStatus.FAILED,TaskStatus.CANCELLED])
def test_explicit_retry_is_same_id_idempotent_and_does_not_change_global(tmp_path,status):
    cfg,store,manager=config_and_manager(tmp_path)
    task=DownloadTask(video_info=VideoInfo(url="https://x.com/example/status/123"),status=status,
        options=DownloadOptions(output_path="/chosen-output",quality="480p",audio_only=True,cookies_from_browser="chrome",
                                http_headers={"Cookie":"not-real","Referer":"https://x.com"}))
    manager.tasks[task.id]=task;store.upsert_task(task)
    before=cfg.to_dict()
    manager.retry_with_login_mode(task.id,"none");manager.retry_with_login_mode(task.id,"none")
    assert len(manager.tasks)==1 and manager.get_task(task.id) is task
    assert task.status==TaskStatus.PENDING and task.options.login_mode=="none"
    assert task.options.cookies_from_browser==task.options.cookiefile==""
    assert task.options.quality=="480p" and task.options.audio_only and task.options.output_path=="/chosen-output"
    assert task.options.http_headers=={"Referer":"https://x.com"}
    assert cfg.to_dict()==before
    assert store.load_tasks()[0].options.login_mode=="none"

def test_inherit_keeps_existing_retry_behavior_and_can_be_explicitly_restored(tmp_path):
    cfg,store,manager=config_and_manager(tmp_path)
    task=DownloadTask(video_info=VideoInfo(url="https://example.com"),status=TaskStatus.FAILED,
                      options=DownloadOptions(cookies_from_browser="firefox"))
    manager.tasks[task.id]=task;manager.retry_task(task.id)
    assert task.options.login_mode=="inherit" and task.options.cookies_from_browser=="chrome"
    task.status=TaskStatus.FAILED;manager.retry_with_login_mode(task.id,"none")
    task.status=TaskStatus.FAILED;manager.retry_with_login_mode(task.id,"inherit")
    assert task.options.cookies_from_browser=="chrome"
    assert task.options.cookiefile==cfg.to_dict()["cookiefile"]
    assert cfg.to_dict()["cookies_from_browser"]=="chrome"

def test_mode_change_rejects_running_task_without_mutating_it(tmp_path):
    _,_,manager=config_and_manager(tmp_path)
    task=DownloadTask(status=TaskStatus.DOWNLOADING,options=DownloadOptions(cookies_from_browser="chrome"))
    manager.tasks[task.id]=task
    with pytest.raises(ValueError):
        manager.update_task(task.id,login_mode="none")
    with pytest.raises(ValueError):
        manager.retry_with_login_mode(task.id,"none")
    assert task.options.login_mode=="inherit" and task.options.cookies_from_browser=="chrome"

def make_context(tmp_path):
    cfg,store,manager=config_and_manager(tmp_path)
    paths=AppPaths(data_dir=tmp_path/"data",log_dir=tmp_path/"logs").ensure()
    return HandlerContext(config=cfg,db=MagicMock(),manager=manager,emit_event=lambda *_:None,paths=paths)

def test_creation_overrides_only_selected_item(tmp_path):
    ctx=make_context(tmp_path)
    reply=dispatch(ctx,Method.DOWNLOAD_CREATE_TASKS.value,{"urls":["https://example.com/a","https://example.com/b"],
        "items":[{"url":"https://example.com/a","login_mode":"none"}]})
    first,second=[ctx.manager.get_task(id) for id in reply["taskIds"]]
    assert first.options.login_mode=="none" and first.options.cookies_from_browser==""
    assert second.options.login_mode=="inherit" and second.options.cookies_from_browser=="chrome"
    assert ctx.config.to_dict()["cookies_from_browser"]=="chrome"

def test_parse_none_omits_cookie_sources_and_inherit_still_passes_them(tmp_path,monkeypatch):
    seen=[]
    class FakeSession:
        def __init__(self,url,**kwargs): self.url=url;seen.append(kwargs)
        def run(self): return ParseResult(info=VideoInfo(url=self.url,title="public",platform=Platform.TWITTER))
        def cancel(self): pass
    class InlineThread:
        def __init__(self,target,**_):self.target=target
        def start(self):self.target()
    monkeypatch.setattr(handlers,"ParseSession",FakeSession)
    monkeypatch.setattr(handlers.threading,"Thread",InlineThread)
    ctx=make_context(tmp_path)
    dispatch(ctx,Method.DOWNLOAD_PARSE_URLS.value,{"urls":["https://x.com/example/status/123"],"login_mode":"none"})
    dispatch(ctx,Method.DOWNLOAD_PARSE_URLS.value,{"urls":["https://x.com/example/status/123"],"login_mode":"inherit"})
    assert "cookies_from_browser" not in seen[0] and "cookiefile" not in seen[0]
    assert seen[1]["cookies_from_browser"]=="chrome" and seen[1]["cookiefile"]
    assert ctx.config.to_dict()["cookies_from_browser"]=="chrome"

def test_playlist_expansion_uses_item_none_before_parsing(tmp_path,monkeypatch):
    seen=[]
    class FakeSession:
        def __init__(self,url,**kwargs):self.url=url;seen.append(kwargs)
        def run(self):return ParseResult(info=VideoInfo(url=self.url,title="public"),entries=[])
    monkeypatch.setattr(handlers,"ParseSession",FakeSession)
    ctx=make_context(tmp_path)
    dispatch(ctx,Method.DOWNLOAD_CREATE_TASKS.value,{"urls":["https://www.youtube.com/playlist?list=test"],
        "items":[{"url":"https://www.youtube.com/playlist?list=test","login_mode":"none"}]})
    assert seen and "cookies_from_browser" not in seen[0] and "cookiefile" not in seen[0]

def test_retry_login_payload_preserves_original_task(tmp_path):
    ctx=make_context(tmp_path)
    task=DownloadTask(status=TaskStatus.FAILED,options=DownloadOptions(cookies_from_browser="chrome"))
    ctx.manager.tasks[task.id]=task
    for _ in range(2):
        reply=dispatch(ctx,Method.DOWNLOAD_RETRY.value,{"taskId":task.id,"login_mode":"none"})
        assert reply["taskId"]==task.id
    assert len(ctx.manager.tasks)==1 and task.options.login_mode=="none"

@pytest.mark.parametrize("method",[Method.DOWNLOAD_CREATE_TASKS,Method.DOWNLOAD_PARSE_URLS,Method.DOWNLOAD_RETRY])
def test_invalid_login_policy_rejected(tmp_path,method):
    ctx=make_context(tmp_path)
    with pytest.raises(HandlerError):
        dispatch(ctx,method.value,{"urls":["https://example.com"],"taskId":"missing","login_mode":"invalid"})

@pytest.mark.parametrize('url,public', [
    ('https://www.douyin.com/video/123456', True),
    ('https://x.com/example/status/123456', True),
    ('https://www.youtube.com/watch?v=existing', False),
    ('https://www.bilibili.com/video/BVexisting', False),
    ('https://x.com.evil.invalid/example/status/123456', False),
])
def test_auto_only_prefers_guest_for_target_sites(url, public):
    original=DownloadOptions(login_mode='auto', cookies_from_browser='chrome', cookiefile='/mock-only',
                             http_headers={'Cookie':'mock-only','Referer':'https://example.com'})
    resolved=effective_login_options(original,url=url)
    assert resolved.login_mode=='auto'
    assert (resolved.cookies_from_browser=='')==public
    assert (resolved.cookiefile=='')==public
    assert ('Cookie' not in resolved.http_headers)==public
    assert original.cookies_from_browser=='chrome' and original.cookiefile=='/mock-only'


def test_auto_never_overrides_explicit_account_choice():
    options=DownloadOptions(login_mode='inherit',cookies_from_browser='chrome',http_headers={'Cookie':'mock-only'})
    result=effective_login_options(options,url='https://x.com/example/status/123456')
    assert result.cookies_from_browser=='chrome' and result.http_headers['Cookie']=='mock-only'


def test_auto_public_retry_and_restart_keep_same_policy_without_global_changes(tmp_path):
    cfg,store,manager=config_and_manager(tmp_path)
    task=DownloadTask(video_info=VideoInfo(url='https://www.douyin.com/video/123456'),status=TaskStatus.FAILED,
                      options=DownloadOptions(login_mode='auto',cookies_from_browser='chrome'))
    before=cfg.to_dict();manager.tasks[task.id]=task;store.upsert_task(task)
    manager.retry_task(task.id)
    restored=store.load_tasks()[0]
    assert restored.id==task.id and restored.options.login_mode=='auto'
    assert restored.options.cookies_from_browser==restored.options.cookiefile==''
    assert cfg.to_dict()==before


def test_auto_mixed_batch_preserves_account_and_other_site_behavior(tmp_path):
    ctx=make_context(tmp_path)
    urls=['https://x.com/example/status/123456','https://www.youtube.com/watch?v=existing','https://x.com/example/status/654321']
    reply=dispatch(ctx,Method.DOWNLOAD_CREATE_TASKS.value,{'urls':urls,'login_mode':'auto','items':[{'url':urls[2],'login_mode':'inherit'}]})
    a,b,c=[ctx.manager.get_task(id) for id in reply['taskIds']]
    assert a.options.login_mode=='auto' and a.options.cookies_from_browser==''
    assert b.options.login_mode=='auto' and b.options.cookies_from_browser=='chrome'
    assert c.options.login_mode=='inherit' and c.options.cookies_from_browser=='chrome'
    assert ctx.config.to_dict()['cookies_from_browser']=='chrome'
