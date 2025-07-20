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

global.botStateLoaded = false;

const BASE_TOKEN = 'BUSD';
const BASE_TOKEN_ADDRESS = tokenMap[BASE_TOKEN].toLowerCase();
const PROFIT_TARGET_PERCENT = 1.6;

//Bots internal state variables

let currentHolding = null;
let boughtPrice = null;
const tradedTokens = new Set();
let initialBUSDApprovalSet = false; // Flag for initial BUSD approval





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
async function getMinAmountOut(tokenIn, tokenOut, amountIn, slippagePercent = 5) {
  try {
    const pancakeRouterAddress = await contractInstance.pancakeSwapRouter();
    const router = new ethers.Contract(pancakeRouterAddress, PancakeSwapRouterABI, provider);
    const amountsOut = await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);

    const expectedOut = amountsOut[1];
    const slippage = expectedOut * BigInt(slippagePercent * 100) / 10000n; // 1%
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


async function loadBotState() {
  try {
    const data = await fs.readFile(STATE_FILE, 'utf8');
    const state = JSON.parse(data);

    currentHolding = state.currentHolding;
    boughtPrice = state.boughtPrice;
    tradedTokens = new Set(state.tradedTokens); // Convert array back to Set
    initialBUSDApprovalSet = state.initialBUSDApprovalSet; // Load the flag

    console.log('✅ Bot state loaded successfully.');
    if (currentHolding) {
        console.log(`Resuming with current holding: ${currentHolding} (bought at ${boughtPrice})`);
    }
    console.log(`Previously traded tokens: ${[...tradedTokens].join(', ')}`);

  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('ℹ️ No existing bot state file found. Starting fresh.');
    } else {
      console.error('❌ Error loading bot state:', error.message);
    }
  }
}

async function saveBotState() {
  try {
    const state = {
      currentHolding,
      boughtPrice,
      tradedTokens: [...tradedTokens], // Convert Set to Array for JSON serialization
      initialBUSDApprovalSet // Save the flag
    };
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    console.log('💾 Bot state saved.');
  } catch (error) {
    console.error('❌ Error saving bot state:', error.message);
  }
}

