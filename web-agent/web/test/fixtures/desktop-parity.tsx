// Identical fictional, read-only application state under each desktop host's chrome.
import {createRoot} from 'react-dom/client';
import {WindowsChrome} from '../../src/WindowsChrome';
const windows = new URLSearchParams(location.search).get('os') === 'windows';
Object.defineProperty(navigator, 'platform', {value: windows ? 'Win32' : 'MacIntel', configurable: true});
if (windows) {
  const calls=document.createElement('output');calls.id='chrome-metrics';calls.hidden=true;document.body.appendChild(calls);
  const actions:string[]=[];
  window.lakeWindowsChrome = {command: async action => {actions.push(action);calls.textContent=JSON.stringify(actions);return 'normal';}};
  document.documentElement.classList.add('lake-windows-chrome');
} else {
  document.documentElement.classList.add('lake-native');
  const regions=document.createElement('output');regions.id='mac-chrome-metrics';regions.hidden=true;document.body.appendChild(regions);
  Object.defineProperty(window,'webkit',{value:{messageHandlers:{lakeChrome:{postMessage:(body:unknown)=>{regions.textContent=JSON.stringify(body)}}}},configurable:true});
  const style = document.createElement('style');
  style.textContent = '.lake-native { --lake-titlebar-height:52px; --radius-window:20px; } .lake-native .sidebar { padding-top:var(--lake-titlebar-height); }';
  document.head.appendChild(style);
}
await import('./onboarding-workbench');
if (windows) {
  const controls = document.createElement('div');
  document.body.appendChild(controls);
  createRoot(controls).render(<WindowsChrome/>);
}
