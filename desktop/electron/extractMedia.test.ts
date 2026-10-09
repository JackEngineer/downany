import { describe, expect, it } from "vitest";
import { ExtractMediaStore, collectLoadedMedia, locateLoadedMedia, responseMediaBytes } from "./extractMedia";

const url = 'https://cdn.example.com/a.mp4?signature=secret';
describe('extract candidate identity and metadata', () => {
  it('merges exact duplicate responses without changing identity or stripping signatures', () => {
    const store = new ExtractMediaStore(); store.upsert(url, 'unknown');
    const id = store.snapshot().items[0].id;
    store.upsert(url, 'file', { contentType: 'video/mp4', bytes: 42 });
    store.upsert(url, 'unknown');
    expect(store.snapshot().items).toHaveLength(1);
    expect(store.get(id)).toMatchObject({ type: 'file', contentType: 'video/mp4', bytes: 42 });
    store.upsert(url.replace('secret', 'different'), 'file');
    expect(store.snapshot().items).toHaveLength(2);
  });
  it('associates only one exact DOM media match, never another candidate', () => {
    const store = new ExtractMediaStore(); store.upsert(url, 'file'); store.upsert('https://cdn.example.com/b.mp4', 'file');
    store.observe([{ url, kind: 'video', elementKey: 'media-0', title: 'Our video', duration: 16, width: 1280, height: 720 }], 0);
    expect(store.snapshot().items[0]).toMatchObject({ title: 'Our video', matched: true, duration: 16 });
    expect(store.snapshot().items[1].title).toBeUndefined();
    store.observe([{ url, kind: 'video', elementKey: 'media-0' }, { url, kind: 'video', elementKey: 'media-1' }], 0);
    expect(store.snapshot().items[0].matched).toBe(false);
  });
  it('moves prior candidates to history, rejects stale responses and observations', () => {
    const store = new ExtractMediaStore(); store.upsert(url, 'file'); const oldId = store.snapshot().items[0].id;
    store.beginPage(); store.upsert(url, 'audio', {}, 0); store.observe([{ url, title: 'Wrong page', kind: 'video', elementKey: 'media-0' }], 0);
    expect(store.snapshot().items).toHaveLength(0); expect(store.snapshot().history).toHaveLength(1); expect(store.claim([oldId])).toEqual([]);
    store.upsert(url, 'file'); expect(store.snapshot().items[0].id).not.toBe(oldId);
  });
  it('claims once, allows retry on failure, and marks successful claims even across navigation', () => {
    const store = new ExtractMediaStore(); store.upsert(url, 'file'); const id = store.snapshot().items[0].id;
    const claimed = store.claim([id, id]); expect(claimed).toHaveLength(1); expect(store.claim([id])).toEqual([]);
    store.finish(claimed, false); const retry = store.claim([id]); store.beginPage(); store.finish(retry, true);
    expect(store.snapshot().history[0].added).toBe(true);
  });
  it('does not fill unknown properties with invalid metadata', () => {
    const store = new ExtractMediaStore(); store.upsert(url, 'unknown'); store.observe([{ url, kind: 'video', elementKey: 'media-0', duration: Infinity, width: -1, poster: 'file:///private/image' }], 0);
    expect(store.snapshot().items[0].duration).toBeUndefined(); expect(store.snapshot().items[0].width).toBeUndefined(); expect(store.snapshot().items[0].poster).toBeUndefined();
  });
  it('uses range total instead of partial response length; rejects unknown range totals', () => {
    expect(responseMediaBytes({'Content-Length':['100'], 'Content-Range':['bytes 0-99/2000']})).toBe(2000);
    expect(responseMediaBytes({'Content-Length':['100'], 'Content-Range':['bytes 0-99/*']})).toBeUndefined();
    expect(responseMediaBytes({'content-length':['123']})).toBe(123);
    expect(responseMediaBytes({'content-length':['-1']})).toBeUndefined();
  });
});
describe('loaded DOM association', () => {
  it('reads a media-specific title without applying page title to unrelated media', () => {
    document.body.innerHTML = '<h1>Generic page title</h1><figure><video title="Specific video"></video></figure><audio></audio>';
    const video = document.querySelector('video')!; const audio = document.querySelector('audio')!;
    Object.defineProperty(video, 'currentSrc', { value: url }); Object.defineProperty(audio, 'currentSrc', { value: 'https://cdn.example.com/music.mp3' });
    const observations = collectLoadedMedia(); expect(observations[0].title).toBe('Specific video'); expect(observations[1].title).toBe('');
  });
  it('refuses to locate ambiguous or replaced media without playing or fetching', () => {
    document.body.innerHTML = '<video></video><video></video>';
    for (const video of document.querySelectorAll('video')) Object.defineProperty(video, 'currentSrc', { value: url });
    expect(locateLoadedMedia(url)).toBe(false); expect(locateLoadedMedia('https://other.example/a.mp4')).toBe(false);
  });
});