async function runTradingBot() {

  //Load State only once when bot starts
   if (!global.botStateLoaded) { 
    await loadBotState();
    global.botStateLoaded = true;
  }

  if (!initialBUSDApprovalSet) {
    try {
      const approvalTxSuccess = await sendTransaction(contractInstance.setAssets(BASE_TOKEN_ADDRESS), `Initial approval for ${BASE_TOKEN}`);
      if (approvalTxSuccess) {
        initialBUSDApprovalSet = true;
      }
    } catch (err) {
      if (err.message.includes('ERC20: approve amount exceeds allowance') || err.message.includes('already approved')) {
        console.log(`ℹ️ ${BASE_TOKEN} already approved, continuing...`);
        initialBUSDApprovalSet = true;
      } else {
        console.error(`❌ Critical: Failed initial approval for ${BASE_TOKEN}:`, err.message);
        // Consider stopping the bot if this is a critical error
        // throw err;
      }
    }
  }



  // try {
  //   // await sendTransaction(contractInstance.setAssets(BASE_TOKEN_ADDRESS), `Setting approval for ${BASE_TOKEN}`);
  // } catch (err) {
  //   // If it's just that it's already approved, it's fine.
  //   if (!err.message.includes('ERC20: approve amount exceeds allowance')) { // Example error message if already approved
  //       console.error(`❌ Initial approval for ${BASE_TOKEN} failed:`, err.message);
  //   } else {
  //       console.log(`ℹ️ ${BASE_TOKEN} already approved.`);
  //   }
  // }


  try {
    const signalRes = await axios.get(SIGNAL_ENDPOINT);
    const signals = signalRes.data;

    // Selling logic
    if (currentHolding) {
      const holdingTokenAddress = tokenMap[currentHolding].toLowerCase();
      const holdingBalance = await contractInstance.getTokenBalance(holdingTokenAddress);

      if (holdingBalance > 0n) {
        const currentPrice = await getTokenPrice(holdingTokenAddress, BASE_TOKEN_ADDRESS);
        if (currentPrice && boughtPrice) {
          const profitPercent = ((currentPrice - boughtPrice) / boughtPrice) * 100;
          if (profitPercent >= PROFIT_TARGET_PERCENT) {
            const minAmountOut = getMinAmountOut(holdingTokenAddress, BASE_TOKEN_ADDRESS, holdingBalance, 2); // use slippage logic if needed
            const deadline = Math.floor(Date.now() / 1000) + 60; // 60 seconds from now

            console.log(`Attempting to sell ${currentHolding}...`);
            const sellSuccess = await sendTransaction(
              contractInstance.sellASSET(
                holdingTokenAddress,
                holdingBalance,
                BASE_TOKEN_ADDRESS,
                minAmountOut,
                deadline
              ),
              `Selling ${currentHolding}`
            );

            if (sellSuccess) {
              console.log(`✅ Sold ${currentHolding} for profit: ${profitPercent.toFixed(2)}%`);
              tradedTokens.add(currentHolding);
              currentHolding = null;
              boughtPrice = null;
              await saveBotState(); //save state after success
            }
          } else {
            console.log(`⏳ ${currentHolding} not profitable yet: ${profitPercent.toFixed(2)}%`);
          }
        } else {
          console.log(`⚠️ Could not get current price for ${currentHolding}.`);
        }
      } else {
        console.log(`ℹ️ No ${currentHolding} balance to sell.`);
        currentHolding = null; // Clear holding if balance is zero
        boughtPrice = null;
        await saveBotState();
      }
    }

    // Buying logic (only if not currently holding)
    if (!currentHolding) {
      for (const signal of signals) {
        const tokenSymbol = signal.pairName.split('/')[0];
        const tokenAddress = signal.pairAddress;

        if (signal.signal !== 'Buy' || tradedTokens.has(tokenSymbol)) {
          continue;
        }

        console.log(`Received buy signal for ${tokenSymbol}.`);

        // Add token to local map if not known
        if (!tokenMap[tokenSymbol]) {
          tokenMap[tokenSymbol] = tokenAddress;
          console.log(`📝 Added ${tokenSymbol} to local tokenMap.`);
        }

        // 1. Add new asset to the smart contract's allowed list
        try {
          await sendTransaction(
            contractInstance.addNewAsset(tokenSymbol, tokenAddress),
            `Adding new asset: ${tokenSymbol}`
          );
        } catch (err) {
           console.error(`❌ Failed to add new asset ${tokenSymbol}:`, err.message);
           continue; // Skip to next signal if adding asset fails
        }


        // 2. Set approval for the new token
        try {
           await sendTransaction(
            contractInstance.setAssets(tokenAddress),
            `Setting approval for: ${tokenSymbol}`
          );
        } catch (err) {
            console.error(`❌ Failed to set approval for ${tokenSymbol}:`, err.message);
            continue; // Skip to next signal if setting approval fails
        }


        const tokenInAddress = BASE_TOKEN_ADDRESS;
        const tokenOutAddress = tokenAddress.toLowerCase();
        const depositBalance = await contractInstance.getDepositBalance(tokenInAddress);

        if (depositBalance > 0n) {
          const amountIn = depositBalance;
          const deadline = Math.floor(Date.now() / 1000) + 60; // 60 seconds from now
          // const minAmountOut = getMinAmountOut(tokenInAddress, tokenOutAddress, amountIn); // Add slippage calc if needed
          const minAmountOut =0;
          console.log(`Attempting to buy ${tokenSymbol} with ${formatUnits(amountIn, 18)} ${BASE_TOKEN}...`); // Assuming 18 decimals for BUSD

          const buySuccess = await sendTransaction(
            contractInstance.buyASSET(tokenInAddress, amountIn, tokenOutAddress, minAmountOut, deadline),
            `Buying ${tokenSymbol}`
          );

          if (buySuccess) {
            boughtPrice = await getTokenPrice(tokenOutAddress, BASE_TOKEN_ADDRESS);
            currentHolding = tokenSymbol;
            console.log(`✅ Bought ${tokenSymbol} at price ${boughtPrice}`);
            await saveBotState(); // save after bought
            break; // Exit loop after successful buy
          } else {
             console.log(`ℹ️ Buy attempt for ${tokenSymbol} failed. Adding to tradedTokens for this session.`);
            tradedTokens.add(tokenSymbol); // Mark as tried and failed for this session
            await saveBotState(); // 
          }
        } else {
          console.log(`Insufficient ${BASE_TOKEN} balance (${formatUnits(depositBalance, 18)}) to buy ${tokenSymbol}.`);
        }
      }
    }
  } catch (err) {
    console.error('❌ Error in runTradingBot():', err.message);
  }
}







// async function runTradingBot() {

//   await contractInstance.setAssets(BASE_TOKEN_ADDRESS); 
//   try {
//     const signalRes = await axios.get(SIGNAL_ENDPOINT);
//     // console.log(signalRes);
//     const signals = signalRes.data;

