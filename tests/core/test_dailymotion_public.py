import json
import urllib.parse
from types import SimpleNamespace
import pytest
from src.core import dailymotion_public as dm
from src.core.download_task import Platform, VideoInfo, DownloadOptions
from src.core.downloader import Downloader, _merge_fallback_info
from src.core.login_policy import effective_login_options
from src.core.video_info_extractor import VideoInfoExtractor


def row(id="xabc", **patch):
    return {"id":id,"title":"Blender 海岸","duration":65,"thumbnail_url":"https://s1.dmcdn.net/v/cover","owner.screenname":"Studio",**patch}

def metadata(**patch):
    return {"id":"xabc","title":"Public movie","duration":65,"private":False,"is_password_protected":False,"protected_delivery":False,"mode":"vod","owner":{"screenname":"Studio"},"qualities":{"auto":[{"type":"application/x-mpegURL","url":"https://www.dailymotion.com/cdn/manifest/video/xabc.m3u8"}]},**patch}

@pytest.mark.parametrize("url",["https://www.dailymotion.com/video/xabc","https://dailymotion.com/video/xabc_title","https://dai.ly/xabc"])
def test_public_video_identity(url):
    assert dm.dailymotion_id(url)=="xabc"

@pytest.mark.parametrize("url",["https://www.dailymotion.com.evil/video/xabc","https://u:p@www.dailymotion.com/video/xabc","file:///video/xabc","https://www.dailymotion.com/playlist/xabc"])
def test_rejects_non_public_video_identity(url):
    assert dm.dailymotion_id(url) is None


def test_public_search_encoding_fields_and_pagination_without_credentials(monkeypatch):
    seen=[]
    def read(url, proxy):
        seen.append(url);return {"page":2,"has_more":True,"list":[row()]}
    monkeypatch.setattr(dm,"_json",read)
    page=dm.search_dailymotion_page(" 海岸 & # / + 😀 ",page=2,count=3)
    args=urllib.parse.parse_qs(urllib.parse.urlsplit(seen[0]).query)
    assert args['search']==['海岸 & # / + 😀'] and args['page']==['2'] and args['limit']==['3']
    assert page.page==2 and page.has_more and page.items[0].platform==Platform.DAILYMOTION
    assert page.items[0].url=='https://www.dailymotion.com/video/xabc'


def test_normalizes_only_canonical_ids_and_valid_items(monkeypatch):
    monkeypatch.setattr(dm,"_json",lambda *_:{"page":1,"has_more":True,"list":[row(url='https://evil.invalid'),row(),row('x2',duration='Infinity',thumbnail_url='javascript:evil'),row('bad/id'),{'id':'x3','title':''}]})
    page=dm.search_dailymotion_page('Blender')
    assert len(page.items)==2 and page.items[0].url.endswith('/xabc')
    assert page.items[1].duration==0 and page.items[1].thumbnail_url==''

@pytest.mark.parametrize('payload',[{}, {'page':2,'list':[]},{'page':1,'list':{}}])
def test_rejects_schema_or_wrong_page(monkeypatch,payload):
    monkeypatch.setattr(dm,'_json',lambda *_:payload)
    with pytest.raises(dm.DailymotionPublicError):dm.search_dailymotion_page('Blender')

@pytest.mark.parametrize('patch',[{'page':0},{'page':101},{'count':0},{'count':31}])
def test_bounds_before_network(monkeypatch,patch):
    monkeypatch.setattr(dm,'_json',lambda *_:pytest.fail('network should not start'))
    with pytest.raises(dm.DailymotionPublicError):dm.search_dailymotion_page('Blender',**patch)


def test_empty_is_not_more_and_cancel_is_checked_before_and_after_network(monkeypatch):
    monkeypatch.setattr(dm,'_json',lambda *_:{'page':1,'has_more':True,'list':[]})
    assert not dm.search_dailymotion_page('Blender').has_more
    with pytest.raises(dm.DailymotionPublicError,match='cancelled'):dm.search_dailymotion_page('Blender',cancelled=lambda:True)
    flags=iter([False,True])
    with pytest.raises(dm.DailymotionPublicError,match='cancelled'):dm.search_dailymotion_page('Blender',cancelled=lambda:next(flags))


