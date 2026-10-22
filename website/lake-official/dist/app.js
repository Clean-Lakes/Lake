import createGlobe from './assets/vendor/cobe.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
let themePreference;
try { themePreference = localStorage.getItem('lake-site-theme'); } catch {}
let globe, phi = 0, pointerStart = null, dragPhi = 0, globeVisible = true;
const canvas = $('#hero-globe');
const markers = [[14.5995,120.9842,.03],[19.076,72.8777,.1],[23.8103,90.4125,.05],[30.0444,31.2357,.07],[39.9042,116.4074,.08],[-23.5505,-46.6333,.1],[19.4326,-99.1332,.1],[40.7128,-74.006,.1],[34.6937,135.5022,.05],[41.0082,28.9784,.06],[22.5431,114.0579,.08],[31.2304,121.4737,.08],[30.6624,104.0633,.07],[34.0522,-118.2437,.1],[43.6532,-79.3832,.08],[1.3521,103.8198,.07]].map(([lat,lon,size]) => ({location:[lat,lon],size}));
function renderGlobe() {
  globe?.destroy();
  const dark = document.documentElement.classList.contains('dark');
  try {
    globe = createGlobe(canvas, {
      devicePixelRatio:2,width:canvas.offsetWidth*2,height:canvas.offsetWidth*2,
      phi,theta:.3,dark:dark?1:0,diffuse:dark?1.2:.8,mapBrightness:1.2,
      baseColor:dark?[.7,.85,1]:[1,1,1],markerColor:[251/255,100/255,21/255],
      glowColor:dark?[.6,.75,1]:[1,1,1],mapSamples:16000,markers,
      onRender(state) {
        if (pointerStart === null && globeVisible && !document.hidden && !reducedMotion.matches) phi += .005;
        state.phi = phi + dragPhi;state.width=canvas.offsetWidth*2;state.height=canvas.offsetWidth*2;
      }
    });
    canvas.style.opacity = '1';
  } catch {
    canvas.style.opacity = '0';
    if (!$('.lake-globe-fallback')) {
      const fallback=document.createElement('div');fallback.className='lake-globe-fallback';
      fallback.setAttribute('aria-hidden','true');canvas.parentElement.append(fallback);
    }
  }
}
function applyTheme(theme) {
  document.documentElement.classList.toggle('dark',theme === 'dark');
  document.documentElement.style.colorScheme=theme;
  $$('#theme-toggle,#mobile-theme-toggle').forEach(button => {
    button.setAttribute('aria-pressed',String(theme === 'dark'));
    button.setAttribute('aria-label',`切换到${theme === 'dark'?'浅':'深'}色主题`);
  });
  $$('.lake-workspace-image').forEach(image => { image.src=`assets/lake-workbench-${theme}.jpg`; });
  renderGlobe();
}
function toggleTheme() {
  themePreference=document.documentElement.classList.contains('dark')?'light':'dark';applyTheme(themePreference);
  try { localStorage.setItem('lake-site-theme',themePreference); } catch {}
}
applyTheme(themePreference || (colorScheme.matches?'dark':'light'));
$('#theme-toggle').addEventListener('click',toggleTheme);$('#mobile-theme-toggle').addEventListener('click',toggleTheme);
colorScheme.addEventListener('change',event => { if (!themePreference) applyTheme(event.matches?'dark':'light'); });
new IntersectionObserver(entries => { globeVisible=entries[0].isIntersecting; }).observe(canvas);
canvas.addEventListener('pointerdown',event => {pointerStart=event.clientX;canvas.classList.add('is-dragging');canvas.setPointerCapture(event.pointerId);});
canvas.addEventListener('pointermove',event => {if(pointerStart===null)return;dragPhi+=(event.clientX-pointerStart)/1400;pointerStart=event.clientX;});
function releaseGlobe(){pointerStart=null;canvas.classList.remove('is-dragging');}
canvas.addEventListener('pointerup',releaseGlobe);canvas.addEventListener('pointercancel',releaseGlobe);canvas.addEventListener('lostpointercapture',releaseGlobe);
$('#dismiss-announcement').addEventListener('click',event => event.currentTarget.parentElement.remove());
const menuButton=$('#menu-toggle'),mobileNavigation=$('#mobile-navigation'),navTriggers=$$('[id^="nav-trigger-"]');
function closeMenus(){navTriggers.forEach(trigger => {trigger.setAttribute('aria-expanded','false');document.getElementById(trigger.getAttribute('aria-controls')).hidden=true;});}
function closeMobile(){mobileNavigation.hidden=true;menuButton.setAttribute('aria-expanded','false');}
navTriggers.forEach(trigger => {
  trigger.addEventListener('click',() => {const expanded=trigger.getAttribute('aria-expanded')==='true';closeMenus();trigger.setAttribute('aria-expanded',String(!expanded));document.getElementById(trigger.getAttribute('aria-controls')).hidden=expanded;});
  trigger.addEventListener('keydown',event => {if(event.key==='ArrowDown'){event.preventDefault();closeMenus();trigger.setAttribute('aria-expanded','true');const panel=document.getElementById(trigger.getAttribute('aria-controls'));panel.hidden=false;panel.querySelector('a').focus();}});
});
menuButton.setAttribute('aria-controls','mobile-navigation');
menuButton.addEventListener('click',() => {const expanded=menuButton.getAttribute('aria-expanded')==='true';mobileNavigation.hidden=expanded;menuButton.setAttribute('aria-expanded',String(!expanded));});
document.addEventListener('click',event => {if(!event.target.closest('[data-headlessui-state]'))closeMenus();if(!event.target.closest('header'))closeMobile();if(event.target.closest('a')){closeMenus();closeMobile();}});
document.addEventListener('keydown',event => {if(event.key!=='Escape')return;const active=navTriggers.find(trigger=>trigger.getAttribute('aria-expanded')==='true');if(active){closeMenus();active.focus();}if(!mobileNavigation.hidden){closeMobile();menuButton.focus();}});
window.matchMedia('(min-width:1024px)').addEventListener('change',event => {if(event.matches)closeMobile();else closeMenus();});

