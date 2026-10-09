/** 连续退出仍须等待同一清理过程；只有内部最终退出才放行。 */
export function createQuitHandler(
  cleanup: () => Promise<void>,
  quit: () => void,
  report: (error: unknown) => void = () => undefined,
): (event: { preventDefault: () => void }) => void {
  let running = false;
  let complete = false;
  return (event) => {
    if (complete) return;
    event.preventDefault();
    if (running) return;
    running = true;
    void (async () => {
      try { await cleanup(); }
      catch (error) { report(error); }
      finally { complete = true; quit(); }
    })();
  };
}
