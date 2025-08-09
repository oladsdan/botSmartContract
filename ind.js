// index.js
import dotenv from "dotenv";
import cron from "node-cron";
import fs from "fs/promises";
import runTradingBot from "./runTradingBot.js";

dotenv.config();

// === Config ===
const TRADING_DURATION_MINUTES = 5; // Extended slightly for multi-buy opportunities
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
// MODIFIED: State now holds an array of trades instead of a single object.
export const tradingState = {
  isActive: false,
  activeTrades: [], // Was currentTrade: null
  tradingWindowEnd: null,
  holdingPeriodEnd: null
};

async function loadTradeState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(await fs.readFile(STATE_FILE, 'utf-8'));
      // MODIFIED: Restore the array of trades
      if (data.activeTrades && data.activeTrades.length > 0) {
        tradingState.activeTrades = data.activeTrades;
        tradingState.holdingPeriodEnd = new Date(data.holdingPeriodEnd); // Use the saved end time
        console.log(`🔁 Restored ${data.activeTrades.length} previous trade(s).`);
      }
    }
  } catch (err) {
    console.warn("⚠️ Failed to load previous state:", err.message);
  }
}

async function saveTradeState() {
  // MODIFIED: Save the entire state object, including the activeTrades array
  await fs.writeFile(STATE_FILE, JSON.stringify(tradingState, null, 2));
}

// === Trading Loop ===
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

// === Recursive Check Functions ===
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
    setTimeout(periodicCheck, 15000); // Check every 15 seconds
  }
}


// === Init Bot ===
function initTradingBot() {
  console.log("🚀 Initializing Trading Bot");
  loadTradeState();

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

  // REMOVED: Manual trigger on startup to rely solely on cron schedule.
  console.log("🕒 Bot is waiting for the next scheduled trading window.");

  // Start the perpetual check loop
  periodicCheck();
}

initTradingBot();








import axios from 'axios';
// import { ethers } from 'ethers';
import { ethers, parseUnits, formatUnits, formatEther } from 'ethers';
import AutomatedTradingBotABI from "./contracts/AutomatedTradingBotABI.json" assert { type: "json" };
import PancakeSwapRouterABI from "./contracts/PancakeswapRouterABI.json" assert { type: "json" };
import {tokenMap} from './config/tokenMap.js';
import dotenv from 'dotenv';


dotenv.config();

// --- Configurable Constants ---
const SIGNAL_ENDPOINT = "https://bot.securearbitrage.com/api/signals";

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)"
];

const CONTRACT_ADDRESS = process.env.BOT_CONTRACT;

const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL);
const ownerSigner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);



const contractInstance = new ethers.Contract(
  CONTRACT_ADDRESS,
  AutomatedTradingBotABI,
  ownerSigner
);



const BASE_TOKEN = 'BUSD';
const BASE_TOKEN_ADDRESS = tokenMap[BASE_TOKEN].toLowerCase();
const busdTokenContract = new ethers.Contract(BASE_TOKEN_ADDRESS, ERC20_ABI, provider);

// NEW: Constants for multi-buy and trailing stop logic
const MAX_CONCURRENT_TRADES = 5;
const TRAILING_STOP_PERCENT = 0.6;
const MIN_USD_PER_TRADE = 1.0; // Minimum BUSD to allocate for a single trade


//Bots internal state variables

// let currentHolding = null;
// let boughtPrice = null;
const tradedTokens = new Set();
let initialBUSDApprovalSet = false; // Flag for initial BUSD approval
global.botStateLoaded = false;

let state = {
  currentHolding: null,
  boughtPrice: null,
  tradedTokens: [],
  tokenSettings: {}, // { TOKEN_SYMBOL: { currentTP, currentSL } }
  initialBUSDApprovalSet: false
};



// // function to get the current nonce
// async function getCurrentNonce() {
//   try {
//     const nonce = await provider.getTransactionCount(ownerSigner.address, "latest");
//     return nonce;
//   } catch (error) {
//     console.error("❌ Error fetching nonce:", error.message);
//     throw error;
//   }
// }
async function getMinAmountOut(tokenIn, tokenOut, amountIn, slippagePercent = 0.5) {
  try {
    const pancakeRouterAddress = await contractInstance.pancakeSwapRouter();
    const router = new ethers.Contract(pancakeRouterAddress, PancakeSwapRouterABI, provider);
    const amountsOut = await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);

    const expectedOut = amountsOut[1];
    const slippage = (expectedOut * BigInt(slippagePercent * 100)) / 10000n;
    const minOut = expectedOut - slippage;

    return minOut;
  } catch (e) {
    console.error("❌ Failed to get minAmountOut:", e.message);
    return 0n;
  }
}


