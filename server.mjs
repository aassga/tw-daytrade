import { createServer } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import fetch from 'node-fetch'

const preferredPort = Number(process.env.PORT || 8787)
const dist = join(process.cwd(), 'dist')
const cacheFile = join(process.cwd(), '.cache', 'market-data.json')
const sources = {
  twseEligible: 'https://openapi.twse.com.tw/v1/exchangeReport/TWTB4U',
  tpexQuotes: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
  tpexEligible: 'https://www.tpex.org.tw/openapi/v1/tpex_securities',
}

let cache = null
let cachedAt = 0
const cacheMs = 5 * 60 * 1000
const realtimeCache = new Map()
const realtimeCacheMs = 4 * 1000

async function timedFetch(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function restoreCache() {
  if (cache) return
  try {
    cache = JSON.parse(await readFile(cacheFile, 'utf8'))
    cachedAt = Date.parse(cache.fetchedAt) || 0
  } catch {
    // 第一次執行時尚未建立快取是正常狀態。
  }
}

async function persistCache(payload) {
  await mkdir(join(process.cwd(), '.cache'), { recursive: true })
  await writeFile(cacheFile, JSON.stringify(payload), 'utf8')
}

async function fetchJson(url, extraHeaders = {}) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await timedFetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 TW-Daytrade-Dashboard/1.0', ...extraHeaders },
      }, 20000)
      if (!response.ok) throw new Error(`官方資料源回應 ${response.status}`)
      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 600))
    }
  }
  throw lastError
}

function numberOrNull(value) {
  const number = Number(String(value ?? '').replaceAll(',', '').trim())
  return Number.isFinite(number) && number > 0 ? number : null
}

function quoteLevels(value) {
  return String(value || '').split('_').filter(Boolean).map(numberOrNull).filter(Boolean)
}

function taipeiSession() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date())
  const value = type => parts.find(part => part.type === type)?.value || ''
  const minutes = Number(value('hour')) * 60 + Number(value('minute'))
  const weekday = value('weekday')
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed'
  if (minutes >= 510 && minutes < 540) return 'preopen'
  if (minutes >= 540 && minutes <= 810) return 'trading'
  return 'closed'
}

async function realtimeData(channels) {
  const key = [...channels].sort().join('|')
  const saved = realtimeCache.get(key)
  if (saved && Date.now() - saved.fetchedAt < realtimeCacheMs) return saved.payload
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(key)}&json=1&delay=0`
  const raw = await fetchJson(url, { Referer: 'https://mis.twse.com.tw/' })
  const session = taipeiSession()
  const quotes = (raw.msgArray || []).map(row => {
    const lastPrice = numberOrNull(row.z)
    const trialPrice = numberOrNull(row.pz)
    return {
      market: row.ex === 'tse' ? '上市' : '上櫃',
      code: row.c,
      name: row.n,
      date: row.d,
      time: session === 'preopen' ? (row['%'] || row.t) : (row.t || row['%']),
      price: session === 'preopen' ? (trialPrice || lastPrice) : (lastPrice || trialPrice),
      volume: numberOrNull(session === 'preopen' ? (row.ps || row.tv) : row.v),
      reference: numberOrNull(row.y),
      open: numberOrNull(row.o),
      high: numberOrNull(row.h),
      low: numberOrNull(row.l),
      bestAsk: quoteLevels(row.a),
      bestBid: quoteLevels(row.b),
    }
  })
  const payload = {
    session,
    fetchedAt: new Date().toISOString(),
    exchangeDate: raw.queryTime?.sysDate || '',
    exchangeTime: raw.queryTime?.sysTime || '',
    quotes,
  }
  realtimeCache.set(key, { fetchedAt: Date.now(), payload })
  if (realtimeCache.size > 20) realtimeCache.delete(realtimeCache.keys().next().value)
  return payload
}

function dateInTaipei(daysAgo = 0) {
  const date = new Date(Date.now() - daysAgo * 86400000)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const value = type => parts.find(part => part.type === type)?.value || ''
  return `${value('year')}${value('month')}${value('day')}`
}

function twseDailyRows(payload) {
  const table = payload?.tables?.find(item =>
    item.fields?.includes('證券代號') && item.fields?.includes('開盤價'))
  if (!table || !payload.date) return []
  const index = name => table.fields.indexOf(name)
  const plain = value => String(value ?? '').replace(/<[^>]*>/g, '').trim()
  const rocDate = `${Number(payload.date.slice(0, 4)) - 1911}${payload.date.slice(4)}`
  return table.data.map(row => {
    const direction = plain(row[index('漲跌(+/-)')])
    const difference = plain(row[index('漲跌價差')]).replaceAll(',', '')
    return {
      Date: rocDate,
      Code: plain(row[index('證券代號')]),
      Name: plain(row[index('證券名稱')]),
      TradeVolume: plain(row[index('成交股數')]),
      TradeValue: plain(row[index('成交金額')]),
      OpeningPrice: plain(row[index('開盤價')]),
      HighestPrice: plain(row[index('最高價')]),
      LowestPrice: plain(row[index('最低價')]),
      ClosingPrice: plain(row[index('收盤價')]),
      Change: direction.includes('-') ? `-${difference}` : difference,
      Transaction: plain(row[index('成交筆數')]),
    }
  })
}

async function fetchLatestTwseQuotes() {
  let lastError
  for (let daysAgo = 0; daysAgo < 10; daysAgo += 1) {
    try {
      const date = dateInTaipei(daysAgo)
      const payload = await fetchJson(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${date}&type=ALLBUT0999&response=json`)
      const rows = twseDailyRows(payload)
      if (rows.length) return rows
    } catch (error) {
      lastError = error
    }
  }
  try {
    return await fetchJson('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL')
  } catch (error) {
    throw lastError || error
  }
}

