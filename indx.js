import dotenv from "dotenv";
import cron from "node-cron";
import runTradingBot from "./runTradingBot.js";

dotenv.config();

// Strategy Configuration
const TRADING_WINDOWS = [
    "0 1 * * *",    // 01:00 UTC
    "0 5 * * *",    // 05:00 UTC
    "0 9 * * *",    // 09:00 UTC
    "0 13 * * *",   // 13:00 UTC
    "0 17 * * *",   // 17:00 UTC
    "0 21 * * *"    // 21:00 UTC
];
const TRADING_DURATION_MINUTES = 15;
const HOLDING_DURATION_HOURS = 4;
const MIN_PROFIT_TO_HOLD = 0.3; // 0.3%

// Global trading state
const tradingState = {
    isActive: false,
    currentTrade: null,
    tradingWindowEnd: null,
    holdingPeriodEnd: null
};

// Initialize the trading bot with strategy
function initTradingBot() {
    console.log('🚀 Initializing Automated Trading Bot with Scheduled Strategy');

    // Setup trading windows
    TRADING_WINDOWS.forEach(schedule => {
        cron.schedule(schedule, async () => {
            const now = new Date();
            tradingState.tradingWindowEnd = new Date(now.getTime() + TRADING_DURATION_MINUTES * 60000);
            tradingState.holdingPeriodEnd = new Date(now.getTime() + HOLDING_DURATION_HOURS * 3600000);
            
            tradingState.isActive = true;
            tradingState.currentTrade = null;
            
            console.log('\n====================================');
            console.log(`🚀 ACTIVATING TRADING WINDOW (${now.toUTCString()})`);
            console.log(`⏳ Trading allowed until: ${tradingState.tradingWindowEnd.toUTCString()}`);
            console.log(`⏳ Holding until: ${tradingState.holdingPeriodEnd.toUTCString()}`);
            console.log('====================================\n');
            
            // Start immediate execution
            await executeTradingCycle();
        });
    });

    // Setup periodic checks for force exits
    setInterval(async () => {
        if (!tradingState.currentTrade) return;

        const now = new Date();
        
        // Check holding period expiration
        if (now >= tradingState.holdingPeriodEnd) {
            console.log('⏰ 4-hour holding period expired - force exiting position');
            
            try {
                await runTradingBot(true); // Pass forceExit flag
            } catch (err) {
                console.error('❌ Error during force exit:', err.message);
            }
        }
    }, 60000); // Check every minute

    // Run trading cycles periodically during active windows
    setInterval(async () => {
        if (tradingState.isActive) {
            await executeTradingCycle();
        }
    }, 10000); // Check every 10 seconds
}

// Execute trading cycle with strategy constraints
async function executeTradingCycle() {
    if (!tradingState.isActive) {
        console.log('⏳ Trading window not active - skipping execution');
        return;
    }

    // Check if we're still within the 15-minute trading window
    if (new Date() > tradingState.tradingWindowEnd) {
        console.log('⏰ Trading window expired (15 minutes elapsed)');
        tradingState.isActive = false;
        return;
    }

    try {
        console.log(`\n⏱️ Executing trading strategy @ ${new Date().toLocaleTimeString()}`);
        await runTradingBot();
    } catch (err) {
        console.error("[STRATEGY ERROR] Trading cycle failed:", err.message || err);
    }
}

// Start the bot
initTradingBot();