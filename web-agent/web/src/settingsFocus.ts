const tabStopSelector='button,input,select,textarea,a[href],summary,[tabindex],[contenteditable="true"],[contenteditable=""]';

function isTabStop(element:HTMLElement){
  if(element.tabIndex<0||element.matches(':disabled')||element.closest('[hidden],[inert]')||!element.getClientRects().length)return false;
  const visibility=element.ownerDocument.defaultView?.getComputedStyle(element).visibility;
  if(visibility==='hidden'||visibility==='collapse')return false;
  // Chromium can retain nonempty client rects for content in closed details.
  // Only its first direct summary subtree participates in keyboard navigation;
  // every closed ancestor must allow the element, including nested disclosures.
  for(let ancestor=element.parentElement;ancestor;ancestor=ancestor.parentElement){
    if(ancestor.tagName!=='DETAILS'||ancestor.hasAttribute('open'))continue;
    const summary=[...ancestor.children].find(child=>child.tagName==='SUMMARY');
    if(!summary?.contains(element))return false;
  }
  return true;
}

export function settingsTabStops(dialog:HTMLElement){
  return [...dialog.querySelectorAll<HTMLElement>(tabStopSelector)].filter(isTabStop)
    .sort((a,b)=>(a.tabIndex||Infinity)-(b.tabIndex||Infinity));
}

export function trapSettingsTab(event:Pick<KeyboardEvent,'key'|'shiftKey'|'defaultPrevented'|'preventDefault'>,dialog:HTMLElement|null){
  if(event.key!=='Tab'||event.defaultPrevented||!dialog)return;
  const items=settingsTabStops(dialog),active=dialog.ownerDocument.activeElement;
  const first=items[0],last=items.at(-1);
  if(!items.length){event.preventDefault();dialog.focus();return;}
  if(!items.includes(active as HTMLElement)||event.shiftKey&&active===first||!event.shiftKey&&active===last){
    event.preventDefault();(event.shiftKey?last:first)!.focus();
  }
}

export function navigateSettingsTabs(
  event:Pick<KeyboardEvent,'key'|'target'|'altKey'|'ctrlKey'|'metaKey'|'defaultPrevented'|'preventDefault'>,
  tablist:HTMLElement,
){
  const {key}=event;
  const vertical=tablist.getAttribute('aria-orientation')==='vertical';
  const previous=vertical?'ArrowUp':'ArrowLeft',following=vertical?'ArrowDown':'ArrowRight';
  if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||![previous,following,'Home','End'].includes(key))return;
  const tabs=[...tablist.querySelectorAll<HTMLButtonElement>('button[role="tab"]:not(:disabled):not([hidden])')];
  const current=tabs.findIndex(tab=>tab===event.target);
  if(current<0)return;
  const direction=key===previous?-1:1;
  const index=key==='Home'?0:key==='End'?tabs.length-1:(current+direction+tabs.length)%tabs.length;
  const next=tabs[index]!;
  event.preventDefault();
  next.focus({preventScroll:true});
  next.click();
}
