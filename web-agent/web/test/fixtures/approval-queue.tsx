// Synthetic approval UI only; no backend, terminal or host operation.
import {useState} from "react";
import {createRoot} from "react-dom/client";
import {AIPending} from "../../src/AIPanel";
import type {AIView} from "../../../shared/contracts";
import "../../src/styles.css";
const items = [0,1].map(i=>({id:`approval-${i}`,kind:"resource_select",needsTerminal:true,target:`192.0.2.${10+i}`,risk:"readonly",fingerprint:`fixture-${i}`,call:{id:`call-${i}`,name:"shell",arguments:'{"command":"printf fixture-only"}'}}));
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") || "light";
function Fixture() {
  const [at,setAt] = useState(0), [requests,setRequests] = useState(0), [refreshes,setRefreshes] = useState(0);
  const conflict = new URLSearchParams(location.search).has("conflict");
  window.fetch = async input => {
    if(!String(input).includes("/api/sessions/fixture/ai/decision")) throw new Error("Fixture does not allow resource requests");
    setRequests(n=>n+1);
    return new Response(JSON.stringify(conflict?{error:"decide approval: approval expired or already decided"}:{}),{status:conflict?409:200,headers:{"content-type":"application/json"}});
  };
  const refresh = async () => {setRefreshes(n=>n+1);if(conflict)setAt(2)};
  const view = {pending:items[at],pendingApprovals:items.slice(at),status:"waiting_approval"} as unknown as AIView;
  return <main style={{maxWidth:900,margin:"40px auto",padding:24}}>
    <h1>确认队列回归</h1><p>仅测试确认状态，不执行任何命令。</p>
    <output aria-label="确认请求次数">决策请求数：{requests} · 刷新次数：{refreshes}</output>
    <button onClick={()=>setAt(n=>Math.min(2,n+1))}>同步下一项</button>
    <AIPending session="fixture" view={view} refresh={refresh}/>
    {at===2&&<p role="status">当前没有待确认操作</p>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
