import { beforeEach, expect, it, vi } from 'vitest'
import type { ChatParams, LLMProvider, ProviderEvent } from './types'
const { settings } = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }))
vi.mock('../settings', () => ({loadPersistedSettings:()=>settings,savePersistedSettings:(patch:object)=>Object.assign(settings,patch)}))
import { keyringProvider } from './keyring'
import { ProviderRequestError } from './requestError'
beforeEach(()=>{ for (const key of Object.keys(settings)) delete settings[key] })
const params = (): ChatParams => ({system:'',messages:[],tools:[],maxTokens:32,signal:new AbortController().signal})
const response: ProviderEvent = {type:'response',response:{content:[{type:'text',text:'OK'}],stopReason:'end_turn',usage:{inputTokens:10,outputTokens:2}}}
async function consume(client:LLMProvider):Promise<void> { for await(const _event of client.chat(params())) {} }
it('keeps one provider/model while splitting usage across keys and deduplicating repeated keys',async()=>{
  const calls:string[]=[]
  const create=(key:string):LLMProvider=>({name:'fixture',model:'coding-model',async *chat(){calls.push(key);yield response}})
  const client=keyringProvider('custom:one','coding-model',['first-key','second-key','first-key'],create)
  for(let i=0;i<4;i++) await consume(client)
  expect(calls).toEqual(['first-key','second-key','first-key','second-key'])
  expect(JSON.stringify(settings)).not.toContain('first-key')
  expect(JSON.stringify(settings)).not.toContain('second-key')
})
it('tries the next key once on quota failure and retains cooldown for subsequent provider instances',async()=>{
  const calls:string[]=[]
  const create=(key:string):LLMProvider=>({name:'fixture',model:'same',async *chat(){calls.push(key);if(key==='spent')throw Object.assign(new Error('quota'),{status:429});yield response}})
  await consume(keyringProvider('custom:one','same',['spent','ready'],create))
  await consume(keyringProvider('custom:one','same',['spent','ready'],create))
  expect(calls).toEqual(['spent','ready','ready'])
})
it('never repeats a partial streamed response with another key',async()=>{
  const calls:string[]=[]
  const create=(key:string):LLMProvider=>({name:'fixture',model:'same',async *chat(){calls.push(key);yield {type:'text_delta',text:'Partial'};throw Object.assign(new Error('stream failed'),{status:503})}})
  await expect(consume(keyringProvider('custom:one','same',['one','two'],create))).rejects.toThrow('stream failed')
  expect(calls).toEqual(['one'])
})

it('skips a key that failed after partial output when the user continues', async () => {
  const calls: string[] = []
  const client = keyringProvider('custom:partial', 'same', ['spent', 'ready'], (key) => ({ name: 'fixture', model: 'same', async *chat() {
    calls.push(key)
    if (key === 'spent') { yield { type: 'text_delta', text: 'Partial' }; throw Object.assign(new Error('quota exhausted'), { status: 429 }) }
    yield response
  } }))
  await expect(consume(client)).rejects.toThrow('quota exhausted')
  expect(calls).toEqual(['spent'])
  await consume(client)
  expect(calls).toEqual(['spent', 'ready'])
})
it('does not use another key for image compatibility or product access errors',async()=>{
  for(const status of [400,403]){
    const calls:string[]=[]
    const create=(key:string):LLMProvider=>({name:'fixture',model:'same',async *chat(){calls.push(key);throw Object.assign(new Error('unsupported'),{status});yield response}})
    await expect(consume(keyringProvider('custom:one','same',['one','two'],create))).rejects.toThrow('unsupported')
    expect(calls).toEqual(['one'])
  }
})

it('skips an unverified-email key without confusing it with a product restriction', async () => {
  const calls: string[] = []
  const make = (model: string) => keyringProvider('custom:verification', model, ['unverified', 'verified'], (key) => ({ name: 'fixture', model, async *chat() {
    calls.push(`${model}:${key}`)
    if (key === 'unverified') throw Object.assign(new Error('Verify your email address'), { status: 403, error: { code: 'email_verification_required' } })
    yield response
  } }))
  await consume(make('first'))
  await consume(make('second'))
  expect(calls).toEqual(['first:unverified', 'first:verified', 'second:verified'])
})

