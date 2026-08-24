<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { buildAnalysis, marketState, rocDate } from './analysis'

const stocks = ref([])
const loading = ref(true)
const error = ref('')
const updatedAt = ref('')
const sourceDate = ref('')
const briefDate = ref('等待資料')
const sourceStatus = ref('官方資料連線')
const dataWarning = ref('')
const tab = ref('all')
const query = ref('')
const market = ref('全部市場')
const minValue = ref(1)
const minScore = ref(65)
const limitStorageKey = 'tw-daytrade-limit-wan-v2'
const savedLimit = Number(globalThis.localStorage?.getItem(limitStorageKey))
const tradingLimitWan = ref(savedLimit > 0 ? savedLimit : 65)
const quotaStorageKey = 'tw-daytrade-quota-only-v1'
const savedQuotaOnly = globalThis.localStorage?.getItem(quotaStorageKey)
const quotaOnly = ref(savedQuotaOnly === null ? true : savedQuotaOnly === 'true')
const expanded = ref('')
const liveQuotes = ref({})
const liveSession = ref('closed')
const liveExchangeTime = ref('')
const liveError = ref('')
let liveLoading = false
let liveTimer

const thresholds = { .3: 300_000_000, 1: 1_000_000_000, 3: 3_000_000_000 }
const pulse = computed(() => marketState(stocks.value))
const filtered = computed(() => stocks.value
  .filter(s => tab.value === 'all' || s.bestSide === tab.value)
  .filter(s => market.value === '全部市場' || s.market === market.value)
  .filter(s => s.value >= thresholds[minValue.value])
  .filter(s => s.score >= minScore.value)
  .filter(s => !quotaOnly.value || maxLots(s) > 0)
  .filter(s => `${s.code}${s.name}`.toLowerCase().includes(query.value.trim().toLowerCase()))
  .sort((a, b) => b.score - a.score || b.value - a.value))

const topPick = computed(() => filtered.value[0])
const formatValue = value => value >= 1e8 ? `${(value / 1e8).toFixed(value >= 1e9 ? 1 : 2)} 億` : `${(value / 1e6).toFixed(0)} 百萬`
const formatPct = value => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
const scoreLabel = score => score >= 80 ? '高條件' : score >= 72 ? '中高條件' : score >= 65 ? '中條件' : '觀察'
const referencePrice = stock => Number(stock.trigger || stock.close)
const lotCost = stock => referencePrice(stock) * 1000
const formatCapital = value => `${(value / 10000).toFixed(value >= 1000000 ? 0 : 1)} 萬`
const maxLots = stock => Math.max(0, Math.floor((Math.max(0, tradingLimitWan.value) * 10000 * .95) / lotCost(stock)))
const capacityText = stock => maxLots(stock) ? `${maxLots(stock)} 張` : '不足 1 張'
const liveQuote = stock => liveQuotes.value[`${stock.market}:${stock.code}`]
const formatPrice = value => Number(value).toLocaleString('zh-TW', { minimumFractionDigits: Number(value) < 100 ? 2 : 0, maximumFractionDigits: 2 })
const formatVolume = value => value ? Number(value).toLocaleString('zh-TW') : '—'
const liveChangePct = quote => quote?.price && quote?.reference ? (quote.price - quote.reference) / quote.reference * 100 : 0
const liveSessionLabel = computed(() => liveError.value || ({
  preopen: '盤前試撮（非成交）',
  trading: '盤中最新成交',
  closed: '非交易時段・最近行情',
}[liveSession.value] || '等待行情'))

watch(tradingLimitWan, value => {
  if (Number(value) > 0) localStorage.setItem(limitStorageKey, String(value))
})

watch(quotaOnly, value => localStorage.setItem(quotaStorageKey, String(value)))

