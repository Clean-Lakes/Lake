// Isolated input-event fixture. No backend, shell or resource calls.
import {useRef, useState} from "react";
import {createRoot} from "react-dom/client";
import {TerminalPane} from "../../src/TerminalPane";
import "../../src/styles.css";
// Exercise the Mac compatibility branch even in a Chromium test browser.
Object.defineProperty(navigator, "platform", {configurable:true, value:"MacIntel"});
Object.defineProperty(navigator, "userAgent", {configurable:true, value:new URLSearchParams(location.search).has("baseline") ? "AppleWebKit/537.36 Chrome" : "AppleWebKit/605.1.15 Safari"});
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") || "light";
function Fixture() {
  const [received, setReceived] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const inject = (symbols: string) => {
    const input = host.current?.querySelector("textarea");
    if (!input) throw new Error("Terminal input unavailable");
    for (const data of symbols) {
      input.dispatchEvent(new KeyboardEvent("keydown", {key:"Unidentified", keyCode:0, bubbles:true}));
      input.value += data;
      input.dispatchEvent(new InputEvent("input", {data, inputType:"insertText", isComposing:false, composed:true, bubbles:true}));
      input.dispatchEvent(new KeyboardEvent("keyup", {key:"Unidentified", keyCode:0, bubbles:true}));
    }
  };
  return <main style={{maxWidth:800,margin:"48px auto",padding:24}}>
    <h1>Mac 终端标点输入回归</h1><p>仅记录输入，不连接或执行命令。</p>
    <button onClick={()=>inject(".")}>输入英文句号</button>
    <button onClick={()=>inject("!@#$%^&*()_+-=[]{};:'\",.<>/?\\|`~")}>提交英文标点事件</button>
    <button onClick={()=>inject("，。；：！？（）")}>提交 WebKit 标点事件</button>
    <button onClick={()=>setReceived("")}>清空测试记录</button>
    <p>收到：<output aria-label="收到的终端输入">{received}</output></p>
    <div ref={host} style={{height:220,border:"1px solid var(--border)",padding:12}}>
      <TerminalPane entries={[]} output={received} interactive onInput={text=>setReceived(value=>value+text)} onResize={()=>{}}/>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
