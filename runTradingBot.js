import axios from 'axios';
// import { ethers } from 'ethers';
import { ethers, parseUnits, formatUnits } from 'ethers';
// import { contractInstance, tokenMap, provider, ownerSigner } from './contractConfig.js'; // assumed setup
// import AutomatedTradingBotABI from "./contracts/AutomatedTradingBotABI.json";
// import PancakeSwapRouterABI from "./contracts/PancakeSwapRouterABI.json";
import AutomatedTradingBotABI from "./contracts/AutomatedTradingBotABI.json" assert { type: "json" };
import PancakeSwapRouterABI from "./contracts/PancakeswapRouterABI.json" assert { type: "json" };
import {tokenMap} from './config/tokenMap.js';
import dotenv from 'dotenv';
import fs from 'fs/promises';

dotenv.config();

// --- Configurable Constants ---
const SIGNAL_ENDPOINT = "https://bot.securearbitrage.com/api/signals";

const STATE_FILE = './botState.json'; //file to store bot state

const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL);
const ownerSigner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const contractInstance = new ethers.Contract(
  process.env.BOT_CONTRACT,
  AutomatedTradingBotABI,
  ownerSigner
);



const BASE_TOKEN = 'BUSD';
const BASE_TOKEN_ADDRESS = tokenMap[BASE_TOKEN].toLowerCase();
const PROFIT_TARGET_PERCENT = 1.6;
const STOP_LOSS_PERCENT = 0.9;

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

// async function sendTransaction(transactionPromise, transactionName) {
//   try {
//     const tx = await transactionPromise;
//     await tx.wait();
//     console.log(`✅ ${transactionName} successful! Transaction hash: ${tx.hash}`);
//     return true;
//   } catch (error) {
//     if (error.code === 'NONCE_EXPIRED' || error.message.includes('nonce too low')) {
//       console.warn(`⚠️ Nonce error for ${transactionName}. This might resolve on next attempt or a restart.`);
//       return false; // Treat nonce errors as non-success for this attempt
//     } else if (error.code === 'CALL_EXCEPTION') {
//       console.error(`❌ Failed to complete ${transactionName}: Contract execution reverted. Details: ${error.message}`);
//       return false; // Explicitly return false for contract reverts
//     } else if (error.message.includes('already allowed') || error.message.includes('Token already allowed') || error.message.includes('approve amount exceeds allowance')) {
//       console.log(`ℹ️ Token already allowed/approved: ${transactionName.split(':')[1]?.trim() || transactionName}`);
//       return false; // Indicate that it was already allowed/approved
//     } else {
//       console.error(`❌ Failed to complete ${transactionName}:`, error.message);
//       throw error; // Re-throw other unexpected errors
//     }
//   }
// }

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

// async function loadBotState() {
//   try {
//     const data = await fs.readFile(STATE_FILE, 'utf8');
//     const state = JSON.parse(data);

//     currentHolding = state.currentHolding;
//     boughtPrice = state.boughtPrice;
//     tradedTokens = new Set(state.tradedTokens); // Convert array back to Set
//     initialBUSDApprovalSet = state.initialBUSDApprovalSet; // Load the flag

//     console.log('✅ Bot state loaded successfully.');
//     if (currentHolding) {
//         console.log(`Resuming with current holding: ${currentHolding} (bought at ${boughtPrice})`);
//     }
//     console.log(`Previously traded tokens: ${[...tradedTokens].join(', ')}`);

//   } catch (error) {
//     if (error.code === 'ENOENT') {
//       console.log('ℹ️ No existing bot state file found. Starting fresh.');
//     } else {
//       console.error('❌ Error loading bot state:', error.message);
//     }
//   }
// }

async function loadBotState() {
  try {
    const data = await fs.readFile(STATE_FILE, 'utf8');
    const savedState = JSON.parse(data);
    state = {
      ...state,
      ...savedState,
      tradedTokens: new Set(savedState.tradedTokens || [])
    };
    console.log('✅ State loaded');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('ℹ️ No existing state file - starting fresh');
    } else {
      console.error('❌ Error loading state:', error.message);
    }
  }
}


// async function saveBotState() {
//   try {
//     const state = {
//       currentHolding,
//       boughtPrice,
//       tradedTokens: [...tradedTokens], // Convert Set to Array for JSON serialization
//       initialBUSDApprovalSet // Save the flag
//     };
//     await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
//     console.log('💾 Bot state saved.');
//   } catch (error) {
//     console.error('❌ Error saving bot state:', error.message);
//   }
// }


async function saveBotState() {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify({
      ...state,
      tradedTokens: [...state.tradedTokens]
    }, null, 2));
    console.log('💾 State saved');
  } catch (error) {
    console.error('❌ Error saving state:', error.message);
  }
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
      await saveBotState();
    }
  }
}


