import { expect, it } from 'vitest'
import { documentsProduced } from './Artifacts'

it('offers a generated image as a preview and download artifact', () => {
  expect(documentsProduced([{
    kind: 'tool',
    toolUseId: 'image-1',
    name: 'generate_image',
    input: { prompt: 'A paper boat', output_path: 'images/boat.png' },
    status: 'ok',
    output: 'Generated image'
  }])).toEqual(['images/boat.png'])
})
