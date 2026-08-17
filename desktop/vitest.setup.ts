import "@testing-library/jest-dom/vitest";

const ResizeObserverTestDouble: typeof ResizeObserver = class
  implements ResizeObserver
{
  constructor(_callback: ResizeObserverCallback) {}

  observe(_target: Element, _options?: ResizeObserverOptions): void {}
  unobserve(_target: Element): void {}
  disconnect(): void {}
  takeRecords(): ResizeObserverEntry[] {
    return [];
  }
};

if (typeof globalThis.ResizeObserver === "undefined") {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverTestDouble,
  });
}