async function executeSell(tokenSymbol, tokenAddress, reason) {
  try {
    const holdingBalance = await contractInstance.getTokenBalance(tokenAddress);
    if (holdingBalance <= 0n) {
      console.log(`ℹ️ No ${tokenSymbol} balance to sell.`);
      state.currentHolding = null;
      state.boughtPrice = null;
      await saveBotState();
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
      await saveBotState();
    }
  } catch (err) {
    console.error(`❌ Failed to sell ${tokenSymbol}:`, err.message);
  }
}


let isRunning = false;
async function runTradingBot(forceExit = false) {
  if (isRunning) {
    console.log("⏳ Bot already running — skipping this cycle");
    return;
  }

  isRunning = true;
    //   if (!global.botStateLoaded) {
    //   await loadBotState();
    //   global.botStateLoaded = true;


    // // Initial BUSD approval
    //   if (!state.initialBUSDApprovalSet) {
    //     try {
    //       const approvalTxSuccess = await sendTransaction(
    //         contractInstance.setAssets(BASE_TOKEN_ADDRESS),
    //         `Initial approval for ${BASE_TOKEN}`
    //       );
    //       state.initialBUSDApprovalSet = approvalTxSuccess || initialBUSDApprovalSet;
    //     } catch (err) {
    //       if (err.message.includes('ERC20: approve amount exceeds allowance')) {
    //         console.log(`ℹ️ ${BASE_TOKEN} already approved`);
    //         state.initialBUSDApprovalSet = true;
    //       } else {
    //         console.error(`❌ Critical: Failed initial approval for ${BASE_TOKEN}:`, err.message);
    //       }
    //     }
    //   }
    // }

    // try {
    //   const signalRes = await axios.get(SIGNAL_ENDPOINT);
    //   const signals = signalRes.data;

    //   // Process signal updates for current holding
    //   await processNewSignals(signals);


    //   // Selling logic (including stop-loss)
    //   if (state.currentHolding) {
    //     const holdingTokenAddress = tokenMap[state.currentHolding].toLowerCase();
    //     const currentPrice = await getTokenPrice(holdingTokenAddress, BASE_TOKEN_ADDRESS);
    //     const { currentTP, currentSL } = state.tokenSettings[state.currentHolding] || {};


    //     //force exit if 4hours lapsed
    //     if(forceExit && state.currentHolding) {
    //       if(currentPrice && state.boughtPrice) {
    //         const profitPercent = ((currentPrice - state.boughtPrice) / state.boughtPrice) * 100;
    //         await executeSell(state.currentHolding, holdingTokenAddress, `forced-sold at ${profitPercent.toFixed(2)}%`)
    //       }
    //       return;
    //     }


    //     if (currentPrice && state.boughtPrice) {
    //       const profitPercent = ((currentPrice - state.boughtPrice) / state.boughtPrice) * 100;
          
    //       // Stop-loss check
    //       if (profitPercent <= -currentSL) {
    //         await executeSell(state.currentHolding, holdingTokenAddress, `stop-loss at ${profitPercent.toFixed(2)}%`);
    //         return;
    //       }
          
    //       // Take-profit check
    //       if (profitPercent >= currentTP) {
    //         await executeSell(state.currentHolding, holdingTokenAddress, `profit at ${profitPercent.toFixed(2)}%`);
    //         return;
    //       }
          
    //       console.log(`⏳ ${state.currentHolding}: ${profitPercent.toFixed(2)}% (TP: ${currentTP}% | SL: -${currentSL}%)`);
    //     }
    //   }

    //   // Buying logic
    //   if (!state.currentHolding) {
    //       //   const sortedSignals = signals
    //       // .filter(s => s.signal === 'Buy')
    //       // .map(signal => ({
    //       //   ...signal,
    //       //   score: calculateBuyScore(signal) // Implement scoring function
    //       // }))
    //       // .sort((a, b) => b.score - a.score);
    //       const prioritizedSignals = signals
    //       .filter(signal => shouldExecuteBuy(signal)) // Only valid signals
    //       .sort((a, b) => calculateBuyScore(b) - calculateBuyScore(a)); // Best first

    //     for (const signal of prioritizedSignals) {
    //       const tokenSymbol = signal.pairName.split('/')[0];
    //       const tokenAddress = signal.pairAddress;

    //       // if (signal.signal !== 'Buy' || tradedTokens.has(tokenSymbol)) continue;

    //       console.log(`Processing buy signal for ${tokenSymbol}...`);

    //       // Add token to local map if not known
    //       if (!tokenMap[tokenSymbol]) {
    //         tokenMap[tokenSymbol] = tokenAddress;
    //         console.log(`📝 Added ${tokenSymbol} to local tokenMap.`);
    //       }

    //       // Add to allowed tokens
    //       try {
    //         await sendTransaction(
    //           contractInstance.addNewAsset(tokenSymbol, tokenAddress),
    //           `Adding asset: ${tokenSymbol}`
    //         );
    //       } catch (err) {
    //         console.error(`❌ Failed to add ${tokenSymbol}:`, err.message);
    //         continue;
    //       }

    //       // Set approval
    //       try {
    //         await sendTransaction(
    //           contractInstance.setAssets(tokenAddress),
    //           `Approving: ${tokenSymbol}`
    //         );
    //       } catch (err) {
    //         console.error(`❌ Failed to approve ${tokenSymbol}:`, err.message);
    //         continue;
    //       }

    //       // Execute buy
    //       const depositBalance = await contractInstance.getDepositBalance(BASE_TOKEN_ADDRESS);
    //       if (depositBalance > 0n) {
    //         const deadline = Math.floor(Date.now() / 1000) + 300;
    //         const minAmountOut = await getMinAmountOut(BASE_TOKEN_ADDRESS, tokenAddress, depositBalance, 0.5);

    //         const buySuccess = await sendTransaction(
    //           contractInstance.buyASSET(
    //             BASE_TOKEN_ADDRESS,
    //             depositBalance,
    //             tokenAddress,
    //             minAmountOut,
    //             deadline
    //           ),
    //           `Buying ${tokenSymbol}`
    //         );

    //         if (buySuccess) {
    //           state.boughtPrice = await getTokenPrice(tokenAddress, BASE_TOKEN_ADDRESS);
    //           state.currentHolding = tokenSymbol;
    //           console.log(`✅ Bought ${tokenSymbol} at ${state.boughtPrice}`);
    //           await saveBotState();
    //           break;
    //         }
    //       } else {
    //         console.log(`ℹ️ Buy attempt for ${tokenSymbol} failed. Adding to tradedTokens for this session.`);
    //           tradedTokens.add(tokenSymbol); // Mark as tried and failed for this session
    //           await saveBotState();
    //       }
    //     }
    //   }
    // } catch (err) {
    //   console.error('❌ Error in runTradingBot():', err.message);
    // }


  try { 
        if (!global.botStateLoaded) {
      await loadBotState();
      global.botStateLoaded = true;


    // Initial BUSD approval
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
        const { currentTP, currentSL } = state.tokenSettings[state.currentHolding] || {};


        //force exit if 4hours lapsed
        if(forceExit && state.currentHolding) {
          if(currentPrice && state.boughtPrice) {
            const profitPercent = ((currentPrice - state.boughtPrice) / state.boughtPrice) * 100;
            await executeSell(state.currentHolding, holdingTokenAddress, `forced-sold at ${profitPercent.toFixed(2)}%`)
          }
          return;
        }


        if (currentPrice && state.boughtPrice) {
          const profitPercent = ((currentPrice - state.boughtPrice) / state.boughtPrice) * 100;
          
          // Stop-loss check
          if (profitPercent <= -currentSL) {
            await executeSell(state.currentHolding, holdingTokenAddress, `stop-loss at ${profitPercent.toFixed(2)}%`);
            return;
          }
          
          // Take-profit check
          if (profitPercent >= currentTP) {
            await executeSell(state.currentHolding, holdingTokenAddress, `profit at ${profitPercent.toFixed(2)}%`);
            return;
          }
          
          console.log(`⏳ ${state.currentHolding}: ${profitPercent.toFixed(2)}% (TP: ${currentTP}% | SL: -${currentSL}%)`);
        }
      }

      // Buying logic
      if (!state.currentHolding) {
          //   const sortedSignals = signals
          // .filter(s => s.signal === 'Buy')
          // .map(signal => ({
          //   ...signal,
          //   score: calculateBuyScore(signal) // Implement scoring function
          // }))
          // .sort((a, b) => b.score - a.score);
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
          const depositBalance = await contractInstance.getDepositBalance(BASE_TOKEN_ADDRESS);
          if (depositBalance > 0n) {
            const deadline = Math.floor(Date.now() / 1000) + 300;
            const minAmountOut = await getMinAmountOut(BASE_TOKEN_ADDRESS, tokenAddress, depositBalance, 0.5);

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
              state.boughtPrice = await getTokenPrice(tokenAddress, BASE_TOKEN_ADDRESS);
              state.currentHolding = tokenSymbol;
              console.log(`✅ Bought ${tokenSymbol} at ${state.boughtPrice}`);
              await saveBotState();
              break;
            }
          } else {
            console.log(`ℹ️ Buy attempt for ${tokenSymbol} failed. Adding to tradedTokens for this session.`);
              tradedTokens.add(tokenSymbol); // Mark as tried and failed for this session
              await saveBotState();
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
  // try {
  //   const path = [tokenA, tokenB];
  //   const amountIn = ethers.utils.parseUnits('1', 18);
  //   const amountsOut = await contractInstance.pancakeSwapRouter().getAmountsOut(amountIn, path);
  //   return parseFloat(ethers.utils.formatUnits(amountsOut[1], 18));
  // } catch (e) {
  //   console.warn(`⚠️ getTokenPrice fallback triggered for ${tokenA}/${tokenB}`);
  //   return null;
  // }
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