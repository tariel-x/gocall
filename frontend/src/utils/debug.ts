export const isDebugEnabled = (): boolean => {
  try {
    return (
      window?.localStorage?.getItem('gocall.debug') === '1' ||
      window?.sessionStorage?.getItem('gocall.debug') === '1'
    );
  } catch {
    return false;
  }
};

export const setDebugEnabled = (enabled: boolean, scope: 'session' | 'local' = 'session'): void => {
  try {
    const storage = scope === 'local' ? window?.localStorage : window?.sessionStorage;
    if (!storage) {
      return;
    }
    if (enabled) {
      storage.setItem('gocall.debug', '1');
    } else {
      storage.removeItem('gocall.debug');
    }
  } catch {
    return;
  }
};

export const debugLog = (...args: any[]): void => {
  if (!isDebugEnabled()) {
    return;
  }
  // eslint-disable-next-line no-console
  console.log(...args);
};

export const debugWarn = (...args: any[]): void => {
  if (!isDebugEnabled()) {
    return;
  }
  // eslint-disable-next-line no-console
  console.warn(...args);
};
