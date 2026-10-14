from unittest.mock import MagicMock, patch
import urllib.error

import pytest

from src.core.douyin_public import (
    PublicDouyinUnavailable, PublicDouyinDenied,
    parse_public_douyin, public_douyin_id, resolve_public_douyin,
)
from src.core.download_task import Platform
from src.core.error_codes import classify_download_error
from src.core.url_parser import ParseSession, ParseCancelled

URL = 'https://www.douyin.com/video/123456'
MEDIA = 'https://v6-default.365yg.com/public-media.mp4'


def item(id='123456', media=MEDIA):
    return {'aweme_id':id,'desc':'Public title','author':{'nickname':'Public author'},'video':{
        'duration':12345,'play_addr':{'url_list':[media],'width':640,'height':360,'data_size':1234}}}


def test_exact_match_not_first_recommendation():
    info, media = parse_public_douyin({'status_code':0,'aweme_details':[item('999'),item()]}, URL)
    assert info.url == URL and info.title == 'Public title'
    assert info.platform == Platform.DOUYIN and info.duration == 12 and media == MEDIA


@pytest.mark.parametrize('payload', [
    {}, {'status_code':1,'aweme_details':[item()]},
    {'status_code':0,'aweme_details':[item('999')]},
    {'status_code':0,'aweme_details':[item(),item()]},
    {'status_code':0,'aweme_details':[item()],'filter_list':[{'aweme_id':'123456','reason':4}]},
    {'status_code':0,'aweme_details':[item()],'verification_filter_list':[{'aweme_id':'123456'}]},
    {'status_code':0,'aweme_details':[dict(item(), images=[{}])]},
    {'status_code':0,'aweme_details':[dict(item(),desc='')]},
])
def test_invalid_filtered_or_ambiguous_target_is_terminal(payload):
    with pytest.raises(PublicDouyinUnavailable): parse_public_douyin(payload, URL)


@pytest.mark.parametrize('media', ['http://v6-default.365yg.com/a','https://localhost/a','https://127.0.0.1/a',
    'https://v6-default.365yg.com.evil.invalid/a','https://user:secret@v6-default.365yg.com/a','https://v6-default.365yg.com:444/a','file:///tmp/private'])
def test_nontrusted_media_is_rejected(media):
    with pytest.raises(PublicDouyinUnavailable): parse_public_douyin({'status_code':0,'aweme_details':[item(media=media)]}, URL)


def test_quality_selection_uses_returned_address_unchanged():
    d=item();d['video']['bit_rate']=[{'play_addr':{'url_list':[MEDIA+'?quality=720'],'height':720,'data_size':5000}}, {'play_addr':{'url_list':[MEDIA+'?quality=480'],'height':480,'data_size':2000}}]
    info, media=parse_public_douyin({'status_code':0,'aweme_details':[d]},URL,'480p')
    assert media == MEDIA+'?quality=480' and info.file_size == 2000


@pytest.mark.parametrize('url', ['https://evil.invalid/video/123456','https://www.douyin.com/collection/123456','https://user@www.douyin.com/video/123456','https://www.douyin.com:444/video/123456'])
def test_invalid_work_url(url):
    assert not public_douyin_id(url)


def test_one_request_no_cookie_and_http_denial_no_alternate():
    opener=MagicMock();opener.open.side_effect=urllib.error.HTTPError(URL,403,'denied',{},None)
    with patch('src.core.douyin_public.urllib.request.build_opener',return_value=opener):
        with pytest.raises(PublicDouyinDenied) as e:resolve_public_douyin(URL)
    assert classify_download_error(e.value)=='access_denied'
    assert opener.open.call_count==1
    request=opener.open.call_args.args[0]
    assert not request.has_header('Cookie') and not request.has_header('Authorization')
    assert 'aweme_ids=%5B123456%5D' in request.full_url


@pytest.mark.parametrize('data',[b'',b'not-json',b'x'*(2*1024*1024+1)])
def test_invalid_or_oversized_response_is_terminal(data):
    response=MagicMock();response.__enter__.return_value=response;response.read.return_value=data
    opener=MagicMock();opener.open.return_value=response
    with patch('src.core.douyin_public.urllib.request.build_opener',return_value=opener):
        with pytest.raises(PublicDouyinUnavailable):resolve_public_douyin(URL)
    assert opener.open.call_count==1


def test_explicit_public_parse_does_not_start_ytdlp_or_browser_reader():
    info,_=parse_public_douyin({'status_code':0,'aweme_details':[item()]},URL)
    with patch('src.core.url_parser.resolve_public_douyin',return_value=(info,MEDIA)), patch.object(ParseSession,'_run_ytdlp') as legacy:
        assert ParseSession(URL,public_douyin=True).run().info==info
        legacy.assert_not_called()


def test_inherited_parse_keeps_existing_cookie_source():
    with patch.object(ParseSession,'_run_ytdlp',return_value='legacy') as legacy, patch('src.core.url_parser.resolve_public_douyin') as public:
        assert ParseSession(URL,cookies_from_browser='chrome',public_douyin=True).run()=='legacy'
        public.assert_not_called();legacy.assert_called_once()


def test_cancelled_public_parse_never_requests():
    s=ParseSession(URL,public_douyin=True);s.cancel()
    with patch('src.core.url_parser.resolve_public_douyin') as public:
        with pytest.raises(ParseCancelled):s.run()
        public.assert_not_called()
