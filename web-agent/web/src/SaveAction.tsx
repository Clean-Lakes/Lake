import type {ButtonHTMLAttributes} from "react";
import {Glyph} from "./Icons";

type Props=Omit<ButtonHTMLAttributes<HTMLButtonElement>,"children"> & {
  label:string;
  saving:boolean;
  saved:boolean;
};

export function SaveAction({label,saving,saved,className="",...props}:Props) {
  const phase=saving?"pending":saved?"saved":"idle";
  return <button type="button" {...props} className={`button primary save-action ${className}`}
    aria-label={saving?"保存中":saved?"已保存":label} aria-busy={saving}>
    <span aria-hidden="true" className={phase==="idle"?undefined:"save-action-size"}>{label}</span>
    {phase!=="idle"&&<span key={phase} className="save-action-feedback" aria-hidden="true">
      {saved&&!saving&&<Glyph name="check" size={14}/>}
      {saving?"保存中…":"已保存"}
    </span>}
  </button>;
}
