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
const MIN_USD_PER_TRADE = 0.5; // Minimum BUSD to allocate for a single trade


//Bots internal state variables

// let currentHolding = null;
// let boughtPrice = null;
const tradedTokens = new Set();
let initialBUSDApprovalSet = false; // Flag for initial BUSD approval
global.botStateLoaded = false;

// let state = {
//   currentHolding: [],
//   boughtPrice: null,
//   tradedTokens: [],
//   tokenSettings: {}, // { TOKEN_SYMBOL: { currentTP, currentSL } }
//   initialBUSDApprovalSet: false
// };

// let currentHoldings = [];


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

    const AssetIn = tokenIn.toLowerCase();
    const AssetOut = tokenOut.toLowerCase();
    const pancakeRouterAddress = await contractInstance.pancakeSwapRouter();
    const router = new ethers.Contract(pancakeRouterAddress, PancakeSwapRouterABI, provider);
    const amountsOut = await router.getAmountsOut(amountIn, [AssetIn, AssetOut]);

    const expectedOut = amountsOut[1];
    const slippage = (expectedOut * BigInt(Math.round(slippagePercent * 100))) / 10000n;
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


async function processNewSignals(signals, holding) {
  for (const signal of signals) {
    const tokenSymbol = signal.pairName.split('/')[0];
        // Only update TP/SL for currently held token
    if (holding.token.toLowerCase() === tokenSymbol.toLowerCase()) {
      const newTP = parseFloat(signal.tpPercentage);
      let newSL = parseFloat(signal.slPercentage);
      
      // Update values
      holding.targetProfitPercent = newTP;
      holding.stopLossPercent = newSL;
      
      console.log(`🔄 Updated ${tokenSymbol} TP/SL: ${newTP}%/${newSL}%`);
      // await saveBotState();
    }
  }
}


// async function executeSell(tokenSymbol, tokenAddress, reason, tradingState, saveTradeState) {
//   try {
//     const holdingBalance = await contractInstance.getTokenBalance(tokenAddress);
//     if (holdingBalance <= 0n) {
//       console.log(`ℹ️ No ${tokenSymbol} balance to sell.`);
//       state.currentHolding = null;
//       state.boughtPrice = null;
//       tradingState.currentTrade = null;
//       saveTradeState();
//       // await saveBotState();
//       return;
//     }

//     const minAmountOut = await getMinAmountOut(tokenAddress, BASE_TOKEN_ADDRESS, holdingBalance, 0.5);
//     const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minute deadline

//     console.log(`Attempting to sell ${tokenSymbol} (${reason})...`);
//     const sellSuccess = await sendTransaction(
//       contractInstance.sellASSET(
//         tokenAddress,
//         holdingBalance,
//         BASE_TOKEN_ADDRESS,
//         minAmountOut,
//         deadline
//       ),
//       `Selling ${tokenSymbol}`
//     );

//     if (sellSuccess) {
//       console.log(`✅ Sold ${tokenSymbol} (${reason})`);
//       tradedTokens.add(tokenSymbol);
//       state.currentHolding = null;
//       state.boughtPrice = null;
//       tradingState.currentTrade = null;
//       saveTradeState();
//       // await saveBotState();
//     }
//   } catch (err) {
//     console.error(`❌ Failed to sell ${tokenSymbol}:`, err.message);
//   }
// }


