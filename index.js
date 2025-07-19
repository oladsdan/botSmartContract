// import dotenv from "dotenv";
// import runTradingBot from "./runTradingBot.js";


// dotenv.config();



// // Token mapping (symbol -> address)


// async function loopBot() {
//   while (true) {
//     try {
//       await runTradingBot();
//     } catch (err) {
//       console.error("[FATAL ERROR] Trading bot loop failed:", err);
//     }
//     await new Promise((res) => setTimeout(res, 10000)); // 5s delay
//   }
// }

loopBot();

import runTradingBot from './runTradingBot.js';
import dotenv from 'dotenv';

dotenv.config();

const LOOP_INTERVAL_MS = 10_000; // every 10 seconds

let isRunning = false;

async function loop() {
  if (isRunning) {
    console.log('⏳ Still running... skipping this cycle');
    return;
  }

  isRunning = true;
  try {
    console.log(`\n⏱️ Running Trading Bot @ ${new Date().toLocaleTimeString()}`);
    await runTradingBot();
  } catch (err) {
    console.error('❌ Error in bot loop:', err.message || err);
  } finally {
    isRunning = false;
  }
}

// Start loop
console.log('🚀 Automated Trading Bot Started');
loop(); // run immediately
setInterval(loop, LOOP_INTERVAL_MS);
