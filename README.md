# 盤前作戰室｜台股當沖篩選台

Vue 3 + Vite 製作的上市櫃盤前當沖候選篩選工具。資料由臺灣證券交易所與證券櫃檯買賣中心官方 OpenAPI 即時抓取，並以流動性、波動效率、方向結構與跳空風險進行規則式評分。

正式伺服器支援 Node.js 16 以上版本；官方資料讀取包含自動重試與最近成功資料的磁碟快取。

## 啟動

```bash
npm install
npm run build
npm start
```

開啟 `http://localhost:8787`。開發模式需要同時啟動資料代理與 Vite：

若分析台已經在執行，再次執行 `npm start` 會直接顯示現有網址，不會拋出 `EADDRINUSE` 錯誤。若 8787 被其他程式使用，啟動器會自動改用下一個可用連接埠。

```bash
npm start
npm run dev
```

開發頁面為 `http://localhost:5173`。

## 資料與限制

- 上市行情：TWSE `STOCK_DAY_ALL`
- 上市當沖資格：TWSE `TWTB4U`
- 上櫃行情：TPEx `tpex_mainboard_daily_close_quotes`
- 上櫃當沖資格：TPEx `tpex_securities`
- 官方資料非盤前試撮或盤中逐筆即時行情；畫面中的價位是依前一交易日 OHLC 推算的觀察觸發與風險參考。
- 先賣現沖前仍應以券商下單畫面顯示的即時資格為準。
