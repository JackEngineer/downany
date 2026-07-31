"""标题质量：弱标题识别与从 yt-dlp info 挑选更好标题。"""

from src.core.title_utils import is_weak_title, pick_title_from_ydl_info


def test_is_weak_title_for_instagram_generics():
    assert is_weak_title("")
    assert is_weak_title("Instagram")
    assert is_weak_title("instagram")
    assert is_weak_title("Video by goutouluoli_")
    assert is_weak_title("未命名视频")
    assert not is_weak_title("今日份小狗 #cute")


def test_pick_title_prefers_description_over_video_by():
    picked = pick_title_from_ydl_info(
        {
            "title": "Video by goutouluoli_",
            "description": "今日份小狗 #cute\n更多内容",
            "uploader": "goutouluoli_",
        },
        current="Instagram",
    )
    assert picked == "今日份小狗 #cute"


def test_pick_title_keeps_strong_current_over_weak_ydl():
    picked = pick_title_from_ydl_info(
        {
            "title": "Video by someone",
            "description": "",
        },
        current="扩展已抓到的文案",
    )
    assert picked == "扩展已抓到的文案"


def test_pick_title_keeps_x_tweet_over_ydl_username_title():
    """X：扩展抓到的推文正文不应被 yt-dlp 的「用户 - 摘要」盖掉。"""
    picked = pick_title_from_ydl_info(
        {
            "title": "liseiwyht - 这个…… 应该算",
            "description": "这个…… 应该算 #女喘 之…… 《晨醒晚醺》 完整正文更长",
        },
        current="这个…… 应该算 #女喘 之…… 《晨醒晚醺》 渣女反差女上司x无辜被养鱼下属",
    )
    assert "晨醒晚醺" in picked
    assert picked.startswith("这个")


def test_pick_title_uses_strong_ydl_title():
    picked = pick_title_from_ydl_info(
        {"title": "正式视频标题", "description": "desc"},
        current="Instagram",
    )
    assert picked == "正式视频标题"


def test_x_tab_title_is_weak():
    assert is_weak_title("X")
    assert is_weak_title("Home / X")
    assert is_weak_title("Someone / X")