async function sendTransaction(transactionPromise, transactionName) {
  try {
    const tx = await transactionPromise;
    await tx.wait();
    console.log(`✅ ${transactionName} successful! Transaction hash: ${tx.hash}`);
    return true;
  } catch (error) {
    if (error.code === 'NONCE_EXPIRED' || error.message.includes('nonce too low')) {
      console.warn(`⚠️ Nonce error for ${transactionName}. Retrying...`);
      // No need to throw here, the calling function can decide to retry or log
    } else if (error.message.includes('already allowed')) {
      console.log(`ℹ️ Token already allowed: ${transactionName.split(':')[1]?.trim()}`);
      return false; // Indicate that it was already allowed
    } else {
      console.error(`❌ Failed to complete ${transactionName}:`, error.message);
      throw error; // Re-throw other errors
    }
  }
  return false; // Default return for nonce errors or already allowed
}
function shouldExecuteBuy(signal) {
    const tokenSymbol = signal.pairName.split('/')[0];
    const baseConditions = (
        signal.signal === 'Buy' &&
        !tradedTokens.has(tokenSymbol) &&
        parseFloat(signal.currentLiquidity) > 250000 &&
        signal.direction === 'UP'
        // parseFloat(signal.now_diff_percent.replace('%','')) < 15.0
    );
    
    if (!baseConditions) return false;
    
    // Advanced scoring
    let score = 0;
    
    // 1. RSI scoring
    const rsi = parseFloat(signal.rsi);
    if (rsi > 30 && rsi < 60) score += 2;
    else if (rsi > 25 && rsi < 65) score += 1;
    
    // 2. Volume momentum
    if (parseFloat(signal.volumeIncrease) > 1.0) score += 2;
    else if (parseFloat(signal.volumeIncrease) > 0.5) score += 1;
    
    // 3. Prediction consensus
    const pred1 = parseFloat(signal.lstmPrediction);
    const pred2 = parseFloat(signal.xgboostPrediction);
    const current = parseFloat(signal.currentPrice);
    const avgPred = (pred1 + pred2) / 2;
    
    if (Math.abs(pred1 - pred2) < (avgPred * 0.03)) score += 2; // Strong consensus
    if (avgPred > current * 1.02) score += 1; // Predicting >2% increase
    
    // 4. MACD confirmation
    if (parseFloat(signal.macd) > parseFloat(signal.macdSignal)) score += 1;
    
    return score >= 2; // Minimum threshold score
}



async function processNewSignals(signals) {
  for (const signal of signals) {
    const tokenSymbol = signal.pairName.split('/')[0];
    
    // Only update TP/SL for currently held token
    if (state.currentHolding === tokenSymbol) {
      const newTP = parseFloat(signal.tpPercentage);
      let newSL = parseFloat(signal.slPercentage);
      
      // Update values
      state.tokenSettings[tokenSymbol] = state.tokenSettings[tokenSymbol] || {};
      state.tokenSettings[tokenSymbol].currentTP = newTP;
      state.tokenSettings[tokenSymbol].currentSL = newSL;
      
      console.log(`🔄 Updated ${tokenSymbol} TP/SL: ${newTP}%/${newSL}%`);
      // await saveBotState();
    }
  }
}


async function executeSell(tokenSymbol, tokenAddress, reason, tradingState, saveTradeState) {
  try {
    const holdingBalance = await contractInstance.getTokenBalance(tokenAddress);
    if (holdingBalance <= 0n) {
      console.log(`ℹ️ No ${tokenSymbol} balance to sell.`);
      state.currentHolding = null;
      state.boughtPrice = null;
      tradingState.currentTrade = null;
      saveTradeState();
      // await saveBotState();
      return;
    }

    const minAmountOut = await getMinAmountOut(tokenAddress, BASE_TOKEN_ADDRESS, holdingBalance, 0.5);
    const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minute deadline

    console.log(`Attempting to sell ${tokenSymbol} (${reason})...`);
    const sellSuccess = await sendTransaction(
      contractInstance.sellASSET(
        tokenAddress,
        holdingBalance,
        BASE_TOKEN_ADDRESS,
        minAmountOut,
        deadline
      ),
      `Selling ${tokenSymbol}`
    );

    if (sellSuccess) {
      console.log(`✅ Sold ${tokenSymbol} (${reason})`);
      tradedTokens.add(tokenSymbol);
      state.currentHolding = null;
      state.boughtPrice = null;
      tradingState.currentTrade = null;
      saveTradeState();
      // await saveBotState();
    }
  } catch (err) {
    console.error(`❌ Failed to sell ${tokenSymbol}:`, err.message);
  }
}


