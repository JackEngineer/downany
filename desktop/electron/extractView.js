(() => {
  const $ = id => document.getElementById(id);
  const urlInput = $('urlInput'), enqueueBtn = $('enqueueBtn'), selectAll = $('selectAll');
  const list = $('mediaList'), status = $('status'), webview = $('browser');
  let snapshot = { pageId: 0, items: [], history: [] };
  let selected = new Set();
  let scope = 'current';
  let busy = false;
  const setStatus = (text, kind = '') => { status.textContent = text; status.className = 'status ' + kind; };
  const safeHost = url => { try { return new URL(url).hostname; } catch { return '未知来源'; } };
  const kind = item => item.kind === 'audio' || item.type === 'audio' ? '音频' : item.kind === 'video' || item.contentType?.startsWith('video/') ? '视频' : item.type === 'hls' ? 'HLS 视频流' : item.type === 'dash' ? 'DASH 媒体流' : '媒体';
  const format = item => {
    const mime = (item.contentType || '').split(';')[0].toLowerCase();
    const formats = { 'video/mp4': 'MP4', 'audio/mp4': 'M4A', 'video/webm': 'WebM', 'audio/mpeg': 'MP3', 'audio/aac': 'AAC', 'video/quicktime': 'MOV', 'audio/ogg': 'OGG' };
    if (formats[mime]) return formats[mime];
    if (item.type === 'hls') return 'HLS';
    if (item.type === 'dash') return 'DASH';
    return '格式未知';
  };
  const duration = n => n > 0 && Number.isFinite(n) ? `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}` : '时长未知';
  const name = (item, index) => item.title || `未识别的${kind(item)} ${index + 1}`;
  const eligible = () => snapshot.items.filter(item => !item.added && !item.pending);
  const update = () => {
    const active = eligible();
    selected = new Set([...selected].filter(id => active.some(item => item.id === id)));
    enqueueBtn.textContent = busy ? '正在加入…' : `下载已选 ${selected.size} 项`;
    enqueueBtn.disabled = busy || selected.size === 0;
    selectAll.disabled = scope !== 'current' || active.length === 0 || busy;
    selectAll.checked = active.length > 0 && selected.size === active.length;
    selectAll.indeterminate = selected.size > 0 && selected.size < active.length;
    $('selectionCount').textContent = `已选 ${selected.size} 项`;
    $('currentTab').textContent = `当前页 ${snapshot.items.length}`;
    $('historyTab').textContent = `之前页面 ${snapshot.history.length}`;
    $('currentTab').setAttribute('aria-pressed', String(scope === 'current'));
    $('historyTab').setAttribute('aria-pressed', String(scope === 'history'));
    for (const card of list.querySelectorAll('.media-card')) {
      const input = card.querySelector('input');
      if (input) { input.checked = selected.has(card.dataset.id); card.classList.toggle('selected', input.checked); }
    }
  };
  const render = () => {
    const focused = document.activeElement?.dataset?.focusId;
    list.replaceChildren();
    const items = scope === 'current' ? snapshot.items : snapshot.history;
    if (!items.length) {
      const empty = document.createElement('li'); empty.className = 'empty';
      const heading = document.createElement('strong'); heading.textContent = scope === 'current' ? '尚未检测到媒体' : '没有之前页面的媒体';
      const description = document.createElement('span'); description.textContent = scope === 'current' ? '在上方网页播放想下载的视频或音频，候选会显示在这里。' : '切换网页后，旧候选会保留在此，不能直接下载。';
      empty.append(heading, description); list.append(empty);
    }
    items.forEach((item, index) => {
      const card = document.createElement('li'); card.className = 'media-card'; card.dataset.id = item.id;
      const label = document.createElement(scope === 'current' ? 'label' : 'div'); label.className = 'media-choice';
      if (scope === 'current') {
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
        checkbox.setAttribute('aria-label', `选择下载 ${name(item, index)}`);
        checkbox.dataset.focusId = item.id;
        checkbox.disabled = !!item.added || !!item.pending || busy;
        checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(item.id); else selected.delete(item.id); update(); });
        label.append(checkbox);
      }
      const visual = document.createElement('div'); visual.className = 'media-visual';
      const placeholder = document.createElement('span'); placeholder.textContent = kind(item).includes('音频') ? '音频' : '视频'; visual.append(placeholder);
      if (item.poster) {
        const image = document.createElement('img'); image.src = item.poster; image.alt = ''; image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => { image.remove(); }); visual.append(image);
      }
      const body = document.createElement('div'); body.className = 'media-body';
      const title = document.createElement('strong'); title.className = 'media-title'; title.textContent = name(item, index);
      const facts = document.createElement('div'); facts.className = 'media-facts';
      const resolution = item.width > 0 && item.height > 0 ? `${item.width} × ${item.height}` : '分辨率未知';
      const bytes = item.bytes > 0 ? `${(item.bytes / 1048576).toFixed(1)} MB` : '大小未知';
      facts.textContent = [kind(item), format(item), duration(item.duration), resolution, bytes].join(' · ');
      const source = document.createElement('div'); source.className = 'media-source';
      source.textContent = `${item.sourceHost || safeHost(item.url)} · ${scope === 'history' ? '之前页面，返回原页面重新识别' : item.matched ? '与网页播放器匹配' : '暂未关联播放器'}`;
      body.append(title, facts, source); label.append(visual, body); card.append(label);
      const actions = document.createElement('div'); actions.className = 'media-actions';
      if (item.added || item.pending) { const badge = document.createElement('span'); badge.className = 'added'; badge.textContent = item.added ? '已加入下载' : '正在加入…'; actions.append(badge); }
      if (scope === 'current') {
        const locate = document.createElement('button'); locate.type = 'button'; locate.textContent = '定位到播放器'; locate.disabled = !item.matched; locate.dataset.focusId = item.id + '-locate';
        locate.addEventListener('click', async () => { try { const found = await window.extractApi.locate(item.id); setStatus(found ? '已定位到网页播放器' : '播放器已切换，请重新识别', found ? 'ok' : 'error'); } catch { setStatus('暂时无法定位播放器', 'error'); } });
        actions.append(locate);
      }
      card.append(actions); list.append(card);
    });
    update();
    if (focused) [...list.querySelectorAll('[data-focus-id]')].find(el => el.dataset.focusId === focused)?.focus();
  };
  const navigate = url => {
    const trimmed = String(url || '').trim();
    try { if (!['http:', 'https:'].includes(new URL(trimmed).protocol)) throw new Error(); }
    catch { setStatus('请输入有效的 HTTP 或 HTTPS 网页地址', 'error'); return; }
    scope = 'current'; selected.clear(); urlInput.value = trimmed; webview.src = trimmed; setStatus('正在加载页面…');
  };
  $('goBtn').addEventListener('click', () => navigate(urlInput.value));
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') navigate(urlInput.value); });
  $('currentTab').addEventListener('click', () => { scope = 'current'; render(); });
  $('historyTab').addEventListener('click', () => { scope = 'history'; render(); });
  selectAll.addEventListener('change', () => { selected = selectAll.checked ? new Set(eligible().map(item => item.id)) : new Set(); update(); });
  enqueueBtn.addEventListener('click', async () => {
    if (busy || selected.size === 0) return;
    const ids = [...selected]; busy = true; render(); setStatus('正在加入下载…');
    try {
      const result = await window.extractApi.enqueue(ids);
      if (result.ok) {
        for (const item of snapshot.items) if (ids.includes(item.id)) item.added = true;
        ids.forEach(id => selected.delete(id));
        setStatus(`已加入 ${result.count || ids.length} 个任务`, 'ok');
      } else setStatus(result.error || '加入下载失败，请重试', 'error');
    } catch { setStatus('加入下载失败，请重试', 'error'); }
    finally { busy = false; render(); }
  });
  window.extractApi.onList(next => {
    if (next.pageId !== snapshot.pageId) { selected.clear(); scope = 'current'; }
    snapshot = next; render();
  });
  window.extractApi.onNavigate(navigate);
  webview.addEventListener('did-navigate', event => { urlInput.value = event.url; });
  const initial = window.extractApi.getInitialUrl();
  render(); if (initial) navigate(initial);
})();
