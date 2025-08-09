// index.js
import dotenv from "dotenv";
import cron from "node-cron";
import fs from "fs";
import runTradingBot from "./runTradingBot.js";


dotenv.config();

// === Config ===
const TRADING_DURATION_MINUTES = 5;
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
  activeTrades: [],
  tradingWindowEnd: null,
  holdingPeriodEnd: null
};



async function loadTradeState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(await fs.readFile(STATE_FILE, 'utf-8'));
      if (data.activeTrades && data.activeTrades.length > 0) {
        tradingState.activeTrades = data.activeTrades;
        tradingState.holdingPeriodEnd = new Date(data.holdingPeriodEnd);
        console.log(`🔁 Restored ${data.activeTrades.length} previous trade(s).`);
      }
    }
  } catch (err) {
    console.warn("⚠️ Failed to load previous state:", err.message);
  }
}


// function saveTradeState() {
//   fs.writeFileSync(STATE_FILE, JSON.stringify({ currentTrade: tradingState.currentTrade }, null, 2));
// }

// === Trading Loop ===
async function saveTradeState() {
  await fs.writeFile(STATE_FILE, JSON.stringify(tradingState, null, 2));
}

// async function executeTradingCycle() {
//   const now = new Date();

//   if (tradingState.isActive && now > tradingState.tradingWindowEnd) {
//     console.log("⏰ Trading window expired");
//     tradingState.isActive = false;
//   }

//   if (tradingState.isActive || tradingState.currentTrade) {
//     await runTradingBot(false, tradingState, saveTradeState);
//   }
// }

async function executeTradingCycle(options = {}) {
  const now = new Date();

  if (tradingState.isActive && now > tradingState.tradingWindowEnd) {
    console.log("⏰ Trading window expired. No more new buys.");
    tradingState.isActive = false;
    await saveTradeState(); // Save the state change
  }

  // Pass options to the trading bot (e.g., for force selling)
  if (tradingState.isActive || tradingState.activeTrades.length > 0) {
    await runTradingBot(options, tradingState, saveTradeState);
  }
}

async function periodicCheck() {
  try {
    const now = new Date();
    
    // NEW: Logic to sell all tokens 5 mins before the holding period ends.
    if (tradingState.activeTrades.length > 0 && tradingState.holdingPeriodEnd) {
        const fiveMinutes = 5 * 60 * 1000;
        const sellOffTime = new Date(new Date(tradingState.holdingPeriodEnd).getTime() - fiveMinutes);

        if (now >= sellOffTime) {
            console.log("⏰ Nearing end of holding period. Forcing sell-off of all assets.");
            await executeTradingCycle({ forceSellAll: true, reason: 'Holding Period Nearing End' });
            return; // Exit check early after triggering sell-off
        }
    }
    
    // Regular TP/SL/Trailing Stop check
    await executeTradingCycle();

  } catch (e) {
    console.error("❌ Error in periodic check:", e.message);
  } finally {
    setTimeout(periodicCheck, 5000); // Check every 5 seconds
  }
}



async function initTradingBot() {
  console.log("🚀 Initializing Trading Bot");
  await loadTradeState();

  TRADING_WINDOWS.forEach(schedule => {
    cron.schedule(schedule, async () => {
      const now = new Date();
      // MODIFIED: Reset the activeTrades array for the new window.
      tradingState.activeTrades = [];
      tradingState.tradingWindowEnd = new Date(now.getTime() + TRADING_DURATION_MINUTES * 60000);
      tradingState.holdingPeriodEnd = new Date(now.getTime() + HOLDING_DURATION_HOURS * 60 * 60 * 1000);
      tradingState.isActive = true;

      console.log("\n=== TRADING WINDOW START ===");
      console.log(`🕒 Start: ${now.toUTCString()}`);
      console.log(`🛑 New buys end: ${tradingState.tradingWindowEnd.toUTCString()}`);
      console.log(`📈 Holding until: ${tradingState.holdingPeriodEnd.toUTCString()}`);
      console.log("============================\n");
      
      await saveTradeState();
      await executeTradingCycle();
    }, { timezone: "UTC" });
  });


  console.log("🕒 Bot is waiting for the next scheduled trading window.");

  // Start the perpetual check loop
  periodicCheck();
}

initTradingBot();
