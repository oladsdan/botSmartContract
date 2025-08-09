import axios from 'axios';
import { ethers, parseUnits, formatUnits } from 'ethers';
import AutomatedTradingBotABI from "./contracts/AutomatedTradingBotABI.json" assert { type: "json" };
import PancakeSwapRouterABI from "./contracts/PancakeswapRouterABI.json" assert { type: "json" };
import { tokenMap } from './config/tokenMap.js';
import dotenv from 'dotenv';

dotenv.config();

// --- Configurable Constants ---
const SIGNAL_ENDPOINT = "https://bot.securearbitrage.com/api/signals";
const CONTRACT_ADDRESS = process.env.BOT_CONTRACT;
const BASE_TOKEN = 'BUSD';
const BASE_TOKEN_ADDRESS = tokenMap[BASE_TOKEN].toLowerCase();
const ERC20_ABI = ["function balanceOf(address account) view returns (uint256)"];

// NEW: Constants for multi-buy and trailing stop logic
const MAX_CONCURRENT_TRADES = 5;
const TRAILING_STOP_PERCENT = 0.6;
const MIN_USD_PER_TRADE = 1.0; // Minimum BUSD to allocate for a single trade

const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL);
const ownerSigner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const contractInstance = new ethers.Contract(CONTRACT_ADDRESS, AutomatedTradingBotABI, ownerSigner);
const busdTokenContract = new ethers.Contract(BASE_TOKEN_ADDRESS, ERC20_ABI, provider);

let isRunning = false;
let initialBUSDApprovalSet = false;

// (Helper functions like getMinAmountOut, sendTransaction, shouldExecuteBuy, calculateBuyScore remain largely the same)
// ...

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


// MODIFIED: Main function now handles an array of trades
async function runTradingBot(options = {}, tradingState, saveTradeState) {
  if (isRunning) return;
  isRunning = true;

  try {
    // --- SELLING LOGIC ---
    if (tradingState.activeTrades.length > 0) {
      
      // NEW: Handle force sell-off of all assets
      if (options.forceSellAll) {
        // Create a copy of the array to iterate over, as executeSell modifies the original
        const tradesToSell = [...tradingState.activeTrades];
        for (const trade of tradesToSell) {
          await executeSell(trade, options.reason || 'Force Sell', tradingState, saveTradeState);
        }
        return; // Exit after handling the force sell
      }

      // Regular TP/SL/Trailing Stop check for each active trade
      for (const trade of [...tradingState.activeTrades]) {
        const currentPrice = await getTokenPrice(trade.address, BASE_TOKEN_ADDRESS);
        if (!currentPrice) continue;

        const entryPrice = parseFloat(trade.entryPrice);
        const profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
        
        // --- Trailing Stop Logic ---
        // NEW: Update highest price and calculate trailing stop price
        trade.highestPrice = Math.max(trade.highestPrice || entryPrice, currentPrice);
        const trailingStopPrice = trade.highestPrice * (1 - (TRAILING_STOP_PERCENT / 100));

        console.log(`[${trade.token}] P/L: ${profitPercent.toFixed(2)}% | Price: ${currentPrice.toFixed(4)} | TP: ${trade.targetProfitPercent}% | Trail Stop: ${trailingStopPrice.toFixed(4)}`);
        
        // Check sell conditions in order of priority
        if (profitPercent >= trade.targetProfitPercent) {
          await executeSell(trade, `Take-profit at ${profitPercent.toFixed(2)}%`, tradingState, saveTradeState);
        } else if (profitPercent <= -trade.stopLossPercent) {
          await executeSell(trade, `Stop-loss at ${profitPercent.toFixed(2)}%`, tradingState, saveTradeState);
        } else if (currentPrice < trailingStopPrice) {
          await executeSell(trade, `Trailing stop at ${profitPercent.toFixed(2)}%`, tradingState, saveTradeState);
        }
      }
    }

    // --- BUYING LOGIC ---
    // MODIFIED: Buy if the window is active AND we have capacity for more trades.
    const canBuyMore = tradingState.isActive && tradingState.activeTrades.length < MAX_CONCURRENT_TRADES;
    if (canBuyMore) {
      const alreadyHeldTokens = new Set(tradingState.activeTrades.map(t => t.token));
      const prioritizedSignals = signals // (Assuming signals are fetched)
        .filter(signal => shouldExecuteBuy(signal) && !alreadyHeldTokens.has(signal.pairName.split('/')[0]))
        .sort((a, b) => calculateBuyScore(b) - calculateBuyScore(a));
        
      const slotsToFill = MAX_CONCURRENT_TRADES - tradingState.activeTrades.length;
      const depositBalance = await busdTokenContract.balanceOf(CONTRACT_ADDRESS);
      const depositBalanceFloat = parseFloat(formatUnits(depositBalance, 18));
      
      if (depositBalanceFloat > MIN_USD_PER_TRADE) {
        // Allocate balance equally for available slots
        const amountPerBuy = depositBalance / BigInt(slotsToFill);
        const amountPerBuyFloat = parseFloat(formatUnits(amountPerBuy, 18));
        
        if (amountPerBuyFloat < MIN_USD_PER_TRADE) {
            console.log(`ℹ️ Balance too low to split for more trades. Required ~$${MIN_USD_PER_TRADE * slotsToFill}.`);
            return;
        }

        for (const signal of prioritizedSignals.slice(0, slotsToFill)) {
            const tokenSymbol = signal.pairName.split('/')[0];
            const tokenAddress = signal.pairAddress;
            // (Same addNewAsset and setAssets logic as before...)
            
            const buySuccess = await sendTransaction(/*...buyASSET call with amountPerBuy...*/);

            if (buySuccess) {
                const entryPrice = await getTokenPrice(tokenAddress, BASE_TOKEN_ADDRESS);
                if (entryPrice) {
                    // MODIFIED: Add a new trade object to the activeTrades array
                    tradingState.activeTrades.push({
                        token: tokenSymbol,
                        address: tokenAddress,
                        entryPrice: entryPrice,
                        highestPrice: entryPrice, // NEW: Initialize highest price for trailing stop
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
  } finally {
    isRunning = false;
  }
}

// (getTokenPrice and other helpers remain the same)
// ...

export default runTradingBot;