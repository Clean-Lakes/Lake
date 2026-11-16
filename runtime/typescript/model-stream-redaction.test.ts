import {test} from 'node:test';
import assert from 'node:assert/strict';
import {redactModelStream} from './model-stream-redaction';
import {redactModelValue} from './model-errors';

type Event = Parameters<typeof redactModelStream>[0] extends AsyncIterable<infer Value> ? Value : never;
function stream(events: Event[], secrets = new Set(['synthetic-private-token'])) {
  const scrub = <T>(value: T) => redactModelValue(value, text => {
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[PRIVATE KEY REDACTED]');
  });
  return redactModelStream((async function* () { yield* events; })(), secrets, scrub);
}
const textOf = (event: Event) => 'text' in event ? event.text : 'delta' in event ? event.delta : '';
async function collect(events: Event[], secrets?: Set<string>) {
  const output: Event[] = []; for await (const event of stream(events, secrets)) output.push(event); return output;
}

test('ordinary short text, reasoning and tool input publish before any end event regardless of credential length', async () => {
  const secrets = new Set(['synthetic-oauth-' + 'x'.repeat(16000)]);
  const events: Event[] = [{type: 'text_delta', id: 'reply', text: '收到。'}, {type: 'reasoning_delta', id: 'reason', text: '先核对。'},
    {type: 'tool_input_delta', id: 'call', delta: '{"query":"当前状态"}'}];
  const iterator = stream(events, secrets);
  for (const event of events) assert.deepEqual((await iterator.next()).value, event);
  assert.equal((await iterator.next()).done, true);
});

test('every credential split releases safe prefixes immediately without exposing a partial or complete credential', async () => {
  const secret = 'synthetic-private-token';
  for (let cut = 1; cut < secret.length; cut++) {
    const iterator = stream([{type: 'text_delta', text: '准备。' + secret.slice(0, cut)}, {type: 'text_delta', text: secret.slice(cut) + '继续。'}]);
    assert.equal(textOf((await iterator.next()).value!), '准备。');
    assert.equal(textOf((await iterator.next()).value!), '[REDACTED]继续。');
    assert.equal((await iterator.next()).done, true);
  }
});

test('overlapping credential prefixes and one-character chunks remain redacted with original punctuation', async () => {
  const secrets = new Set(['abc', 'abcdef', 'bcdef', 'a']);
  const text = '中文 abcdef abc a 完成。';
  const output = await collect([...text].map(text => ({type: 'reasoning_delta', id: 'r', text})), secrets);
  assert.equal(output.map(textOf).join(''), '中文 [REDACTED] [REDACTED] [REDACTED] 完成。');
  assert.ok(!output.some(event => /abc|bcdef/.test(textOf(event))));
});

test('all PEM boundary splits hide the entire body and release subsequent public text while still streaming', async () => {
  for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
    const pem = `-----BEGIN ${label}-----\nsynthetic-private-body\n-----END ${label}-----`;
    for (let cut = 1; cut < pem.length; cut++) {
      const output = await collect([{type: 'text_delta', text: '之前。' + pem.slice(0, cut)}, {type: 'text_delta', text: pem.slice(cut) + '之后。'}]);
      assert.equal(output.map(textOf).join(''), '之前。[PRIVATE KEY REDACTED]之后。');
    }
    const output = await collect([...pem].map(text => ({type: 'text_delta', text})));
    assert.equal(output.map(textOf).join(''), '[PRIVATE KEY REDACTED]');
  }
  assert.equal((await collect([{type: 'text_delta', text: '-----BEGIN PRIVATE KEY-----' + 'sensitive'.repeat(100000)}])).map(textOf).join(''), '[PRIVATE KEY REDACTED]');
});

test('interleaved channel ends cannot flush another channel and idless deltas follow their real start identity', async () => {
  const secret = 'synthetic-private-token';
  const output = await collect([
    {type: 'reasoning_start', id: 'r'}, {type: 'reasoning_delta', text: secret.slice(0, 12)},
    {type: 'text_start', id: 'm'}, {type: 'text_delta', text: '收到。'}, {type: 'text_end', id: 'm'},
    {type: 'tool_input_start', id: 'call', toolName: 'fixture'}, {type: 'tool_input_delta', id: 'call', delta: '{"text":"' + secret.slice(0, 7)},
    {type: 'reasoning_delta', text: secret.slice(12) + '。'}, {type: 'reasoning_end', id: 'r'},
    {type: 'tool_input_delta', id: 'call', delta: secret.slice(7) + '"}'}, {type: 'tool_input_end', id: 'call'},
  ]);
  assert.equal(output.filter(event => event.type === 'reasoning_delta').map(textOf).join(''), '[REDACTED]。');
  assert.equal(output.filter(event => event.type === 'tool_input_delta').map(textOf).join(''), '{"text":"[REDACTED]"}');
  assert.equal(output.filter(event => event.type === 'text_delta').map(textOf).join(''), '收到。');
});

test('ordinary ambiguous punctuation is released at a real end while unfinished private key bodies stay hidden', async () => {
  const output = await collect([{type: 'text_start', id: 'm'}, {type: 'text_delta', text: '列表 ---'}, {type: 'text_end', id: 'm'}]);
  assert.equal(output.map(textOf).join(''), '列表 ---');
  assert.equal((await collect([{type: 'text_delta', text: '此前 -----BEGIN RSA PRIVATE KEY-----\nno footer'}])).map(textOf).join(''), '此前 [PRIVATE KEY REDACTED]');
  assert.equal((await collect([{type: 'text_delta', text: '普通 -----BEGIN CERTIFICATE-----内容'}])).map(textOf).join(''), '普通 -----BEGIN CERTIFICATE-----内容');
});

test('providers may omit a repeated delta ID without breaking credential redaction', async () => {
  const output = await collect([{type: 'text_delta', id: 'm', text: '准备。synthetic-private-'},
    {type: 'text_delta', text: 'token。'}, {type: 'text_end', id: 'm'}]);
  assert.equal(output.map(textOf).join(''), '准备。[REDACTED]。');
});

test('error events discard ambiguous bytes and keep structured metadata safe', async () => {
  const output = await collect([{type: 'text_delta', text: '安全。synthetic-private-'},
    {type: 'error', error: Object.assign(new Error('synthetic-private-token'), {statusCode: 401})}]);
  assert.equal(output.map(textOf).join(''), '安全。');
  const error = (output.at(-1) as {error: Error & {statusCode: number}}).error;
  assert.equal(error.message, '[REDACTED]'); assert.equal(error.statusCode, 401); assert.ok(error instanceof Error);
});
