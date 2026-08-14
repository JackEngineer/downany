export function initializePrimaryInstance(
  gotLock: boolean,
  initialize: () => void,
): void {
  if (gotLock) initialize();
}