it('recognizes an explicit monthly quota error even when the gateway wraps it in HTTP 403',async()=>{
  const calls:string[]=[]
  const create=(key:string):LLMProvider=>({name:'fixture',model:'same',async *chat(){calls.push(key);if(key==='spent')throw Object.assign(new Error('monthly quota exhausted'),{status:403});yield response}})
  await consume(keyringProvider('custom:one','same',['spent','ready'],create))
  expect(calls).toEqual(['spent','ready'])
})

it('records primary-key usage before another key is added, so a new key can take the next request',async()=>{
  const calls:string[]=[]
  const create=(key:string):LLMProvider=>({name:'fixture',model:'same',async *chat(){calls.push(key);yield response}})
  await consume(keyringProvider('custom:one','same',['first-key'],create))
  await consume(keyringProvider('custom:one','same',['first-key','second-key'],create))
  expect(calls).toEqual(['first-key','second-key'])
})

it('benches a key for the failing model only, so another model on the same keys still runs',async()=>{
  const calls:string[]=[]
  const make=(model:string)=>keyringProvider('custom:one',model,['one','two'],(key):LLMProvider=>({name:'fixture',model,async *chat(){calls.push(`${model}:${key}`);if(model==='paid')throw Object.assign(new Error('Payment required'),{status:402});yield response}}))
  await expect(consume(make('paid'))).rejects.toThrow('Payment required')
  await expect(consume(make('paid'))).rejects.toThrow(/for paid are cooling down/)
  await consume(make('free'))
  expect(calls).toEqual(['paid:one','paid:two','free:one'])
})

it.each(['openai', 'anthropic', 'google', 'clinepass', 'gateway'])('fails over %s keys on nested connection failures before output', async (name) => {
  const calls: string[] = []
  const client = keyringProvider(`custom:${name}`, 'same', ['one', 'two'], (key) => ({
    name, model: 'same', async *chat() {
      calls.push(key)
      if (key === 'one') { yield { type: 'text_delta', text: '' }; throw new Error('request failed', { cause: { code: 'ECONNRESET' } }) }
      yield response
    }
  }))
  await consume(client)
  expect(calls).toEqual(['one', 'two'])
})

it('persists an exhausted primary key even before another key is added', async () => {
  const calls: string[] = []
  const create = (key: string): LLMProvider => ({ name: 'fixture', model: 'same', async *chat() {
    calls.push(key)
    if (key === 'spent') throw new ProviderRequestError('usage limit reached', 429, 'account', Date.now() + 3600000)
    yield response
  } })
  await expect(consume(keyringProvider('custom:one', 'same', ['spent'], create))).rejects.toThrow('usage limit')
  await consume(keyringProvider('custom:one', 'same', ['spent', 'ready'], create))
  expect(calls).toEqual(['spent', 'ready'])
})

it('honors account scope across models, without exposing keys in cooldown records', async () => {
  const calls: string[] = []
  const make = (model: string) => keyringProvider('custom:one', model, ['one', 'two'], (key) => ({ name: 'fixture', model, async *chat() {
    calls.push(`${model}:${key}`)
    if (key === 'one') throw new ProviderRequestError('usage limit reached', 429, 'account', Date.now() + 3600000)
    yield response
  } }))
  await consume(make('first'))
  await consume(make('second'))
  expect(calls).toEqual(['first:one', 'first:two', 'second:two'])
})

it('does not cool down keys for a prompt-specific credit limit and retains the largest allowance', async () => {
  const calls: string[] = []
  let large = true
  const provider = keyringProvider('custom:input-limit', 'same', ['one', 'two'], key => ({
    name: 'fixture', model: 'same', async *chat() {
      calls.push(key)
      if (large) throw Object.assign(new Error(`Prompt tokens limit exceeded: 79985 > ${key === 'one' ? 33060 : 9785}`), { status: 402 })
      yield response
    }
  }))
  await expect(consume(provider)).rejects.toThrow('33060')
  expect(calls).toEqual(['one', 'two'])
  large = false
  await consume(provider)
  expect(calls).toEqual(['one', 'two', 'one'])
})

it('does not turn reserved in-flight credits into a 15-minute key ban', async () => {
  let fail = true
  const provider = keyringProvider('custom:inflight', 'same', ['one'], () => ({
    name: 'fixture', model: 'same', async *chat() {
      if (fail) throw Object.assign(new Error('This request would exceed your available credits given your current in-flight requests.'), { status: 402 })
      yield response
    }
  }))
  await expect(consume(provider)).rejects.toThrow(/in-flight/)
  fail = false
  await consume(provider)
})
