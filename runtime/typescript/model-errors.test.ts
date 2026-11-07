import {test} from 'node:test';
import assert from 'node:assert/strict';
import {redactModelValue,describeTurnFailure} from './model-errors';

const secret='synthetic-private-token';
const redact=(text:string)=>text.replaceAll(secret,'[REDACTED]');

test('model redaction retains Error identity, non-enumerable cause/message and SDK brands',()=>{
 const brand=Symbol.for('synthetic.sdk.error');
 class ProviderError extends Error {readonly [brand]=true;readonly code='model_request_failed';readonly context={source:'provider',errorPhase:'stream',retryable:false};}
 const cause=new TypeError('Provider stream broke '+secret);
 const original=new ProviderError('Model request failed.',{cause});
 const clean=redactModelValue({type:'error',error:original},redact).error;
 assert.ok(clean instanceof ProviderError);assert.ok(clean.cause instanceof TypeError);
 assert.equal(clean[brand],true);assert.equal(clean.message,'Model request failed.');
 assert.equal((clean.cause as Error).message,'Provider stream broke [REDACTED]');
 assert.ok(!String((clean.cause as Error).stack).includes(secret));
 assert.equal(Object.getOwnPropertyDescriptor(clean,'message')?.enumerable,false);
 assert.equal((original.cause as Error).message,'Provider stream broke '+secret,'provider errors are not mutated');
 assert.deepEqual(describeTurnFailure(new Error('Turn execution failed',{cause:clean}),redact),{
  message:'模型调用失败：Provider stream broke [REDACTED]',source:'provider',code:'model_request_failed',phase:'stream',retryable:false,
 });
});

test('public failure data includes only bounded classification, not headers, stacks or response payloads',()=>{
 const error=Object.assign(new Error('Turn execution failed'),{cause:Object.assign(new Error('Model request failed.'),{
  code:'model_request_failed',context:{source:'provider',statusCode:401,errorPhase:'response',retryable:false,headers:{Authorization:secret}},responseBody:secret,
 })});
 const result=describeTurnFailure(error,redact);
 assert.equal(result.statusCode,401);assert.equal(result.message,'模型服务认证失败，请检查当前供应商配置。');
 assert.ok(!JSON.stringify(result).includes(secret));assert.ok(!Object.hasOwn(result,'stack'));
 const cycle=new Error('bounded');Object.defineProperty(cycle,'cause',{value:cycle});
 const clean=redactModelValue(cycle,redact);assert.equal(clean.cause,clean);
 assert.equal(describeTurnFailure(clean,redact).message,'bounded');
});

test('model values cannot change object prototypes through untrusted keys',()=>{
 const value=JSON.parse('{"__proto__":{"polluted":true},"text":"'+secret+'"}');
 const clean=redactModelValue(value,redact);
 assert.equal(Object.getPrototypeOf(clean),Object.prototype);assert.ok(Object.hasOwn(clean,'__proto__'));
 assert.equal(clean.polluted,undefined);assert.equal(clean.text,'[REDACTED]');
});
