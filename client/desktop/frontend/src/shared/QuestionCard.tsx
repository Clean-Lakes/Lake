import { useEffect, useState } from 'react'
import { Check, CircleHelp, LoaderCircle } from 'lucide-react'
import { questionAnswers, type QuestionView } from '../userQuestions'

export function QuestionCard({ question, onAnswer }: { question: QuestionView; onAnswer?: (answers: Record<string, string>) => Promise<void> }) {
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const active = question.status === 'pending' && !!onAnswer
  const selected = (item: {id:string;multiSelect?:boolean}, label: string) => item.multiSelect ? (JSON.parse(choices[item.id] || '[]') as string[]).includes(label) : choices[item.id] === label
  const choose = (item: {id:string;multiSelect?:boolean}, label: string) => {setChoices(previous => {const values: string[]=item.multiSelect ? JSON.parse(previous[item.id] || '[]') : [];return {...previous,[item.id]:item.multiSelect ? JSON.stringify(values.includes(label) ? values.filter(value=>value !== label) : [...values,label]) : label}});setCustom(previous=>({...previous,[item.id]:''}))}
  const answers = questionAnswers(question.questions, choices, custom)
  useEffect(() => { if (question.error || question.status !== 'pending') setSubmitting(false) }, [question.error, question.status])
  return <form className={'question-card ' + question.status} aria-label="回答 Lake 的问题" onSubmit={async event => {
    event.preventDefault()
    if (!active || !answers || submitting) return
    setSubmitting(true); setError('')
    try { await onAnswer!(answers) } catch (cause) { setError(String(cause)); setSubmitting(false) }
  }}>
    <div className="question-card-title"><CircleHelp size={17} /><strong>{question.status === 'answered' ? '已收到你的回答' : question.status === 'interrupted' ? '问题已中断' : '需要你补充'}</strong>{question.status === 'answered' && <Check size={16} />}</div>
    {question.questions.map((item, index) => <fieldset key={item.id} disabled={!active || submitting}>
      <legend>{question.questions.length > 1 ? `${index + 1}. ` : ''}{item.header}</legend>
      <p>{item.prompt}</p>
      {question.status === 'answered' ? <div className="question-answer">{question.answers?.[item.id]}</div> : active ? <>
        {item.options?.length ? <div className="question-options">{item.options.map(option => <label className={'question-option ' + (selected(item,option.label) && !custom[item.id] ? 'selected' : '')} key={option.label}>
          <input type={item.multiSelect ? "checkbox" : "radio"} name={`${question.id}-${item.id}`} checked={selected(item,option.label) && !custom[item.id]} onChange={() => choose(item,option.label)} />
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        </label>)}</div> : null}
        <label className="question-custom-label">{item.options?.length ? '或直接回答' : '你的回答'}<textarea aria-label={`${item.header}：直接回答`} value={custom[item.id] ?? ''} maxLength={2048} rows={2} placeholder="填写你的选择或补充信息" onChange={event => setCustom(previous => ({ ...previous, [item.id]: event.target.value }))} /></label>
      </> : <div className="question-inactive">此问题所属运行已结束</div>}
    </fieldset>)}
    {(question.error || error) && <p className="question-error" role="alert">{question.error || error}</p>}
    {active && <div className="question-card-footer"><span>回答后继续当前任务</span><button type="submit" className="primary" disabled={!answers || submitting}>{submitting && <LoaderCircle size={14} className="spin" />}{submitting ? '正在提交' : '回答并继续'}</button></div>}
  </form>
}
