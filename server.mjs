import { createServer } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import fetch from 'node-fetch'

const preferredPort = Number(process.env.PORT || 8787)
const dist = join(process.cwd(), 'dist')
const cacheFile = join(process.cwd(), '.cache', 'market-data.json')
const sources = {
  twseQuotes: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  twseEligible: 'https://openapi.twse.com.tw/v1/exchangeReport/TWTB4U',
  tpexQuotes: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
  tpexEligible: 'https://www.tpex.org.tw/openapi/v1/tpex_securities',
}

let cache = null
let cachedAt = 0
const cacheMs = 5 * 60 * 1000

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

async function fetchJson(url) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await timedFetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 TW-Daytrade-Dashboard/1.0' },
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

async function marketData(force = false) {
  await restoreCache()
  if (!force && cache && Date.now() - cachedAt < cacheMs) return cache
  const results = await Promise.allSettled(Object.values(sources).map(fetchJson))
  const keys = Object.keys(sources)
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
