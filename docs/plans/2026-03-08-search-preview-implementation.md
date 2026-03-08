# 搜索预览功能 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为搜索列表增加封面懒加载与应用内视频预览能力，并在预览失败时自动回退浏览器打开，且不影响现有下载流程。

**Architecture:** 在 `search_tab` 维持现有双栏布局，新增“封面加载层 + 预览控制层”，并通过异步线程与缓存机制保证滚动与选择体验稳定。预览路径采用“应用内优先，失败自动回退浏览器”，与下载任务状态机解耦。

**Tech Stack:** Python 3.11、PyQt6（Qt Widgets / Qt Multimedia / Qt Network）、yt-dlp、pytest（新增测试依赖）

---

### Task 1: 基础准备与测试框架

**Files:**
- Modify: `requirements.txt`
- Create: `tests/core/test_preview_url.py`
- Create: `tests/ui/test_thumbnail_cache.py`

**Step 1: 写失败测试（URL 归一化与回退策略）**

```python
from src.core.download_task import Platform, VideoInfo
from src.ui.tabs.search_tab import SearchTab

def test_normalize_youtube_id():
    info = VideoInfo(url="abc123", platform=Platform.YOUTUBE)
    assert SearchTab._normalize_video_url(None, info) == "https://www.youtube.com/watch?v=abc123"
```

**Step 2: 运行测试确认失败**

Run: `pytest tests/core/test_preview_url.py -v`  
Expected: FAIL（测试环境未就绪或方法调用方式不兼容）

**Step 3: 最小实现（测试基础设施）**

```python
# requirements.txt
pytest>=8.0.0
pytest-qt>=4.4.0
```

**Step 4: 再次运行测试**

Run: `pytest tests/core/test_preview_url.py -v`  
Expected: PASS（基础 URL 归一化用例通过）

**Step 5: Commit**

```bash
git add requirements.txt tests/core/test_preview_url.py tests/ui/test_thumbnail_cache.py
git commit -m "test: 初始化预览功能测试基础"
```

### Task 2: 搜索结果项封面渲染能力

**Files:**
- Modify: `src/ui/components/search_result_item.py`
- Create: `src/ui/components/thumbnail_loader.py`
- Modify: `src/ui/components/__init__.py`
- Test: `tests/ui/test_search_result_item_thumbnail.py`

**Step 1: 写失败测试（封面占位与加载状态）**

```python
def test_search_item_shows_placeholder_before_thumbnail_loaded(qtbot):
    # 创建 SearchResultItemWidget，断言初始状态显示占位图/占位文案
    ...
```

**Step 2: 运行测试确认失败**

Run: `pytest tests/ui/test_search_result_item_thumbnail.py -v`  
Expected: FAIL（组件尚无封面能力）

**Step 3: 最小实现（封面控件 + 异步加载接口）**

```python
class ThumbnailLoader(QObject):
    thumbnail_loaded = pyqtSignal(str, QPixmap)
    thumbnail_failed = pyqtSignal(str)
```

**Step 4: 运行测试确认通过**

Run: `pytest tests/ui/test_search_result_item_thumbnail.py -v`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/ui/components/search_result_item.py src/ui/components/thumbnail_loader.py src/ui/components/__init__.py tests/ui/test_search_result_item_thumbnail.py
git commit -m "feat(ui): 搜索列表项增加封面渲染能力"
```

### Task 3: 可视区懒加载与缓存策略接入

**Files:**
- Modify: `src/ui/tabs/search_tab.py`
- Modify: `src/ui/components/thumbnail_loader.py`
- Test: `tests/ui/test_thumbnail_cache.py`

**Step 1: 写失败测试（可视项才触发加载）**

```python
def test_only_visible_items_request_thumbnail(qtbot):
    # 填充多条结果后仅断言可视区项触发加载请求
    ...
```

**Step 2: 运行测试确认失败**

Run: `pytest tests/ui/test_thumbnail_cache.py -v`  
Expected: FAIL

**Step 3: 最小实现（懒加载 + LRU 缓存 + 失败缓存）**

```python
class ThumbnailLoader:
    def request(self, key: str, url: str): ...
    def has_cached(self, key: str) -> bool: ...