//     // Selling logic
//     if (currentHolding) {
//       const holdingTokenAddress = tokenMap[currentHolding].toLowerCase();
//       const holdingBalance = await contractInstance.getTokenBalance(holdingTokenAddress);
//       if (holdingBalance > 0n) {
//         const currentPrice = await getTokenPrice(holdingTokenAddress, BASE_TOKEN_ADDRESS);
//         if (currentPrice && boughtPrice) {
//           const profitPercent = ((currentPrice - boughtPrice) / boughtPrice) * 100;
//           if (profitPercent >= PROFIT_TARGET_PERCENT) {
//             const minAmountOut = 0; // use slippage logic if needed
//             const deadline = Math.floor(Date.now() / 1000) + 60;
//             const tx = await contractInstance
//               .connect(ownerSigner)
//               .sellASSET(
//                 holdingTokenAddress,
//                 holdingBalance,
//                 BASE_TOKEN_ADDRESS,
//                 minAmountOut,
//                 deadline
//               );
//             await tx.wait();
//             console.log(`✅ Sold ${currentHolding} for profit: ${profitPercent.toFixed(2)}%`);
//             tradedTokens.add(currentHolding);
//             currentHolding = null;
//             boughtPrice = null;
//           } else {
//             console.log(`⏳ ${currentHolding} not profitable yet: ${profitPercent.toFixed(2)}%`);
//           }
//         }
//       }
//     }

//     // Buying logic (only if not currently holding)
//     if (!currentHolding) {
//       for (const signal of signals) {
//         const tokenSymbol = signal.pairName.split('/')[0];
//         const tokenAddress = signal.pairAddress;

//         if (signal.signal !== 'Buy' || tradedTokens.has(tokenSymbol)) continue;


//         if (signal.signal === 'Buy' && !tradedTokens.has(tokenSymbol)) {

//           const isTokenKnown = tokenMap[tokenSymbol];
//           // if (!tokenMap[tokenSymbol]) {
//           //   console.log("adding token", tokenSymbol, tokenAddress);
//           //   tokenMap[tokenSymbol] = tokenAddress;
//           //   const addTx = await contractInstance.connect(ownerSigner).addNewAsset(tokenSymbol, tokenAddress);
//           //   await addTx.wait();
//           //   const approvalTx = await contractInstance.connect(ownerSigner).setAssets(tokenAddress);
//           //   await approvalTx.wait();
//           // }
//           if (!isTokenKnown) {
//             tokenMap[tokenSymbol] = tokenAddress; // Add to local map
//           }


//           try {
//           // Always try to add to smart contract allowed list (won’t fail on already added)
//           const addTx = await contractInstance.connect(ownerSigner).addNewAsset(tokenSymbol, tokenAddress);
//           await addTx.wait();
//           console.log(`✅ Token added to allowed list: ${tokenSymbol}`);
//            } catch (err) {
//               if (!err.message.includes('already allowed')) {
//                 console.error('❌ Failed to add token:', tokenSymbol, err.message);
//                 throw err;
//               } else {
//                 console.log(`ℹ️ Token already allowed: ${tokenSymbol}`);
//               }
//             }

//               // Ensure approval is set
//               try {
//                 const approvalTx = await contractInstance.connect(ownerSigner).setAssets(tokenAddress);
//                 await approvalTx.wait();
//                 console.log(`✅ Approval set for: ${tokenSymbol}`);
//               } catch (err) {
//                 console.error('❌ Failed to approve token:', tokenSymbol, err.message);
//                 continue;
//               }

//           const tokenInAddress = BASE_TOKEN_ADDRESS;
//           const tokenOutAddress = tokenAddress.toLowerCase() || tokenMap[tokenSymbol].toLowerCase();
//           const depositBalance = await contractInstance.getDepositBalance(tokenInAddress);

//           if (depositBalance > 0n) {
//             const amountIn = depositBalance;
//             const deadline = Math.floor(Date.now() / 1000) + 60;
//             const minAmountOut = 0; // Add slippage calc if needed

//             const tx = await contractInstance
//               .connect(ownerSigner)
//               .buyASSET(tokenInAddress, amountIn, tokenOutAddress, minAmountOut, deadline);
//             await tx.wait();

//             boughtPrice = await getTokenPrice(tokenOutAddress, BASE_TOKEN_ADDRESS);
//             currentHolding = tokenSymbol;

//             console.log(`✅ Bought ${tokenSymbol} at price ${boughtPrice}`);
//             break;
//           }
//         }
//       }
//     }
//   } catch (err) {
//     console.error('❌ Error in runTradingBot():', err.message);
//   }
// }

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

export default runTradingBot;






