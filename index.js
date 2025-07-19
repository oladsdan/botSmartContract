import dotenv from "dotenv";
import runTradingBot from "./runTradingBot.js";


dotenv.config();



// Token mapping (symbol -> address)


async function loopBot() {
  while (true) {
    try {
      await runTradingBot();
    } catch (err) {
      console.error("[FATAL ERROR] Trading bot loop failed:", err);
    }
    await new Promise((res) => setTimeout(res, 5000)); // 30s delay
  }
}

loopBot();