```

**Step 4: 运行测试确认通过**

Run: `pytest tests/ui/test_thumbnail_cache.py -v`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/ui/tabs/search_tab.py src/ui/components/thumbnail_loader.py tests/ui/test_thumbnail_cache.py
git commit -m "feat(ui): 接入搜索封面懒加载与缓存"
```

### Task 4: 详情区大封面与预览入口

**Files:**
- Modify: `src/ui/tabs/search_tab.py`
- Modify: `src/ui/styles/theme.py`
- Test: `tests/ui/test_search_detail_preview_panel.py`

**Step 1: 写失败测试（选中项后显示预览入口）**

```python
def test_detail_panel_enables_preview_button_when_item_selected(qtbot):
    # 选中结果后断言预览按钮 enabled
    ...
```

**Step 2: 运行测试确认失败**

Run: `pytest tests/ui/test_search_detail_preview_panel.py -v`  
Expected: FAIL

**Step 3: 最小实现（详情区封面 + 预览按钮）**

```python
self.preview_btn = QPushButton("直接预览")
self.preview_btn.clicked.connect(self.preview_selected_video)
```

**Step 4: 运行测试确认通过**

Run: `pytest tests/ui/test_search_detail_preview_panel.py -v`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/ui/tabs/search_tab.py src/ui/styles/theme.py tests/ui/test_search_detail_preview_panel.py
git commit -m "feat(ui): 搜索详情区增加封面与预览入口"
```

### Task 5: 应用内预览与失败回退浏览器

**Files:**
- Modify: `src/ui/tabs/search_tab.py`
- Create: `src/ui/components/video_preview_widget.py`
- Modify: `src/ui/components/__init__.py`
- Test: `tests/ui/test_video_preview_fallback.py`

**Step 1: 写失败测试（预览失败自动回退）**

```python
def test_preview_fallback_to_browser_when_player_error(qtbot, monkeypatch):
    # mock 播放器失败，断言会调用 QDesktopServices.openUrl
    ...
```

**Step 2: 运行测试确认失败**

Run: `pytest tests/ui/test_video_preview_fallback.py -v`  
Expected: FAIL

**Step 3: 最小实现（预览组件 + 回退路径）**

```python
def preview_selected_video(self):
    if not self.preview_widget.try_play(url):
        self.open_selected_link()
```

**Step 4: 运行测试确认通过**

Run: `pytest tests/ui/test_video_preview_fallback.py -v`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/ui/tabs/search_tab.py src/ui/components/video_preview_widget.py src/ui/components/__init__.py tests/ui/test_video_preview_fallback.py
git commit -m "feat(ui): 支持应用内预览并失败回退浏览器"
```

### Task 6: 回归验证与文档更新

**Files:**
- Modify: `README_NEW.md`
- Modify: `docs/plans/2026-03-08-search-preview-design.md`

**Step 1: 补充文档（功能说明 + 已完成项）**

```markdown
- ✅ 搜索结果封面缩略图（懒加载）
- ✅ 搜索详情区直接预览（失败自动回退浏览器）
```

**Step 2: 运行测试与基础启动验证**

Run: `pytest -v`  
Expected: PASS

Run: `python src/main.py`  
Expected: 应用正常启动，搜索页可执行“封面加载 + 直接预览 + 回退浏览器”链路

**Step 3: Commit**

```bash
git add README_NEW.md docs/plans/2026-03-08-search-preview-design.md
git commit -m "docs: 更新搜索预览功能说明与验收记录"
```

### Task 7: 最终检查与交付

**Files:**
- Modify: 无（仅检查）

**Step 1: 工作区检查**

Run: `git status --short`  
Expected: 无意外未提交变更（或仅明确保留的用户本地变更）

**Step 2: 提供验收报告**

Run: `git log --oneline -n 10`  
Expected: 含本特性相关阶段性提交，message 清晰可读

**Step 3: 交付说明**

- 输出“功能完成情况、验证结果、已知限制、后续优化建议”。
