import type {AIQuestionOption, AIUserQuestion} from "../../shared/contracts";
export function questionOptions(question: AIUserQuestion): AIQuestionOption[] {
 return (question.options || []).map(option=>typeof option==="string"?{label:option}:option);
}
export function chooseAnswer(question: AIUserQuestion, selected: string[], label: string): string[] {
 if(!question.multi_select)return [label];
 return selected.includes(label)?selected.filter(value=>value!==label):[...selected,label];
}
export function questionAnswer(question: AIUserQuestion, selected: string[], text: string, other: boolean): string[] {
 const custom=other?text.trim():"";
 if(!question.multi_select&&other)return custom?[custom]:[];
 return [...selected,...(custom?[custom]:[])];
}
export function recordQuestionAnswer(previous: Record<string,string[]>, id: string, values: string[]): Record<string,string[]> {
 return {...previous,[id]:values};
}