def test_json_uses_only_public_headers_and_bounds_response(monkeypatch):
    class Response:
        def __enter__(self):return self
        def __exit__(self,*_):return False
        def read(self,n):assert n==2*1024*1024+1;return b'{"page":1,"list":[]}'
    class Opener:
        def open(self,request,timeout):
            assert timeout==10
            assert not any(k.lower() in {'cookie','authorization'} for k,v in request.header_items())
            return Response()
    monkeypatch.setattr(dm.urllib.request,'build_opener',lambda:Opener())
    assert dm._json('https://api.dailymotion.com/videos')['page']==1

@pytest.mark.parametrize('patch',[{'private':True},{'protected_delivery':True},{'is_password_protected':True},{'mode':'live'},{'id':'xother'},{'qualities':{'auto':[{'type':'video/mp4','url':'https://evil.invalid/a.mp4'}]}}])
def test_refuses_restricted_or_untrusted_media_without_fallback(monkeypatch,patch):
    monkeypatch.setattr(dm,'_json',lambda *_:metadata(**patch))
    with pytest.raises(dm.DailymotionPublicError):dm.resolve_public_dailymotion('https://www.dailymotion.com/video/xabc')


def test_public_resolver_does_not_request_oauth(monkeypatch):
    seen=[]
    def read(url,proxy):seen.append(url);return metadata()
    monkeypatch.setattr(dm,'_json',read)
    info,url=dm.resolve_public_dailymotion('https://www.dailymotion.com/video/xabc')
    assert seen==['https://www.dailymotion.com/player/metadata/video/xabc']
    assert info.title=='Public movie' and info.duration==65 and url.endswith('.m3u8')
    merged=_merge_fallback_info({'id':'cdn','title':'manifest'},info)
    assert merged['id']=='xabc' and merged['webpage_url']==info.url and not merged['direct']


def test_downloader_uses_public_manifest_and_strips_private_context(monkeypatch,tmp_path):
    source='https://www.dailymotion.com/video/xabc';info=VideoInfo(url=source,title='Public movie',platform=Platform.DAILYMOTION)
    monkeypatch.setattr('src.core.downloader.resolve_public_dailymotion',lambda *a,**k:(info,'https://www.dailymotion.com/cdn/public.m3u8'))
    monkeypatch.setattr('src.core.downloader.apply_cookiefile_from_headers',lambda *a:pytest.fail('must not copy cookies'))
    down=Downloader();seen={};result=object()
    monkeypatch.setattr(down,'_ydl_options',lambda *a:{'cookiesfrombrowser':('chrome',),'cookiefile':'private','username':'secret','password':'secret','http_headers':{'Cookie':'private','Authorization':'private'},'postprocessors':[]})
    def download(url,options,*a,**kwargs):
        seen.update(url=url,options=options,kwargs=kwargs);return result
    monkeypatch.setattr(down,'_download_with_ydl',download)
    assert down.download(source,object(),toolchain=None,staging_dir=tmp_path/'staging') is result
    assert seen['url'].endswith('.m3u8') and seen['kwargs']['metadata_fallback'] is info
    assert not any(k in seen['options'] for k in ['cookiefile','cookiesfrombrowser','username','password'])
    assert not any(k.lower() in ['cookie','authorization'] for k in seen['options']['http_headers'])
    opts=effective_login_options(DownloadOptions(cookies_from_browser='chrome',login_mode='auto'),url=source)
    assert not opts.cookies_from_browser


def test_parser_never_falls_back_to_credential_generating_extractor(monkeypatch):
    monkeypatch.setattr('src.core.video_info_extractor.resolve_public_dailymotion',lambda *a,**k:(_ for _ in ()).throw(dm.DailymotionPublicError('restricted')))
    monkeypatch.setattr('src.core.video_info_extractor.yt_dlp.YoutubeDL',lambda *a,**k:pytest.fail('must not initialize OAuth-capable extractor'))
    assert VideoInfoExtractor.extract('https://www.dailymotion.com/video/xabc') is None