async function executeSell(trade, reason, tradingState, saveTradeState) {
  const { token, address } = trade;
  try {
    const holdingBalance = await contractInstance.getTokenBalance(address);
    if (holdingBalance <= 0n) {
      console.log(`ℹ️ No ${token} balance to sell. Removing from active trades.`);
    } else {
        const minAmountOut = await getMinAmountOut(address, BASE_TOKEN_ADDRESS, holdingBalance, 1.0); // Use higher slippage for forced sells
        const deadline = Math.floor(Date.now() / 1000) + 300;
        const sellSuccess = await sendTransaction(
            contractInstance.sellASSET(address, holdingBalance, BASE_TOKEN_ADDRESS, minAmountOut, deadline),
            `Selling ${token}`
        );
        if (!sellSuccess) {
            console.error(`❌ Sell transaction failed for ${token}. Will retry.`);
            return; // Exit without removing from state, so it can be retried
        }
    }
    
    // MODIFIED: Remove the sold token from the activeTrades array
    tradingState.activeTrades = tradingState.activeTrades.filter(t => t.token !== token);
    
    console.log(`✅ Sold ${token} (${reason}). Remaining trades: ${tradingState.activeTrades.length}`);
    await saveTradeState();

  } catch (err) {
    console.error(`❌ Failed to execute sell for ${token}:`, err.message);
  }
}
let isRunning = false;
async function runTradingBot(options = {}, tradingState, saveTradeState = () => {}) {

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
            initialBUSDApprovalSet = true;
          } else {
            console.error(`❌ Critical: Failed initial approval for ${BASE_TOKEN}:`, err.message);
          }
        }
      }

    try {
      const signalRes = await axios.get(SIGNAL_ENDPOINT);
      const signals = signalRes.data;


      // --- NEW SELLING LOGIC ---
      if (tradingState.activeTrades.length > 0) {
        
        //Handle force sell -off all assets
        if(options.forceSellAll){
          //so we iterate over all holdings
          for (const holding of [...tradingState.activeTrades]) {
            await executeSell(holding, options.reason || 'Force Sell', tradingState, saveTradeState);
          }

          return;
        }

        // Regular TP/SL/TRAILING STOP check
        for (const holding of [...tradingState.activeTrades]) {

          await processNewSignals(signals, holding);

          const currentPrice = await getTokenPrice(holding.address, BASE_TOKEN_ADDRESS);
          if (!currentPrice) continue;

          const boughtPrice = parseFloat(holding.entryPrice);
          const profitPercent = ((currentPrice - boughtPrice) / boughtPrice) * 100;

          // --- Trailling Stop Logic ---
          holding.highestPrice = Math.max(holding.highestPrice || boughtPrice, currentPrice);
          const trailingStopPrice =  holding.highestPrice * (1 - (TRAILING_STOP_PERCENT / 100));

        
           console.log(`[${holding.token}] P/L: ${profitPercent.toFixed(2)}% | Price: ${currentPrice.toFixed(4)} | TP: ${holding.targetProfitPercent}% | Trail Stop: ${trailingStopPrice.toFixed(4)}`);
        
          //Check all sell conditions in order of priority

           if (profitPercent >= holding.targetProfitPercent) {
          await executeSell(holding, `Take-profit at ${profitPercent.toFixed(2)}%`, tradingState, saveTradeState);
          } else if (profitPercent <= -holding.stopLossPercent) {
          await executeSell(holding, `Stop-loss at ${profitPercent.toFixed(2)}%`, tradingState, saveTradeState);
          } else if (currentPrice < trailingStopPrice) {
          await executeSell(holding, `Trailing stop at ${profitPercent.toFixed(2)}%`, tradingState, saveTradeState);
          }

        }


      }

      // ---BUYING LOGIC
        const canBuyMore = tradingState.isActive && tradingState.activeTrades.length < MAX_CONCURRENT_TRADES;
        if (canBuyMore) {
          const alreadyHeldTokens = new Set(tradingState.activeTrades.map(t => t.token));

          const prioritizedSignals = signals 
        .filter(signal => shouldExecuteBuy(signal) && !alreadyHeldTokens.has(signal.pairName.split('/')[0]))
        .sort((a, b) => calculateBuyScore(b) - calculateBuyScore(a));

           
        // const slotsToFill = MAX_CONCURRENT_TRADES - tradingState.activeTrades.length;
        const depositBalance = await busdTokenContract.balanceOf(CONTRACT_ADDRESS);
        const depositBalanceFloat = parseFloat(formatUnits(depositBalance, 18));

        if (depositBalanceFloat > MIN_USD_PER_TRADE){

         const slotsToFill = MAX_CONCURRENT_TRADES - tradingState.activeTrades.length;

         if (slotsToFill <= 0) {
           console.log("ℹ️ Maximum concurrent trades reached. Skipping buy phase.");
          return;
          }

          // 2. Secondary validation (defensive programming)
          if (slotsToFill > MAX_CONCURRENT_TRADES) {
            console.warn("⚠️ Abnormal slotsToFill value:", slotsToFill);
            return;
          }

          const amountPerBuy = depositBalance / BigInt(slotsToFill);
          const amountPerBuyFloat = parseFloat(formatUnits(amountPerBuy, 18));

           if (amountPerBuyFloat < MIN_USD_PER_TRADE) {
            console.log(`ℹ️ Balance too low to split for more trades. Required ~$${MIN_USD_PER_TRADE * slotsToFill}.`);
            return;
            }

          for (const signal of prioritizedSignals.slice(0, slotsToFill)) {
            const tokenSymbol = signal.pairName.split('/')[0];
            const tokenAddress = signal.pairAddress;

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

              const deadline = Math.floor(Date.now() / 1000) + 300;
              const minAmountOut = await getMinAmountOut(BASE_TOKEN_ADDRESS, tokenAddress, amountPerBuy, 0.5);

              console.log("this is the minAmountOut in wei", minAmountOut);

              const buySuccess = await sendTransaction(
                contractInstance.buyASSET(
                  BASE_TOKEN_ADDRESS,
                  amountPerBuy,
                  tokenAddress,
                  minAmountOut,
                  deadline
                ),
                `Buying ${tokenSymbol}`
              );

              if (buySuccess) {
                const entryPrice = await getTokenPrice(tokenAddress, BASE_TOKEN_ADDRESS);
                if (entryPrice) {
                    // MODIFIED: Add a new trade object to the activeTrades array
                    tradingState.activeTrades.push({
                        token: tokenSymbol,
                        address: tokenAddress,
                        entryPrice: entryPrice,
                        highestPrice: entryPrice, // Initialize highest price for trailing stop
                        entryTime: new Date().toISOString(),
                        stopLossPercent: parseFloat(signal.slPercentage),
                        targetProfitPercent: parseFloat(signal.tpPercentage)
                    });
                    console.log(`✅ Bought ${tokenSymbol} at ${entryPrice}. Active trades: ${tradingState.activeTrades.length}`);
                    await saveTradeState();
                }
            }

          }


        }


      }
    } catch (err) {
      console.error('❌ Error in runTradingBot():', err.message);
    }

    
  } catch (error) {
     console.error("[Bot Error]", error.message || error);
    
  }finally {
    isRunning = false;
  }

}

async function getTokenPrice(tokenA, tokenB) {

  try {
    const pancakeRouterAddress = await contractInstance.pancakeSwapRouter();
    const router = new ethers.Contract(pancakeRouterAddress, PancakeSwapRouterABI, provider);
    const path = [tokenA.toLowerCase(), tokenB.toLowerCase()];
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