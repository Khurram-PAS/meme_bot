//CODE WRITTEN BY KHURRAM PERVAIZ 
require('dotenv').config();
const { Wallet, WebSocketProvider, Contract, ethers } = require('ethers');
const axios = require('axios');
const puppeteer = require('puppeteer');


// Load environment variables
const privateKey = process.env.PRIVATE_KEY;
const wsUrl = process.env.BASE_WS_URL;
const targetPair = process.env.TARGET_PAIR;
const tokenSnifferApiKey = process.env.TOKEN_SNIFFER_API_KEY;

if (!privateKey || !wsUrl || !targetPair || !tokenSnifferApiKey) {
    throw new Error("PRIVATE_KEY, BASE_WS_URL, TARGET_PAIR, or TOKEN_SNIFFER_API_KEY is missing in the .env file.");
}

// Initialize provider and wallet
const provider = new WebSocketProvider(wsUrl);
const wallet = new Wallet(privateKey, provider);

// Router and factory addresses
const uniswapRouterAddress = '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24';
const uniswapFactoryAddress = '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6';

// Import Router ABI
const uniswapRouterABI = require('./uniswapRouterABI');
const router = new Contract(uniswapRouterAddress, uniswapRouterABI, wallet);

// Factory ABI
const uniswapFactoryABI = [
    "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)"
];
const factory = new Contract(uniswapFactoryAddress, uniswapFactoryABI, provider);

// Function to check token safety using Token Sniffer

async function checkTokenSafetyWithTokenSniffer(tokenAddress) {
    const tokenSnifferUrl = `https://tokensniffer.com/TokenSnifferAPI/${tokenAddress}`;
    try {
        console.log(`Checking safety for token: ${tokenAddress} using Token Sniffer API with Puppeteer`);

        const browser = await puppeteer.launch({
            headless: true, // Set to false for debugging
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.goto(tokenSnifferUrl, { waitUntil: 'networkidle2' });

        // Extract the page content
        const pageContent = await page.content();

        // Parse the response (you may need to adjust parsing based on the actual HTML structure)
        const isHoneypot = pageContent.includes('"is_honeypot":true');
        const buyTaxMatch = pageContent.match(/"buy_tax":(\d+\.?\d*)/);
        const sellTaxMatch = pageContent.match(/"sell_tax":(\d+\.?\d*)/);

        const buyTax = buyTaxMatch ? parseFloat(buyTaxMatch[1]) : null;
        const sellTax = sellTaxMatch ? parseFloat(sellTaxMatch[1]) : null;

        console.log(`Token Sniffer Safety: Honeypot=${isHoneypot}, Buy Tax=${buyTax}%, Sell Tax=${sellTax}%`);

        await browser.close();

        // Logic to determine token safety
        if (isHoneypot || (buyTax && buyTax > 10) || (sellTax && sellTax > 10)) {
            console.log('Token failed safety checks (Token Sniffer).');
            return false;
        }

        return true;
    } catch (err) {
        console.error('Error checking token safety with Token Sniffer and Puppeteer:', err);
        return false;
    }
}


// Function to snipe token
async function snipeToken(tokenAddress, amountInETH) {
    const isSafe = await checkTokenSafetyWithTokenSniffer(tokenAddress);
    if (!isSafe) return;

    const ethAmount = ethers.parseEther(amountInETH.toString());
    const path = [targetPair, tokenAddress];
    const deadline = Math.floor(Date.now() / 1000) + 60 * 2;

    try {
        const tx = await router.swapExactETHForTokens(
            0,
            path,
            wallet.address,
            deadline,
            {
                value: ethAmount,
                gasLimit: 500000,
            }
        );
        console.log('Transaction sent:', tx.hash);
        const receipt = await tx.wait();
        console.log('Transaction mined:', receipt.transactionHash);
    } catch (err) {
        console.error('Error sniping token:', err);
    }
}

// Function to fetch new tokens
async function fetchNewToken() {
    return new Promise((resolve, reject) => {
        console.log('Listening for new token pairs...');

        factory.on('PairCreated', (token0, token1, pair) => {
            console.log(`New Pair Detected: Token0=${token0}, Token1=${token1}, Pair=${pair}`);

            const newTokenAddress = token0 === targetPair ? token1 : token0;

            if (newTokenAddress !== targetPair) {
                factory.removeAllListeners('PairCreated');
                resolve(newTokenAddress);
            }
        });

        setTimeout(() => {
            factory.removeAllListeners('PairCreated');
            reject(new Error('No new token detected within the timeout period.'));
        }, 60000);
    });
}

// Monitor tokens
async function monitorTokens() {
    while (true) {
        try {
            const newTokenAddress = await fetchNewToken();
            console.log('New token detected:', newTokenAddress);

            await snipeToken(newTokenAddress, 0.001);
        } catch (err) {
            console.error('Error monitoring tokens:', err);
        }
        await new Promise((r) => setTimeout(r, 5000));
    }
}

// Start monitoring
monitorTokens();