async function load(force = false) {
  loading.value = true
  error.value = ''
  dataWarning.value = ''
  sourceStatus.value = '正在同步官方資料'
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`/api/market-data${force ? '?refresh=1' : ''}`)
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || '資料讀取失敗')
      stocks.value = buildAnalysis(payload)
      updatedAt.value = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(payload.fetchedAt))
      const latestDate = rows => rows?.reduce((latest, row) => {
        const date = String(row.Date || '').replaceAll('/', '')
        return date > latest ? date : latest
      }, '') || ''
      const twseRawDate = latestDate(payload.twseQuotes)
      const tpexRawDate = latestDate(payload.tpexQuotes)
      const twseDate = rocDate(twseRawDate)
      const tpexDate = rocDate(tpexRawDate)
      sourceDate.value = `上市 ${twseDate} · 上櫃 ${tpexDate}`
      briefDate.value = `TWSE ${twseDate.slice(5)} · TPEX ${tpexDate.slice(5)}`
      if (!stocks.value.length) throw new Error('官方資料已回應，但沒有符合基本流動性與當沖資格的標的')
      if (twseRawDate && tpexRawDate && twseRawDate !== tpexRawDate) {
        dataWarning.value = `官方來源日期不一致（上市 ${twseDate}／上櫃 ${tpexDate}），較舊市場已自動排除，不提供過期建議。`
      }
      if (payload.staleSources?.length) {
        dataWarning.value = `${dataWarning.value} 部分來源連線失敗，畫面可能使用最近成功快取。`.trim()
      }
      sourceStatus.value = dataWarning.value ? '資料日期防呆已啟用' : '官方資料連線'
      loading.value = false
      return
    } catch (e) {
      lastError = e
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 900))
    }
  }
  error.value = `${lastError?.message || '資料讀取失敗'}（已自動重試 3 次）`
  sourceStatus.value = '資料連線異常'
  loading.value = false
}

function isLiveWindow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date())
  const value = type => parts.find(part => part.type === type)?.value || ''
  const minutes = Number(value('hour')) * 60 + Number(value('minute'))
  return !['Sat', 'Sun'].includes(value('weekday')) && minutes >= 510 && minutes <= 810
}

async function loadRealtime(force = false) {
  if (liveLoading || (!force && !isLiveWindow())) return
  const candidates = filtered.value.slice(0, 40)
  if (!candidates.length) return
  liveLoading = true
  try {
    const channels = candidates.map(stock => `${stock.market === '上市' ? 'tse' : 'otc'}_${stock.code}.tw`)
    const response = await fetch(`/api/realtime?channels=${encodeURIComponent(channels.join(','))}`)
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || '盤前行情讀取失敗')
    liveQuotes.value = Object.fromEntries((payload.quotes || []).map(quote => [`${quote.market}:${quote.code}`, quote]))
    liveSession.value = payload.session || 'closed'
    liveExchangeTime.value = payload.exchangeTime || ''
    liveError.value = ''
  } catch (error) {
    liveError.value = `即時行情暫時無法取得：${error.message}`
  } finally {
    liveLoading = false
  }
}

function resetFilters() {
  tab.value = 'all'; query.value = ''; market.value = '全部市場'; minValue.value = 1; minScore.value = 65; quotaOnly.value = true
}

watch(filtered, () => loadRealtime(true), { flush: 'post' })

onMounted(() => {
  load()
  liveTimer = setInterval(() => loadRealtime(), 5000)
})

onBeforeUnmount(() => clearInterval(liveTimer))
</script>

