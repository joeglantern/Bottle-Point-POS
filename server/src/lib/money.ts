// All money is integer cents. These helpers keep that honest.
export const toCents = (shillings: number) => Math.round(shillings * 100)
export const fromCents = (cents: number) => cents / 100
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
