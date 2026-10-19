// Real workbench, fictional records and simulated window commands only.
// No native window, backend, credentials, model or host operations are accessed.
import type {} from '../../src/WindowsChrome';

document.documentElement.classList.add('lake-windows-chrome');
let maximized = false;
window.lakeWindowsChrome = {
  async command(action) {
    if (action === 'maximize') {
      maximized = !maximized;
      window.dispatchEvent(new Event('resize'));
    }
    return maximized ? 'maximized' : 'normal';
  },
};

await import('./workspace-utilities');
window.lakeDesktopUpdates = {
  development: true,
  platform: 'Windows · x86_64',
  command: async () => ({status: 'current', currentVersion: '0.3.20', message: '当前已是最新版本', updateAvailable: false}),
};
