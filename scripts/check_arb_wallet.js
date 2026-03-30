require('dotenv').config();
const { ethers } = require('ethers');

const privateKey = process.env.ARB_PRIVATE_KEY;

if (!privateKey) {
    console.error("Error: ARB_PRIVATE_KEY is not set in the environment.");
    process.exit(1);
}

const provider = new ethers.JsonRpcProvider("https://arb1.arbitrum.io/rpc");

try {
    const wallet = new ethers.Wallet(privateKey, provider);
    console.log("Wallet address:", wallet.address);
} catch (err) {
    console.error("Invalid private key:", err.message);
}
