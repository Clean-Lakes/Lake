import type {SpecialistQuestion} from '../../shared/contracts';
import {AgentQuestion} from './AgentQuestion';
import {pilotIdentity} from './superAgentPresentation';
import {ReplyIdentity} from './ReplyIdentity';

export function PilotSpecialistQuestions({questions,connected,onAnswered}:{questions?:SpecialistQuestion[];connected:boolean;onAnswered:()=>Promise<unknown>}){
 if(!questions?.length)return null;
 return <section className="pilot-specialist-questions" aria-label="专员的问题">
  {questions.map(({author,request,taskTitle})=><fieldset className="pilot-specialist-question" key={`${author.workerId}:${request.id}`} disabled={!connected} aria-label={`${author.name}的问题`}>
   <AgentQuestion session={author.sessionId} request={request} refresh={onAnswered} identity={<>
    <ReplyIdentity identity={pilotIdentity} author={author}/>
    <p className="pilot-specialist-question-task">{taskTitle}</p>
   </>}/>
  </fieldset>)}
 </section>;
}