let isRunning = false;
async function runTradingBot(forceExit = false, tradingState = {}, saveTradeState = () => {}) {
    if (!state.currentHolding && tradingState.currentTrade?.token) {
        state.currentHolding = tradingState.currentTrade.token;
        state.boughtPrice = tradingState.currentTrade.entryPrice;
        state.tokenSettings[state.currentHolding] = {
        currentTP: tradingState.currentTrade.targetProfitPercent,
        currentSL: tradingState.currentTrade.stopLossPercent
        };
    }

  if (isRunning) {
    console.log("⏳ Bot already running — skipping this cycle");
    return;
  }

  isRunning = true;

  try { 
    //     if (!global.botStateLoaded) {
    //   await loadBotState();
    //   global.botStateLoaded = true;

    // // Initial BUSD approval
     
    // }

     if (!initialBUSDApprovalSet) {
        try {
          const approvalTxSuccess = await sendTransaction(
            contractInstance.setAssets(BASE_TOKEN_ADDRESS),
            `Initial approval for ${BASE_TOKEN}`
          );
          initialBUSDApprovalSet = approvalTxSuccess || initialBUSDApprovalSet;
        } catch (err) {
          if (err.message.includes('ERC20: approve amount exceeds allowance')) {
            console.log(`ℹ️ ${BASE_TOKEN} already approved`);
            state.initialBUSDApprovalSet = true;
          } else {
            console.error(`❌ Critical: Failed initial approval for ${BASE_TOKEN}:`, err.message);
          }
        }
      }

    try {
      const signalRes = await axios.get(SIGNAL_ENDPOINT);
      const signals = signalRes.data;

      // Process signal updates for current holding
      await processNewSignals(signals);


      // Selling logic (including stop-loss)
      if (state.currentHolding) {
        const holdingTokenAddress = tokenMap[state.currentHolding].toLowerCase();
        const currentPrice = await getTokenPrice(holdingTokenAddress, BASE_TOKEN_ADDRESS);
        console.log("this is currentPrice", currentPrice)
        const { currentTP, currentSL } = state.tokenSettings[state.currentHolding] || {};


        //force exit if 4hours lapsed
        if(forceExit && state.currentHolding) {
            const profitPercent = ((currentPrice - state.boughtPrice) / state.boughtPrice) * 100;
            await executeSell(state.currentHolding, holdingTokenAddress, `forced-sold after 4hrs at ${profitPercent.toFixed(2)}%`,     tradingState, saveTradeState)
          return;
        }

          // now we check if sl and Tp is reached
        if (currentPrice && state.boughtPrice) {
          const profitPercent = ((currentPrice - state.boughtPrice) / state.boughtPrice) * 100;
          
          // Stop-loss check
          if (profitPercent <= -currentSL) {
            await executeSell(state.currentHolding, holdingTokenAddress, `stop-loss at ${profitPercent.toFixed(2)}%`, tradingState, saveTradeState);
            return;
          }
          
          // Take-profit check
          if (profitPercent >= currentTP) {
            await executeSell(state.currentHolding, holdingTokenAddress, `profit at ${profitPercent.toFixed(2)}%`, tradingState, saveTradeState);
            return;
          }
          
          console.log(`⏳ ${state.currentHolding}: ${profitPercent.toFixed(2)}% (TP: ${currentTP.toFixed(2)}% | SL: -${currentSL.toFixed(2)}%)`);
        }
      }

      // Buying logic
      if (!state.currentHolding) {
          const prioritizedSignals = signals
          .filter(signal => shouldExecuteBuy(signal)) // Only valid signals
          .sort((a, b) => calculateBuyScore(b) - calculateBuyScore(a)); // Best first

          for (const signal of prioritizedSignals) {
            const tokenSymbol = signal.pairName.split('/')[0];
            const tokenAddress = signal.pairAddress;

            // if (signal.signal !== 'Buy' || tradedTokens.has(tokenSymbol)) continue;

            console.log(`Processing buy signal for ${tokenSymbol}...`);

            // Add token to local map if not known
            if (!tokenMap[tokenSymbol]) {
              tokenMap[tokenSymbol] = tokenAddress;
              console.log(`📝 Added ${tokenSymbol} to local tokenMap.`);
            }

            // Add to allowed tokens
            try {
              await sendTransaction(
                contractInstance.addNewAsset(tokenSymbol, tokenAddress),
                `Adding asset: ${tokenSymbol}`
              );
            } catch (err) {
              console.error(`❌ Failed to add ${tokenSymbol}:`, err.message);
              continue;
            }

            // Set approval
            try {
              await sendTransaction(
                contractInstance.setAssets(tokenAddress),
                `Approving: ${tokenSymbol}`
              );
            } catch (err) {
              console.error(`❌ Failed to approve ${tokenSymbol}:`, err.message);
              continue;
            }

            // Execute buy
            // const depositBalance = await contractInstance.getDepositBalance(BASE_TOKEN_ADDRESS);
            const depositBalance = await busdTokenContract.balanceOf(CONTRACT_ADDRESS);
            const formatDeposit = formatEther(depositBalance);


            console.log("this is the depositBalance", depositBalance.toString());

            console.log("this is the formateddeposit", formatDeposit);

            
            if (depositBalance > 0n) {
              const deadline = Math.floor(Date.now() / 1000) + 300;
              const minAmountOut = await getMinAmountOut(BASE_TOKEN_ADDRESS, tokenAddress, depositBalance, 0.5);

              console.log("this is the minAmountOut", minAmountOut);

              const buySuccess = await sendTransaction(
                contractInstance.buyASSET(
                  BASE_TOKEN_ADDRESS,
                  depositBalance,
                  tokenAddress,
                  minAmountOut,
                  deadline
                ),
                `Buying ${tokenSymbol}`
              );

              if (buySuccess) {
                const entryPrice = await getTokenPrice(tokenAddress, BASE_TOKEN_ADDRESS);
                state.boughtPrice = entryPrice;
                state.currentHolding = tokenSymbol;

                const tp = parseFloat(signal.tpPercentage);
                const sl = parseFloat(signal.slPercentage);

                state.tokenSettings[tokenSymbol] = { currentTP: tp, currentSL: sl };

                 tradingState.currentTrade = {
                 token: tokenSymbol,
                 entryPrice,
                 entryTime: new Date(),
                 holdingPeriodEnd: tradingState.holdingPeriodEnd,
                 stopLossPercent: sl,
                 targetProfitPercent: tp
                };

                console.log(`✅ Bought ${tokenSymbol} at ${entryPrice}`);
                // await saveBotState();
                saveTradeState();
                break;
              }
            } else {
              console.log(`ℹ️ Buy attempt for ${tokenSymbol} failed. Adding to tradedTokens for this session.`);
                tradedTokens.add(tokenSymbol); // Mark as tried and failed for this session
                // await saveBotState();
                // saveTradeState();
            }
          }
      }
    } catch (err) {
      console.error('❌ Error in runTradingBot():', err.message);
    }

    
  } catch (error) {
     console.error("[Bot Error]", err.message || err);
    
  }finally {
    isRunning = false;
  }

}

