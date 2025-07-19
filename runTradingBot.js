import axios from 'axios';
// import { ethers } from 'ethers';
import { ethers, parseUnits, formatUnits } from 'ethers';
// import { contractInstance, tokenMap, provider, ownerSigner } from './contractConfig.js'; // assumed setup
// import AutomatedTradingBotABI from "./contracts/AutomatedTradingBotABI.json";
// import PancakeSwapRouterABI from "./contracts/PancakeSwapRouterABI.json";
import AutomatedTradingBotABI from "./contracts/AutomatedTradingBotABI.json" assert { type: "json" };
import PancakeSwapRouterABI from "./contracts/PancakeSwapRouterABI.json" assert { type: "json" };
import {tokenMap} from './config/tokenMap.js';


// --- Configurable Constants ---
const SIGNAL_ENDPOINT = "https://bot.securearbitrage.com/api/signals";

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
const tradedTokens = new Set();
let currentHolding = null;
let boughtPrice = null;

async function runTradingBot() {
  try {
    const signalRes = await axios.get(SIGNAL_ENDPOINT);
    console.log(signalRes);
    const signals = signalRes.data;

    // Selling logic
    if (currentHolding) {
      const holdingTokenAddress = tokenMap[currentHolding].toLowerCase();
      const holdingBalance = await contractInstance.getTokenBalance(holdingTokenAddress);
      if (holdingBalance.gt(0)) {
        const currentPrice = await getTokenPrice(holdingTokenAddress, BASE_TOKEN_ADDRESS);
        if (currentPrice && boughtPrice) {
          const profitPercent = ((currentPrice - boughtPrice) / boughtPrice) * 100;
          if (profitPercent >= PROFIT_TARGET_PERCENT) {
            const minAmountOut = 0; // use slippage logic if needed
            const deadline = Math.floor(Date.now() / 1000) + 60;
            const tx = await contractInstance
              .connect(ownerSigner)
              .sellASSET(
                holdingTokenAddress,
                holdingBalance,
                BASE_TOKEN_ADDRESS,
                minAmountOut,
                deadline
              );
            await tx.wait();
            console.log(`✅ Sold ${currentHolding} for profit: ${profitPercent.toFixed(2)}%`);
            tradedTokens.add(currentHolding);
            currentHolding = null;
            boughtPrice = null;
          } else {
            console.log(`⏳ ${currentHolding} not profitable yet: ${profitPercent.toFixed(2)}%`);
          }
        }
      }
    }

    // Buying logic (only if not currently holding)
    if (!currentHolding) {
      for (const signal of signals) {
        const tokenSymbol = signal.pairName.split('/')[0];
        const tokenAddress = signal.pairAddress;
        if (signal.signal === 'Buy' && !tradedTokens.has(tokenSymbol)) {

          if (!tokenMap[tokenSymbol]) {
            tokenMap[tokenSymbol] = tokenAddress;
            const addTx = await contractInstance.connect(ownerSigner).addNewAsset(tokenSymbol, tokenAddress);
            await addTx.wait();
            const approvalTx = await contractInstance.connect(ownerSigner).setAssets(tokenAddress);
            await approvalTx.wait();
          }

          const tokenInAddress = BASE_TOKEN_ADDRESS;
          const tokenOutAddress = tokenAddress.toLowerCase() || tokenMap[tokenSymbol].toLowerCase();
          const depositBalance = await contractInstance.getDepositBalance(tokenInAddress);

          if (depositBalance.gt(0)) {
            const amountIn = depositBalance;
            const deadline = Math.floor(Date.now() / 1000) + 60;
            const minAmountOut = 0; // Add slippage calc if needed

            const tx = await contractInstance
              .connect(ownerSigner)
              .buyASSET(tokenInAddress, amountIn, tokenOutAddress, minAmountOut, deadline);
            await tx.wait();

            boughtPrice = await getTokenPrice(tokenOutAddress, BASE_TOKEN_ADDRESS);
            currentHolding = tokenSymbol;

            console.log(`✅ Bought ${tokenSymbol} at price ${boughtPrice}`);
            break;
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ Error in runTradingBot():', err.message);
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

export default runTradingBot;
