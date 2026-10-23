import { describe, expect, it } from 'vitest'
import { routingLayout, ROUTING_CARD_WIDTH, ROUTING_CARD_HEIGHT, ROUTING_WIDTH } from './routingLayout'

describe('routing diagram bounds', () => {
  for (let count = 0; count <= 50; count++) {
    it(`keeps ${count} cards inside the canvas without overlaps`, () => {
      const { height, positions } = routingLayout(count)
      expect(positions).toHaveLength(count)
      positions.forEach(({ x, y }, index) => {
        expect(x - ROUTING_CARD_WIDTH / 2).toBeGreaterThanOrEqual(16)
        expect(x + ROUTING_CARD_WIDTH / 2).toBeLessThanOrEqual(ROUTING_WIDTH - 16)
        expect(y - ROUTING_CARD_HEIGHT / 2).toBeGreaterThanOrEqual(16)
        expect(y + ROUTING_CARD_HEIGHT / 2).toBeLessThanOrEqual(height - 16)
        expect(Math.abs(x - 360) >= 104 + 52 + 16 || Math.abs(y - height / 2) >= 31 + 18 + 16).toBe(true)
        positions.slice(index + 1).forEach((other) => {
          expect(Math.abs(x - other.x) >= ROUTING_CARD_WIDTH + 16 || Math.abs(y - other.y) >= ROUTING_CARD_HEIGHT + 16).toBe(true)
        })
      })
    })
  }
})