async function getTokenPrice(tokenA, tokenB) {

  try {
    const pancakeRouterAddress = await contractInstance.pancakeSwapRouter();
    const router = new ethers.Contract(pancakeRouterAddress, PancakeSwapRouterABI, provider);
    const path = [tokenA, tokenB];
    const amountIn = parseUnits('1', 18);
    const amountsOut = await router.getAmountsOut(amountIn, path);
    return parseFloat(formatUnits(amountsOut[1], 18));
  } catch (e) {
    console.warn(`⚠️ getTokenPrice fallback triggered for ${tokenA}/${tokenB}:`, e.message);
    return null;
  }


}


// Helper function
function calculateBuyScore(signal) {
  let score = 0;
  
  // RSI (30-60 is ideal)
  const rsi = parseFloat(signal.rsi);
  if (rsi > 30 && rsi < 60) score += 2;
  
  // Volume increasing 
  if (parseFloat(signal.volumeIncrease) > 1.0) score += 2;
  else if (parseFloat(signal.volumeIncrease) > 0.5) score += 1;
  
  // Prediction consensus
  const pred1 = parseFloat(signal.lstmPrediction);
  const pred2 = parseFloat(signal.xgboostPrediction);
  const current = parseFloat(signal.currentPrice);
  
  if (Math.abs(pred1 - pred2) < (current * 0.00001)) score += 2;
  if ((pred1 + pred2)/2 > current * 1.015) score += 1;
  
  // MACD bullish
  if (parseFloat(signal.macd) > parseFloat(signal.macdSignal)) score += 1;
  
  // Liquidity bonus
  if (parseFloat(signal.currentLiquidity) > 1000000) score += 1;
  
  return score;
}

export default runTradingBot;