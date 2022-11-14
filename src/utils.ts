export interface Weighted {
  weightedPrice: number;
  totalSize: number;
  bestPrice: number;
}

// as per https://stackoverflow.com/questions/10830357/javascript-toisostring-ignores-timezone-offset
export function dateStr(d: Date) {
  const tzoffset = d.getTimezoneOffset() * 60000; //offset in milliseconds
  return new Date(d.getTime() - tzoffset).toISOString().slice(0, -1);
}

export function getWeighted(priceAndSizes: [number, number][], depth: number): Weighted {
  const bids = [];
  let amountToCover = depth;
  let bestPrice = undefined;
  for (var priceAndSize of priceAndSizes) {
    const [price, size] = priceAndSize;
    const actSize = Math.min(size, amountToCover);
    amountToCover -= actSize;
    bids.push([price, actSize]);
    bestPrice = price;
    if (amountToCover <= 0) break;
  }

  const totalSize = bids.map(([_price, size]) => size).reduce((x, y) => x + y, 0);
  const totalWeightedPrice = bids.map(([price, size]) => price * size).reduce((x, y) => x + y, 0);

  if (totalSize < depth) return { weightedPrice: undefined, totalSize, bestPrice };
  else return { weightedPrice: totalWeightedPrice / totalSize, totalSize, bestPrice };
}

export function assert(predicate: boolean, desc: string) {
  if (!predicate) throw new Error(desc);
}
