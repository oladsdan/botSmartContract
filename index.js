// index.js
import dotenv from "dotenv";
import cron from "node-cron";
import fs from "fs";
import runTradingBot from "./runTradingBot.js";

dotenv.config();

// === Config ===
const TRADING_DURATION_MINUTES = 1;
const HOLDING_DURATION_HOURS = 4;
const STATE_FILE = './botState.json';

const TRADING_WINDOWS = [
  "0 1 * * *",
  "0 5 * * *",
  "0 9 * * *",
  "0 13 * * *",
  "0 17 * * *",
  "0 21 * * *"
];

// === Global Trading State ===
export const tradingState = {
  isActive: false,
  currentTrade: null,
  tradingWindowEnd: null,
  holdingPeriodEnd: null
};

function loadTradeState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE));
      if (data.currentTrade) {
        tradingState.currentTrade = data.currentTrade;
        tradingState.holdingPeriodEnd = new Date(data.currentTrade.holdingPeriodEnd);
        console.log("🔁 Restored previous trade:", tradingState.currentTrade);
      }
    }
  } catch (err) {
    console.warn("⚠️ Failed to load previous state:", err.message);
  }
}

function saveTradeState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ currentTrade: tradingState.currentTrade }, null, 2));
}

// === Trading Loop ===
async function executeTradingCycle() {
  const now = new Date();

  if (tradingState.isActive && now > tradingState.tradingWindowEnd) {
    console.log("⏰ Trading window expired");
    tradingState.isActive = false;
  }

  if (tradingState.isActive || tradingState.currentTrade) {
    await runTradingBot(false, tradingState, saveTradeState);
  }
}

// === Init Bot ===
function initTradingBot() {
  console.log("🚀 Initializing Trading Bot");
  loadTradeState();

  TRADING_WINDOWS.forEach(schedule => {
    cron.schedule(schedule, async () => {
      const now = new Date();
      tradingState.tradingWindowEnd = new Date(now.getTime() + TRADING_DURATION_MINUTES * 60000);
      tradingState.holdingPeriodEnd = new Date(now.getTime() + HOLDING_DURATION_HOURS * 60 * 60 * 1000);
      tradingState.isActive = true;
      tradingState.currentTrade = null;

      console.log("\n=== TRADING WINDOW START ===");
      console.log(`🕒 Start: ${now.toUTCString()}`);
      console.log(`🛑 Ends: ${tradingState.tradingWindowEnd.toUTCString()}`);
      console.log(`📈 Holding until: ${tradingState.holdingPeriodEnd.toUTCString()}`);
      console.log("============================\n");

      await executeTradingCycle();
    }, { timezone: "UTC" });
  });

  // Manual trigger on startup
  setTimeout(async () => {
    const now = new Date();
    tradingState.tradingWindowEnd = new Date(now.getTime() + TRADING_DURATION_MINUTES * 60000);
    tradingState.holdingPeriodEnd = new Date(now.getTime() + HOLDING_DURATION_HOURS * 60 * 60 * 1000);
    tradingState.isActive = true;
    tradingState.currentTrade = null;

    console.log("\n🚀 MANUAL TRADING START");
    console.log(`🕒 Trading until: ${tradingState.tradingWindowEnd.toUTCString()}`);
    console.log(`📈 Holding until: ${tradingState.holdingPeriodEnd.toUTCString()}`);
    await executeTradingCycle();
  }, 2000);

  // Force exit if holding period expired
  setInterval(async () => {
    const now = new Date();
    if (tradingState.currentTrade && now >= new Date(tradingState.holdingPeriodEnd)) {
      console.log("⏰ Holding period expired – forcing exit");
      try {
        await runTradingBot(true, tradingState, saveTradeState);
        tradingState.currentTrade = null;
        saveTradeState();
      } catch (e) {
        console.error("❌ Force-exit failed:", e.message);
      }
    }
  }, 60000);

  // Run periodic trade checks (TP/SL)
  setInterval(async () => {
    if (tradingState.isActive || tradingState.currentTrade) {
      await executeTradingCycle();
    }
  }, 10000);
}

initTradingBot();
