import type {AICard,Resource} from '../../shared/contracts';
import {Glyph,ResourceIcon} from './Icons';
import {progressGlyph} from './activity';

/** Preserve the shared tool silhouette; only the colored water layer moves. */
export function ExecutionIcon({card,active=false,size=18,glyph,resourceKind}:{card?:AICard;active?:boolean;size?:number;glyph?:string;resourceKind?:Resource['kind']}) {
 const name=glyph??progressGlyph(card);
 const icon=resourceKind?<ResourceIcon kind={resourceKind} size={size}/>:<Glyph name={name} size={size}/>;
 return <span className={`execution-icon${active?' is-active':''}`} data-kind={resourceKind??name} style={{width:size,height:size}} aria-hidden="true">
  <span className="execution-icon-base">{icon}</span>
  {active&&<span className="execution-icon-water lake-forward-water">{icon}</span>}
 </span>;
}
