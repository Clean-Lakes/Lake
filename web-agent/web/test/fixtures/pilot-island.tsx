// Real App, shared header and production styles; all API data stays in memory.
import './readme-workbench';
import '../../src/assistantProse.css';
import '../../src/objectReferences.css';
import '../../src/windowsChrome.css';
if (new URLSearchParams(location.search).has('windows')) document.documentElement.classList.add('lake-windows-chrome');