async function marketData(force = false) {
  await restoreCache()
  if (!force && cache && Date.now() - cachedAt < cacheMs) return cache
  const requests = { twseQuotes: fetchLatestTwseQuotes(), ...Object.fromEntries(Object.entries(sources).map(([key, url]) => [key, fetchJson(url)])) }
  const keys = Object.keys(requests)
  const results = await Promise.allSettled(Object.values(requests))
  const previous = cache
  const payload = { fetchedAt: new Date().toISOString(), warnings: [], staleSources: [] }
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') payload[keys[index]] = result.value
    else {
      payload[keys[index]] = previous?.[keys[index]] || []
      if (payload[keys[index]].length) payload.staleSources.push(keys[index])
      payload.warnings.push(`${keys[index]}：${result.reason?.message || '讀取失敗'}`)
    }
  })
  const liveQuoteCount = ['twseQuotes', 'tpexQuotes']
    .filter(key => results[keys.indexOf(key)]?.status === 'fulfilled').length
  if (!payload.twseQuotes.length && !payload.tpexQuotes.length) throw new Error('目前無法連線至官方行情資料源')
  if (!liveQuoteCount && previous) {
    return {
      ...previous,
      servedAt: new Date().toISOString(),
      staleSources: keys,
      warnings: payload.warnings,
    }
  }
  cache = payload
  cachedAt = Date.now()
  persistCache(payload).catch(error => console.warn(`快取寫入失敗：${error.message}`))
  return payload
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

const server = createServer(async (req, res) => {
  try {
    if (req.url?.startsWith('/api/realtime')) {
      const requestUrl = new URL(req.url, 'http://localhost')
      const channels = [...new Set((requestUrl.searchParams.get('channels') || '').split(','))]
        .filter(channel => /^(tse|otc)_\d{4,6}\.tw$/.test(channel))
        .slice(0, 40)
      if (!channels.length) {
        res.writeHead(400, { 'Content-Type': mime['.json'], 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ error: '缺少有效的即時行情代號' }))
        return
      }
      const data = await realtimeData(channels)
      res.writeHead(200, { 'Content-Type': mime['.json'], 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(data))
      return
    }

    if (req.url?.startsWith('/api/market-data')) {
      const data = await marketData(req.url.includes('refresh=1'))
      res.writeHead(200, { 'Content-Type': mime['.json'], 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(data))
      return
    }

    const pathname = decodeURIComponent((req.url || '/').split('?')[0])
    const safePath = normalize(pathname)
      .replace(/^[/\\]+/, '')
      .replace(/^(\.\.[/\\])+/, '')
    let filePath = join(dist, safePath === '/' ? 'index.html' : safePath)
    try {
      const info = await stat(filePath)
      if (info.isDirectory()) filePath = join(filePath, 'index.html')
    } catch {
      filePath = join(dist, 'index.html')
    }
    const body = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': mime[extname(filePath)] || 'application/octet-stream' })
    res.end(body)
  } catch (error) {
    res.writeHead(503, { 'Content-Type': mime['.json'] })
    res.end(JSON.stringify({ error: error.message }))
  }
})

let activePort = preferredPort

async function dashboardAlreadyRunning(port) {
  try {
    const response = await timedFetch(`http://localhost:${port}/`, {}, 2000)
    const html = await response.text()
    return response.ok && html.includes('盤前作戰室')
  } catch {
    return false
  }
}

server.on('listening', () => {
  console.log(`盤前作戰室已啟動：http://localhost:${activePort}`)
})

server.on('error', async (error) => {
  if (error.code !== 'EADDRINUSE') {
    console.error(`啟動失敗：${error.message}`)
    process.exitCode = 1
    return
  }

  if (await dashboardAlreadyRunning(activePort)) {
    console.log(`盤前作戰室已經在執行：http://localhost:${activePort}`)
    console.log('不需要重複啟動，直接用瀏覽器開啟上方網址即可。')
    process.exit(0)
  }

  if (!process.env.PORT && activePort < preferredPort + 10) {
    activePort += 1
    console.log(`連接埠 ${activePort - 1} 已被其他程式使用，改用 ${activePort}。`)
    server.listen(activePort)
    return
  }

  console.error(`連接埠 ${activePort} 已被其他程式使用。可用 PORT=其他數字 npm start 指定連接埠。`)
  process.exitCode = 1
})

server.listen(activePort)
