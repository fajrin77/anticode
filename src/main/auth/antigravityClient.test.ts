import { expect, it } from 'vitest'
import { clientFromRouterBundle } from './antigravityClient'
it('selects only the installed Antigravity OAuth client without executing the bundle', () => {
  expect(clientFromRouterBundle('x=[{id:"other",clientId:"wrong",clientSecret:"wrong"},{id:"antigravity",category:"oauth",clientId:"fixture-client",clientSecret:"fixture-secret"},{id:"next"}]')).toEqual({ id: 'fixture-client', secret: 'fixture-secret' })
  expect(clientFromRouterBundle('x={clientId:"wrong",clientSecret:"wrong"}')).toBeUndefined()
  expect(clientFromRouterBundle('x=[{id:"antigravity"},{id:"other",clientId:"wrong",clientSecret:"wrong"}]')).toBeUndefined()
})
