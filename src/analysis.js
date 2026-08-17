const n = (value) => Number(String(value ?? '').replaceAll(',', '').trim()) || 0
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function rocDate(value) {
  const raw = String(value || '').replaceAll('/', '')
  if (raw.length !== 7) return raw || '—'
  const year = Number(raw.slice(0, 3)) + 1911
  return `${year}.${raw.slice(3, 5)}.${raw.slice(5, 7)}`
}

export function tickSize(price) {
  if (price < 10) return 0.01
  if (price < 50) return 0.05
  if (price < 100) return 0.1
  if (price < 500) return 0.5
  if (price < 1000) return 1
  return 5
}

export function roundTick(value) {
  const tick = tickSize(value)
  const rounded = Math.round(value / tick) * tick
  const digits = tick < 0.1 ? 2 : tick < 1 ? 1 : 0
  return rounded.toFixed(digits)
}

function rangeFit(rangePct) {
  if (rangePct < 1) return rangePct * 7
  if (rangePct <= 4.5) return 7 + (rangePct - 1) * 2.3
  return Math.max(2, 15 - (rangePct - 4.5) * 2.2)
}

function liquidity(value) {
  return clamp((Math.log10(Math.max(value, 1)) - 7) * 8.5, 0, 20)
}

function normalizeTwse(row, eligible) {
  return {
    market: '上市', date: row.Date, code: row.Code, name: row.Name,
    volume: n(row.TradeVolume), value: n(row.TradeValue), transactions: n(row.Transaction),
    open: n(row.OpeningPrice), high: n(row.HighestPrice), low: n(row.LowestPrice),
    close: n(row.ClosingPrice), change: n(row.Change),
    canShort: eligible?.Suspension !== 'Y', eligible: Boolean(eligible),
  }
}

function normalizeTpex(row, eligible) {
  return {
    market: '上櫃', date: row.Date, code: row.SecuritiesCompanyCode, name: row.CompanyName,
    volume: n(row.TradingShares), value: n(row.TransactionAmount), transactions: n(row.TransactionNumber),
    open: n(row.Open), high: n(row.High), low: n(row.Low), close: n(row.Close), change: n(row.Change),
    canShort: eligible?.['暫停現股賣出後現款買進當沖註記'] !== 'Y', eligible: Boolean(eligible),
  }
}

function enrich(stock) {
  const prevClose = stock.close - stock.change
  const valid = stock.close > 0 && stock.open > 0 && stock.high >= stock.low && prevClose > 0
  if (!valid) return null
  const dayRange = Math.max(stock.high - stock.low, tickSize(stock.close))
  const changePct = stock.change / prevClose * 100
  const rangePct = dayRange / prevClose * 100
  const gapPct = (stock.open - prevClose) / prevClose * 100
  const closePosition = clamp((stock.close - stock.low) / dayRange, 0, 1)
  const liquid = liquidity(stock.value)
  const activity = clamp((Math.log10(Math.max(stock.transactions, 1)) - 2.4) * 4, 0, 10)
  const range = rangeFit(rangePct)
  const extensionPenalty = Math.max(0, Math.abs(changePct) - 5) * 3 + Math.max(0, Math.abs(gapPct) - 3) * 2
  const longScore = clamp(Math.round(35 + liquid + activity + range + (closePosition - .5) * 22 + clamp(changePct, -3, 3) * 2 - extensionPenalty), 0, 99)
  const shortScore = clamp(Math.round(35 + liquid + activity + range + (.5 - closePosition) * 22 - clamp(changePct, -3, 3) * 2 - extensionPenalty), 0, 99)
  const bestSide = stock.canShort && shortScore > longScore ? 'short' : 'long'
  const score = bestSide === 'long' ? longScore : shortScore
  const trigger = bestSide === 'long' ? stock.high + tickSize(stock.high) : stock.low - tickSize(stock.low)
  const pullback = bestSide === 'long' ? stock.close - dayRange * .18 : stock.close + dayRange * .18
  const riskDistance = Math.max(dayRange * .55, stock.close * .009)
  const stop = bestSide === 'long' ? trigger - riskDistance : trigger + riskDistance
  const target = bestSide === 'long' ? trigger + riskDistance * 1.7 : trigger - riskDistance * 1.7
  const reasons = []
  if (stock.value >= 1_000_000_000) reasons.push('流動性佳')
  else if (stock.value >= 200_000_000) reasons.push('量能合格')
  if (rangePct >= 1.5 && rangePct <= 5) reasons.push('振幅適中')
  if (bestSide === 'long' && closePosition > .66) reasons.push('收盤偏強')
  if (bestSide === 'short' && closePosition < .34) reasons.push('收盤偏弱')
  if (Math.abs(gapPct) > 3) reasons.push('慎防跳空')
  if (!stock.canShort) reasons.push('暫停先賣現沖')

  return {
    ...stock, prevClose, changePct, rangePct, gapPct, closePosition,
    longScore, shortScore, bestSide, score,
    trigger: roundTick(trigger), pullback: roundTick(pullback), stop: roundTick(stop), target: roundTick(target),
    reasons: reasons.slice(0, 3),
  }
}

export function buildAnalysis(raw) {
  const twseEligibility = new Map((raw.twseEligible || []).map(x => [x.Code, x]))
  const tpexEligibility = new Map((raw.tpexEligible || []).map(x => [x['證券代號'], x]))
  const dateKey = value => String(value || '').replaceAll('/', '')
  const latestDate = [...(raw.twseQuotes || []), ...(raw.tpexQuotes || [])]
    .reduce((latest, row) => dateKey(row.Date) > latest ? dateKey(row.Date) : latest, '')
  const twse = (raw.twseQuotes || [])
    .filter(x => !latestDate || dateKey(x.Date) === latestDate)
    .map(x => normalizeTwse(x, twseEligibility.get(x.Code)))
  const tpex = (raw.tpexQuotes || [])
    .filter(x => !latestDate || dateKey(x.Date) === latestDate)
    .map(x => normalizeTpex(x, tpexEligibility.get(x.SecuritiesCompanyCode)))

  return [...twse, ...tpex]
    .filter(x => x.eligible && /^\d{4}$/.test(x.code) && x.value >= 30_000_000)
    .map(enrich)
    .filter(Boolean)
}

export function marketState(stocks) {
  const liquid = [...stocks].sort((a, b) => b.value - a.value).slice(0, 80)
  const breadth = liquid.length ? liquid.filter(x => x.changePct > 0).length / liquid.length * 100 : 0
  const avgMove = liquid.length ? liquid.reduce((sum, x) => sum + x.changePct, 0) / liquid.length : 0
  const avgRange = liquid.length ? liquid.reduce((sum, x) => sum + x.rangePct, 0) / liquid.length : 0
  let tone = '中性盤'
  let note = '多空分歧，等開盤方向確認'
  if (breadth >= 58 && avgMove > .35) { tone = '偏多盤'; note = '優先找強勢回踩或突破' }
  if (breadth <= 42 && avgMove < -.35) { tone = '偏空盤'; note = '先賣現沖需確認可放空資格' }
  return { breadth, avgMove, avgRange, tone, note }
}
