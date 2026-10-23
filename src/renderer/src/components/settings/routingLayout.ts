export const ROUTING_WIDTH = 720
export const ROUTING_CARD_WIDTH = 208
export const ROUTING_CARD_HEIGHT = 62

/** Leave room for every card, its glow, and a dedicated central router lane. */
export function routingLayout(count: number): { height: number; positions: { x: number; y: number }[] } {
  const height = count <= 4 ? 360 : Math.max(360, Math.ceil(count / 2) * 86 + 40)
  const positions = Array.from({ length: count }, (_, index) => {
    if (count <= 4) {
      const angle = (index / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2
      return { x: 360 + Math.cos(angle) * 240, y: height / 2 + Math.sin(angle) * 130 }
    }
    const columnRows = index % 2 === 0 ? Math.ceil(count / 2) : Math.floor(count / 2)
    return { x: index % 2 === 0 ? 120 : 600, y: height / 2 + (Math.floor(index / 2) - (columnRows - 1) / 2) * 86 }
  })
  return { height, positions }
}
