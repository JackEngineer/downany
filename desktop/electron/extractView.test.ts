import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from 'node:fs';
import path from 'node:path';
let deliver: (snapshot: any) => void;
let enqueue: ReturnType<typeof vi.fn>;
const candidate = (id: string, patch = {}) => ({ id, url: 'https://cdn.example.com/a.mp4?signature=SECRET', type: 'unknown', sourceHost: 'cdn.example.com', pageId: 1, ...patch });
beforeEach(() => {
  document.body.innerHTML = fs.readFileSync(path.join(__dirname, 'extract.html'), 'utf8').match(/<body>([\s\S]*)<script src=/)![1];
  enqueue = vi.fn(async () => ({ ok: true, count: 1 }));
  (window as any).extractApi = { getInitialUrl: () => '', onList: (cb: typeof deliver) => { deliver = cb; }, onNavigate: vi.fn(), locate: vi.fn(async () => true), enqueue };
  window.eval(fs.readFileSync(path.join(__dirname, 'extractView.js'), 'utf8'));
});
describe('extract selection cards', () => {
  it('shows honest unknown fields, source only and no signed URL', () => {
    deliver({ pageId: 1, items: [candidate('1')], history: [] });
    expect(document.querySelector('#mediaList')!.textContent).toContain('未识别的媒体 1');
    expect(document.querySelector('#mediaList')!.textContent).toContain('时长未知');
    expect(document.querySelector('#mediaList')!.textContent).not.toContain('SECRET');
    expect((document.querySelector('.media-actions button') as HTMLButtonElement).disabled).toBe(true);
  });
  it('keeps selection by ID through metadata updates and clears on page switch', () => {
    deliver({ pageId: 1, items: [candidate('1'), candidate('2')], history: [] });
    (document.querySelector('.media-choice input') as HTMLInputElement).click();
    deliver({ pageId: 1, items: [candidate('1', { title: 'Updated' }), candidate('2')], history: [] });
    expect((document.querySelector('.media-choice input') as HTMLInputElement).checked).toBe(true);
    expect(document.querySelector('#enqueueBtn')!.textContent).toBe('下载已选 1 项');
    deliver({ pageId: 2, items: [], history: [candidate('1')] });
    expect(document.querySelector('#enqueueBtn')!.textContent).toBe('下载已选 0 项');
    (document.querySelector('#historyTab') as HTMLButtonElement).click();
    expect(document.querySelector('.media-choice input')).toBeNull();
  });
  it('prevents repeated enqueue clicks and marks success', async () => {
    let finish!: (value: any) => void;
    enqueue.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    deliver({ pageId: 1, items: [candidate('1', { title: 'Our video', matched: true })], history: [] });
    (document.querySelector('.media-choice input') as HTMLInputElement).click();
    const button = document.querySelector('#enqueueBtn') as HTMLButtonElement; button.click(); button.click();
    expect(enqueue).toHaveBeenCalledOnce(); expect(enqueue).toHaveBeenCalledWith(['1']);
    finish({ ok: true, count: 1 }); await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector('#mediaList')!.textContent).toContain('已加入下载');
    expect((document.querySelector('.media-choice input') as HTMLInputElement).disabled).toBe(true);
    expect(button.disabled).toBe(true);
  });
  it('allows retry after failure without exposing error URLs', async () => {
    enqueue.mockRejectedValue(new Error('https://cdn.example/?secret=bad'));
    deliver({ pageId: 1, items: [candidate('1')], history: [] });
    (document.querySelector('.media-choice input') as HTMLInputElement).click();
    (document.querySelector('#enqueueBtn') as HTMLButtonElement).click(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector('#status')!.textContent).toBe('加入下载失败，请重试');
    expect((document.querySelector('#enqueueBtn') as HTMLButtonElement).disabled).toBe(false);
  });
  it('shows known attributes and uses a native keyboard-operable checkbox', () => {
    deliver({ pageId: 1, items: [candidate('1', { title: 'Travel', kind: 'video', contentType: 'video/mp4', duration: 16, width: 1280, height: 720, bytes: 2097152 })], history: [] });
    expect(document.querySelector('.media-facts')!.textContent).toBe('视频 · MP4 · 0:16 · 1280 × 720 · 2.0 MB');
    expect(document.querySelector('label.media-choice input[type=checkbox]')).not.toBeNull();
  });
});