<template>
  <main>
    <header class="site-header">
      <a class="brand" href="#top" aria-label="盤前作戰室首頁">
        <span class="brand-mark">前</span>
        <span><b>盤前作戰室</b><small>TAIWAN DAY TRADE DESK</small></span>
      </a>
      <div class="header-meta">
        <span class="live-dot"></span>
        <span>{{ sourceStatus }}</span>
        <button class="refresh" :disabled="loading" @click="load(true)">{{ loading ? '更新中…' : '重新整理' }}</button>
      </div>
    </header>

    <section id="top" class="hero">
      <div class="hero-copy">
        <div class="eyebrow">PRE-MARKET BRIEF · {{ briefDate }}</div>
        <h1>今天，只做<br><em>有條件</em>的交易。</h1>
        <p>依最新完成交易日的價量、振幅與收盤強弱，從官方可當沖標的中，整理今日必須等待價格確認的多空候選。</p>
      </div>
      <div class="hero-pick" v-if="topPick">
        <span class="pick-kicker">今日首選觀察</span>
        <div class="pick-heading"><strong>{{ topPick.code }}</strong><span>{{ topPick.name }}</span></div>
        <div class="pick-side" :class="topPick.bestSide">{{ topPick.bestSide === 'long' ? '偏多 · 突破買進' : '偏空 · 先賣現沖' }}</div>
        <dl>
          <div><dt>觸發價</dt><dd>{{ topPick.trigger }}</dd></div>
          <div><dt>防守價</dt><dd>{{ topPick.stop }}</dd></div>
          <div><dt>目標價</dt><dd>{{ topPick.target }}</dd></div>
        </dl>
        <small>觸價後才觀察進場；若開盤已跳過觸發價，不追價、不預掛成交</small>
      </div>
      <div class="hero-pick loading-card" v-else-if="loading"><span></span><span></span><span></span></div>
    </section>

    <section class="pulse-grid" aria-label="市場溫度">
      <article>
        <span>市場節奏</span><strong>{{ pulse.tone }}</strong><small>{{ pulse.note }}</small>
      </article>
      <article>
        <span>強勢家數比</span><strong>{{ pulse.breadth.toFixed(0) }}<i>%</i></strong><small>高流動性前 80 檔</small>
      </article>
      <article>
        <span>平均漲跌</span><strong :class="pulse.avgMove >= 0 ? 'up' : 'down'">{{ formatPct(pulse.avgMove) }}</strong><small>高流動性觀察池</small>
      </article>
      <article>
        <span>平均振幅</span><strong>{{ pulse.avgRange.toFixed(2) }}<i>%</i></strong><small>低於 1% 不利當沖</small>
      </article>
    </section>

    <section class="workspace">
      <aside class="filters">
        <div class="section-label">01 / 篩選條件</div>
        <label class="search"><span>⌕</span><input v-model="query" placeholder="輸入代號或名稱" /></label>
        <label>市場
          <select v-model="market"><option>全部市場</option><option>上市</option><option>上櫃</option></select>
        </label>
        <label>最低成交值
          <select v-model.number="minValue"><option :value=".3">3,000 萬</option><option :value="1">1 億</option><option :value="3">3 億</option></select>
        </label>
        <label>最低評分 <b>{{ minScore }}</b>
          <input v-model.number="minScore" type="range" min="55" max="85" step="1" />
        </label>
        <label>單日當沖額度 <b>萬元</b>
          <input v-model.number="tradingLimitWan" class="money-input" type="number" min="5" step="5" inputmode="decimal" />
          <small class="filter-help">試算時保留 5% 價格與費用緩衝</small>
        </label>
        <label class="quota-toggle">
          <input v-model="quotaOnly" type="checkbox" />
          <span>只看額度內可交易整張</span>
        </label>
        <button class="reset" @click="resetFilters">重設篩選</button>

        <div class="rule-card">
          <div class="section-label">開盤前 3 件事</div>
          <ol>
            <li><b>08:50</b><span>確認大盤期貨與預估開盤方向</span></li>
            <li><b>08:58</b><span>只記錄觸發價，不直接掛單等待成交</span></li>
            <li><b>09:05</b><span>確認突破／跌破與量能後才決定進場</span></li>
          </ol>
        </div>
      </aside>

      <div class="rankings">
        <div class="rankings-head">
          <div><div class="section-label">02 / 今日候選</div><h2>當沖雷達</h2></div>
          <div class="tabs" role="tablist">
            <button :class="{ active: tab === 'all' }" @click="tab = 'all'">全部</button>
            <button :class="{ active: tab === 'long' }" @click="tab = 'long'">偏多觀察</button>
            <button :class="{ active: tab === 'short' }" @click="tab = 'short'">偏空觀察</button>
          </div>
        </div>

        <div v-if="dataWarning" class="data-warning">{{ dataWarning }}</div>
        <div v-if="error" class="state error-state"><b>資料暫時無法取得</b><span>{{ error }}</span><button @click="load(true)">再試一次</button></div>
        <div v-else-if="loading" class="state"><span class="spinner"></span><b>正在整理上市櫃標的…</b><span>同步行情、當沖資格與先賣限制</span></div>
        <div v-else-if="!filtered.length" class="state"><b>沒有符合條件的標的</b><span>可降低最低評分或成交值再查看</span><button @click="resetFilters">清除條件</button></div>

        <div v-else class="table-wrap">
          <div class="table-meta"><span>共 {{ filtered.length }} 檔 · 額度 {{ tradingLimitWan || 0 }} 萬（以 95% 試算）</span><span class="live-status" :class="liveSession">{{ liveSessionLabel }}<template v-if="liveExchangeTime"> · {{ liveExchangeTime }}</template></span><span>基準日 {{ sourceDate }} · 抓取 {{ updatedAt }}</span></div>
          <table>
            <thead><tr><th>排名 / 標的</th><th>觀察方向</th><th>條件分</th><th>基準日收盤 / 漲跌</th><th>試撮 / 最新</th><th>觸發價單張 / 可做張數</th><th>成交值 / 振幅</th><th>次交易日條件</th><th></th></tr></thead>
            <tbody>
              <template v-for="(stock, index) in filtered.slice(0, 40)" :key="stock.market + stock.code">
                <tr :class="{ open: expanded === stock.code }" @click="expanded = expanded === stock.code ? '' : stock.code">
                  <td><span class="rank">{{ String(index + 1).padStart(2, '0') }}</span><div class="stock"><b>{{ stock.code }} {{ stock.name }}</b><small>{{ stock.market }} · {{ stock.canShort ? '可雙向當沖' : '僅先買後賣' }}</small></div></td>
                  <td><span class="side-pill" :class="stock.bestSide">{{ stock.bestSide === 'long' ? '偏多' : '偏空' }}</span></td>
                  <td><div class="score"><b>{{ stock.score }}</b><small>{{ scoreLabel(stock.score) }}</small></div></td>
                  <td><b>{{ stock.close.toFixed(2) }}</b><small :class="stock.changePct >= 0 ? 'up' : 'down'">{{ formatPct(stock.changePct) }}</small></td>
                  <td class="live-cell">
                    <template v-if="liveQuote(stock)?.price"><b>{{ formatPrice(liveQuote(stock).price) }}</b><small :class="liveChangePct(liveQuote(stock)) >= 0 ? 'up' : 'down'">{{ liveSession === 'preopen' ? '試撮・非成交' : liveSession === 'trading' ? '最新成交' : '最近行情' }} · {{ formatVolume(liveQuote(stock).volume) }} 張 · {{ liveQuote(stock).time }}</small></template>
                    <template v-else><b>—</b><small>等待行情</small></template>
                  </td>
                  <td class="quota-cell"><b>{{ formatCapital(lotCost(stock)) }} / 張</b><small :class="{ insufficient: !maxLots(stock) }">可做 {{ capacityText(stock) }}</small></td>
                  <td><b>{{ formatValue(stock.value) }}</b><small>振幅 {{ stock.rangePct.toFixed(2) }}%</small></td>
                  <td class="trigger-cell"><b>{{ stock.bestSide === 'long' ? '突破' : '跌破' }} {{ stock.trigger }}</b><small>基準 {{ rocDate(stock.date).slice(5) }} {{ stock.bestSide === 'long' ? '高' : '低' }} {{ stock.bestSide === 'long' ? stock.high : stock.low }}</small></td>
                  <td><button class="chevron" :aria-label="`查看 ${stock.name} 詳情`">⌄</button></td>
                </tr>
                <tr v-if="expanded === stock.code" class="detail-row">
                  <td colspan="9">
                    <div class="detail-grid">
                      <div><span>策略邏輯</span><strong>{{ stock.reasons.join(' · ') || '條件中性，等待確認' }}</strong></div>
                      <div><span>條件觸發</span><strong>{{ stock.trigger }}</strong></div>
                      <div><span>觀察回測價</span><strong>{{ stock.pullback }}</strong></div>
                      <div><span>停損防守</span><strong>{{ stock.stop }}</strong></div>
                      <div><span>第一目標</span><strong>{{ stock.target }}</strong></div>
                      <div><span>多 / 空分數</span><strong>{{ stock.longScore }} / {{ stock.shortScore }}</strong></div>
                      <div><span>參考單張金額</span><strong>{{ formatCapital(lotCost(stock)) }}</strong></div>
                      <div><span>額度可交易</span><strong>{{ capacityText(stock) }}</strong></div>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="method">
      <div><div class="section-label">03 / 評分方法</div><h2>不是明牌，<br>是一份紀律清單。</h2></div>
      <div class="method-copy">
        <p>評分綜合前一交易日的成交值、成交筆數、日內振幅、跳空幅度與收盤落點；只保留證交所／櫃買中心公告的當沖標的。多方偏好收近高點，空方偏好收近低點，過度跳空則扣分。</p>
        <div class="formula"><span>流動性 30</span><span>波動效率 25</span><span>方向結構 30</span><span>過熱風險 15</span></div>
      </div>
    </section>

    <footer>
      <div><b>資料來源</b><a href="https://openapi.twse.com.tw/" target="_blank">臺灣證券交易所 OpenAPI ↗</a><a href="https://www.tpex.org.tw/openapi/" target="_blank">證券櫃檯買賣中心 OpenAPI ↗</a><a href="https://mis.twse.com.tw/stock/index.jsp" target="_blank">盤前試撮與即時市況 ↗</a></div>
      <p>本工具使用最新完成交易日公開資料進行規則式篩選，盤前試撮與盤中最新行情來自交易所公開市況，可能延遲或短暫缺值，且不包含個人部位資訊；條件分代表型態完整度，不是上漲／下跌機率。試撮價不是成交價，畫面價格不可視為開盤前直接掛單價，也不構成投資建議或獲利保證。額度張數以觸發價與 95% 可用額度估算，不包含券商實際手續費、稅負與個別風控規則。先賣後買前請再次確認券商顯示的現沖資格；未完成反向買進可能產生強制買回與額外費用。</p>
    </footer>
  </main>
</template>
