const sources = {
  twseEligible: 'https://openapi.twse.com.tw/v1/exchangeReport/TWTB4U',
  tpexSnapshot: 'https://raw.githubusercontent.com/aassga/tw-daytrade/master/data/tpex.json',
}

let marketMemoryCache = null
let marketMemoryCachedAt = 0
const marketCacheMs = 5 * 60 * 1000
const realtimeMemoryCache = new Map()
const realtimeCacheMs = 4 * 1000
const marketCacheRequest = new Request('https://cache.internal/market-data')

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

async function timedFetch(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson(url, extraHeaders = {}) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await timedFetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 TW-Daytrade-Dashboard/1.0',
          ...extraHeaders,
        },
      })
      if (!response.ok) throw new Error('官方資料源回應 ' + response.status)
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
    timeZone: 'Asia/Taipei',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date())
  const value = type => parts.find(part => part.type === type)?.value || ''
  const minutes = Number(value('hour')) * 60 + Number(value('minute'))
  const weekday = value('weekday')
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed'
  if (minutes >= 510 && minutes < 540) return 'preopen'
  if (minutes >= 540 && minutes <= 810) return 'trading'
  return 'closed'
}

async function readEdgeCache(request) {
  try {
    const response = await caches.default.match(request)
    return response ? await response.json() : null
  } catch {
    return null
  }
}

function writeEdgeCache(request, payload, ctx, ttl = 86400) {
  const response = new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=' + ttl,
    },
  })
  ctx.waitUntil(caches.default.put(request, response))
}

async function realtimeData(channels, ctx) {
  const key = [...channels].sort().join('|')
  const saved = realtimeMemoryCache.get(key)
  if (saved && Date.now() - saved.fetchedAt < realtimeCacheMs) return saved.payload

  const edgeRequest = new Request('https://cache.internal/realtime?channels=' + encodeURIComponent(key))
  const edgePayload = await readEdgeCache(edgeRequest)
  if (edgePayload && Date.now() - Date.parse(edgePayload.fetchedAt) < realtimeCacheMs) {
    realtimeMemoryCache.set(key, { fetchedAt: Date.now(), payload: edgePayload })
    return edgePayload
  }

  const url = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=' + encodeURIComponent(key) + '&json=1&delay=0'
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
  realtimeMemoryCache.set(key, { fetchedAt: Date.now(), payload })
  if (realtimeMemoryCache.size > 20) realtimeMemoryCache.delete(realtimeMemoryCache.keys().next().value)
  writeEdgeCache(edgeRequest, payload, ctx, 60)
  return payload
}

function dateInTaipei(daysAgo = 0) {
  const date = new Date(Date.now() - daysAgo * 86400000)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const value = type => parts.find(part => part.type === type)?.value || ''
  return value('year') + value('month') + value('day')
}

function twseDailyRows(payload) {
  const table = payload?.tables?.find(item =>
    item.fields?.includes('證券代號') && item.fields?.includes('開盤價'))
  if (!table || !payload.date) return []
  const index = name => table.fields.indexOf(name)
  const plain = value => String(value ?? '').replace(/<[^>]*>/g, '').trim()
  const rocDate = String(Number(payload.date.slice(0, 4)) - 1911) + payload.date.slice(4)
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
      Change: direction.includes('-') ? '-' + difference : difference,
      Transaction: plain(row[index('成交筆數')]),
    }
  })
}

async function fetchLatestTwseQuotes() {
  let lastError
  for (let daysAgo = 0; daysAgo < 10; daysAgo += 1) {
    try {
      const date = dateInTaipei(daysAgo)
      const payload = await fetchJson('https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=' + date + '&type=ALLBUT0999&response=json')
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

async function marketData(force, ctx) {
  let previous = marketMemoryCache

  if (!previous) {
    previous = await readEdgeCache(marketCacheRequest)
    if (previous) {
      marketMemoryCache = previous
      marketMemoryCachedAt = Date.parse(previous.fetchedAt) || 0
    }
  }

  if (!force && previous && Date.now() - marketMemoryCachedAt < marketCacheMs) return previous

  const keys = ['twseQuotes', 'twseEligible', 'tpexQuotes', 'tpexEligible']
  const twseResults = await Promise.allSettled([
    fetchLatestTwseQuotes(),
    fetchJson(sources.twseEligible),
  ])
  const settle = async promise => {
    try {
      return { status: 'fulfilled', value: await promise }
    } catch (reason) {
      return { status: 'rejected', reason }
    }
  }
  // 櫃買中心會封鎖 Cloudflare 機房來源，改讀取每日由 GitHub Actions
  // 從櫃買官方 OpenAPI 更新的公開快照，並以日期參數避開 CDN 舊快取。
  const tpexSnapshotResult = await settle(fetchJson(
    sources.tpexSnapshot + '?date=' + dateInTaipei(),
  ))
  const tpexQuoteResult = tpexSnapshotResult.status === 'fulfilled'
    ? { status: 'fulfilled', value: tpexSnapshotResult.value.tpexQuotes || [] }
    : tpexSnapshotResult
  const tpexEligibleResult = tpexSnapshotResult.status === 'fulfilled'
    ? { status: 'fulfilled', value: tpexSnapshotResult.value.tpexEligible || [] }
    : tpexSnapshotResult
  const results = [...twseResults, tpexQuoteResult, tpexEligibleResult]
  const payload = { fetchedAt: new Date().toISOString(), warnings: [], staleSources: [] }

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      payload[keys[index]] = result.value
    } else {
      payload[keys[index]] = previous?.[keys[index]] || []
      if (payload[keys[index]].length) payload.staleSources.push(keys[index])
      payload.warnings.push(keys[index] + '：' + (result.reason?.message || '讀取失敗'))
    }
  })

  const liveQuoteCount = ['twseQuotes', 'tpexQuotes']
    .filter(key => results[keys.indexOf(key)]?.status === 'fulfilled').length

  if (!payload.twseQuotes.length && !payload.tpexQuotes.length) {
    throw new Error('目前無法連線至官方行情資料源')
  }

  if (!liveQuoteCount && previous) {
    return {
      ...previous,
      servedAt: new Date().toISOString(),
      staleSources: keys,
      warnings: payload.warnings,
    }
  }

  marketMemoryCache = payload
  marketMemoryCachedAt = Date.now()
  writeEdgeCache(marketCacheRequest, payload, ctx)
  return payload
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url)

      if (url.pathname === '/api/realtime') {
        const channels = [...new Set((url.searchParams.get('channels') || '').split(','))]
          .filter(channel => /^(tse|otc)_\d{4,6}\.tw$/.test(channel))
          .slice(0, 40)
        if (!channels.length) return jsonResponse({ error: '缺少有效的即時行情代號' }, 400)
        return jsonResponse(await realtimeData(channels, ctx))
      }

      if (url.pathname === '/api/market-data') {
        return jsonResponse(await marketData(url.searchParams.get('refresh') === '1', ctx))
      }

      if (url.pathname.startsWith('/api/')) {
        return jsonResponse({ error: '找不到 API' }, 404)
      }

      return env.ASSETS.fetch(request)
    } catch (error) {
      return jsonResponse({ error: error?.message || '服務暫時無法使用' }, 503)
    }
  },
}
