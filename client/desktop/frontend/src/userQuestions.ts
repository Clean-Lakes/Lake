export type UserQuestion = { id: string; header: string; prompt: string; multiSelect?: boolean; options?: { label: string; description?: string }[] }
export type UserQuestionRequest = { id: string; questions: UserQuestion[] }
export type QuestionView = UserQuestionRequest & { turnID?: string; status: 'pending' | 'answered' | 'interrupted'; answers?: Record<string, string>; error?: string }

export function questionAnswers(questions: UserQuestion[], choices: Record<string, string>, custom: Record<string, string>): Record<string, string> | null {
  const answers: Record<string, string> = {}
  for (const question of questions) {
    const value = (custom[question.id] || choices[question.id] || '').trim()
    if (!value || (question.multiSelect && value === '[]') || [...value].length > 2048) return null
    answers[question.id] = value
  }
  return answers
}
