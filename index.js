import dotenv from "dotenv";
import runTradingBot from "./runTradingBot.js";
import cron from "node-cron";


dotenv.config();

const LOOP_INTERVAL_MS = 10000; // 10seconds


// Strategy Configuration
const TRADING_WINDOWS = [
    "0 1 * * *",    // 01:00 UTC
    "0 5 * * *",    // 05:00 UTC
    "0 9 * * *",    // 09:00 UTC
    "0 12 * * *",   // 13:00 UTC
    "0 17 * * *",   // 17:00 UTC
    "0 21 * * *"    // 21:00 UTC
];
const TRADING_DURATION_MINUTES = 1;
const HOLDING_DURATION_HOURS = 4;
const MIN_PROFIT_TO_HOLD = 0.3; // 0.3%

// Global trading state
const tradingState = {
    isActive: false,
    currentTrade: null,
    tradingWindowEnd: null,
    holdingPeriodEnd: null
};



function initTradingBot() {
    console.log('Initializing Automated Trading Bot with Scheduled Strategy');

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
        },{
            timezone: "UTC"
        });
    });


    //  // 🧪 Manual trigger at startup (for testing)
    // setTimeout(async () => {
    //     const now = new Date();
    //     tradingState.tradingWindowEnd = new Date(now.getTime() + TRADING_DURATION_MINUTES * 60000);
    //     tradingState.holdingPeriodEnd = new Date(now.getTime() + HOLDING_DURATION_HOURS * 3600000);
        
    //     tradingState.isActive = true;
    //     tradingState.currentTrade = null;

    //     console.log('\n🚀 MANUAL TRADING WINDOW TRIGGERED (Startup Test)');
    //     console.log(`⏳ Trading allowed until: ${tradingState.tradingWindowEnd.toUTCString()}`);
    //     console.log(`⏳ Holding until: ${tradingState.holdingPeriodEnd.toUTCString()}\n`);

    //     await executeTradingCycle();
    // }, 2000); // 2 second delay


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






// let isRunning = false;
// async function loopBot() {
//   if (isRunning) {
//     console.log('⏳ Still running... skipping this cycle');
//     return;
//   }

//   isRunning = true;
//   try {
//     console.log(`\n⏱️ Running Trading Bot @ ${new Date().toLocaleTimeString()}`);
//     await runTradingBot();
//   } catch (err) {
//     console.error("[FATAL ERROR] Trading bot loop failed:", err.message || err);
//   } finally {
//     isRunning = false;
//   }
// }
// // Start loop
// console.log('🚀 Automated Trading Bot Started');
// // Run immediately and then at intervals
// loopBot();
// setInterval(loopBot, LOOP_INTERVAL_MS);

