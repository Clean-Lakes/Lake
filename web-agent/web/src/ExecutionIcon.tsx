import type {AICard} from '../../shared/contracts';
import {Glyph} from './Icons';
import {progressGlyph} from './activity';

/** Preserve the shared tool silhouette; only the colored water layer moves. */
export function ExecutionIcon({card,active=false,size=18,glyph}:{card?:AICard;active?:boolean;size?:number;glyph?:string}) {
 const name=glyph??progressGlyph(card);
 return <span className={`execution-icon${active?' is-active':''}`} data-kind={name} style={{width:size,height:size}} aria-hidden="true">
  <Glyph name={name} size={size} className="execution-icon-base"/>
  {active&&<span className="execution-icon-water lake-forward-water"><Glyph name={name} size={size}/></span>}
 </span>;
}
