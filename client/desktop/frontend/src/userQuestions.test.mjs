import assert from 'node:assert/strict'
import test from 'node:test'
import { questionAnswers } from './userQuestions.ts'

test('questions require explicit answers and accept options or free text', () => {
  const questions = [{ id: 'target', header: '目标', prompt: '哪一个', options: [{ label: '宿主' }, { label: '容器' }] }, { id: 'port', header: '端口', prompt: '新端口' }]
  assert.equal(questionAnswers(questions, {}, {}), null)
  assert.equal(questionAnswers(questions, { target: '宿主' }, {}), null)
  assert.deepEqual(questionAnswers(questions, { target: '宿主' }, { port: '7799' }), { target: '宿主', port: '7799' })
  assert.deepEqual(questionAnswers(questions, { target: '宿主' }, { target: ' /opt/nginx ', port: '7799' }), { target: '/opt/nginx', port: '7799' })
})
