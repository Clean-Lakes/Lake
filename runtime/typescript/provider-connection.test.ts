import {test} from 'node:test';
import assert from 'node:assert/strict';
import {providerConnection, modelCatalogHeaders} from './provider-connection';

test('SDK provider endpoints preserve explicit wire protocols and normalize documented compatibility bases', () => {
  assert.equal(providerConnection('openai-response', 'https://models.example/v1/responses').apiType, 'openai-responses');
  assert.equal(providerConnection('claude', 'https://models.example/v1/messages').baseURL, 'https://models.example/v1');
  assert.equal(providerConnection('gemini', 'https://generativelanguage.googleapis.com/v1beta/').modelsURL, 'https://generativelanguage.googleapis.com/v1beta/openai/models');
  assert.equal(providerConnection('gemini', 'https://models.example/v1beta/openai/').baseURL, 'https://models.example/v1beta/openai');
  assert.equal(providerConnection('ollama', 'http://127.0.0.1:11434').baseURL, 'http://127.0.0.1:11434/v1');
  assert.equal(providerConnection('ollama', 'http://127.0.0.1:11434/v1/').baseURL, 'http://127.0.0.1:11434/v1');
  assert.deepEqual(modelCatalogHeaders('anthropic-messages', 'synthetic'), {'anthropic-version': '2023-06-01', 'x-api-key': 'synthetic'});
});

test('unknown protocols and credential-bearing or malformed bases cannot silently become OpenAI requests', () => {
  for (const [protocol, url] of [['unknown', 'http://127.0.0.1:1'], ['openai', 'https://user:pass@example.test/v1'],
    ['gemini', 'https://example.test/v1beta?key=secret'], ['ollama', 'file:///tmp/model'], ['openai', 'not-a-url']])
    assert.throws(() => providerConnection(protocol, url));
});
