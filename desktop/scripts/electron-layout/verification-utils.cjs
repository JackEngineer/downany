function assert(condition, message, details) {
  if (!condition) {
    const suffix = details ? `\n${JSON.stringify(details, null, 2)}` : "";
    throw new Error(`${message}${suffix}`);
  }
}

async function waitFor(win, expression, label) {
  const result = await win.webContents.executeJavaScript(
    `new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const probe = () => {
        if (${expression}) {
          resolve(true);
          return;
        }
        if (performance.now() - startedAt > 10000) {
          reject(new Error(${JSON.stringify(`等待 ${label} 超时`)}));
          return;
        }
        requestAnimationFrame(probe);
      };
      probe();
    })`,
    true,
  );
  assert(result === true, `${label} 未就绪`);
}

module.exports = { assert, waitFor };