// The eight reference panels retain their illustration layout with Lake text.
const tabs=$$('[role="tab"]');
let panels;
try {const response=await fetch('assets/core-panels.json');if(!response.ok)throw new Error('Feature content unavailable');panels=await response.json();} catch {panels=null;}
function selectTab(index,focus=false){
  if(!panels?.[index])return;
  tabs.forEach((tab,position)=>{const active=position===index;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;tab.classList.toggle('bg-card',!active);tab.classList.toggle('bg-muted/35',active);});
  const template=document.createElement('template');template.innerHTML=panels[index];const panel=template.content.firstElementChild;panel.tabIndex=0;$('#core-feature-panel').replaceWith(panel);if(focus)tabs[index].focus();
}
tabs.forEach((tab,index)=>{
  tab.addEventListener('click',()=>selectTab(index));
  tab.addEventListener('keydown',event=>{let next;if(event.key==='ArrowRight')next=(index+1)%tabs.length;if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;if(event.key==='Home')next=0;if(event.key==='End')next=tabs.length-1;if(next!==undefined){event.preventDefault();selectTab(next,true);}});
});
if(panels)selectTab(0);
if(!reducedMotion.matches){
  const observer=new IntersectionObserver(entries=>{entries.forEach(entry=>{if(entry.isIntersecting){entry.target.dataset.scrollReveal='visible';observer.unobserve(entry.target);}});},{threshold:.04});
  $$('main .motion-reveal').forEach(section=>{if(section.getBoundingClientRect().top>window.innerHeight){section.dataset.scrollReveal='pending';observer.observe(section);}});
}
window.addEventListener('pagehide',()=>globe?.destroy(),{once:true});
