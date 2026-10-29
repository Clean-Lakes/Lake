// Actual picker, fictional model names, no network or configuration writes.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ProviderModelPicker} from '../../src/ProviderSetup';
import '../../src/styles.css';
import '../../src/modelSettings.css';
const names=['codex/gpt-6.1-sol','codex/gpt-6.1-terra','codex/gpt-5.6-sol','codex/gpt-5.6-terra','deepseek-flash'];
const current=names.slice(0,2).map(name=>({id:name,name,enabled:true,supportsImageInput:false,supportsImageOutput:false}));
document.documentElement.dataset.theme=new URLSearchParams(location.search).has('dark')?'dark':'light';
function Fixture(){
 const [added,setAdded]=useState<string[]>([]);
 return <div className="model-settings-dialog modal" style={{width:'min(720px,calc(100vw - 32px))',height:'auto',margin:'24px auto',padding:16}}>
  <ProviderModelPicker available={{models:names}} current={current} onAdd={setAdded} onCancel={()=>{}}/>
  <output id="picker-add-proof" hidden>{JSON.stringify(added)}</output>
 </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
