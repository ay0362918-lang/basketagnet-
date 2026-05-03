import { GearApi, decodeAddress } from "@gear-js/api";
import { Keyring } from "@polkadot/keyring";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

console.log("⚡ POLYBASKETS ULTRA-FAST SPAMMER (V2) STARTING...");

const RPC = "wss://rpc.vara.network";
const BASKET_MARKET = "0xe5dd153b813c768b109094a9e2eb496c38216b1dbe868391f1d20ac927b7d2c2";
const BET_TOKEN = "0x186f6cda18fea13d9fc5969eec5a379220d6726f64c1d5f4b346e89271f917bc";
const BET_LANE = "0x35848dea0ab64f283497deaff93b12fe4d17649624b2cd5149f253ef372b29dc";

const VOUCHER_URL = "https://voucher-backend-production-5a1b.up.railway.app/voucher";

let api;
let account;
let hexAddress;
let voucherId;
let txCounter = 0;

function log(...args) {
    console.log(`[${new Date().toLocaleTimeString()}] ⚡`, ...args);
}

// Exactly mirrors the Rust payload logic to avoid double SCALE encoding WASM traps!
function buildApprovePayload(amountBigInt) {
    console.log("DEBUG amount:", amountBigInt.toString());  // ADD THIS
    
    const service = Buffer.from("BetToken");
    const method = Buffer.from("Approve");
    const spender = Buffer.from(BET_LANE.replace("0x", ""), "hex");
    
    const amountBuffer = Buffer.alloc(32, 0);
    let val = amountBigInt;
    for (let i = 0; i < 16; i++) {
        amountBuffer[i] = Number(val & 0xFFn);
        val = val >> 8n;
    }

    // ADD THIS to verify payload
    console.log("DEBUG payload end:", amountBuffer.slice(0, 8).toString('hex'));

    const payload = Buffer.concat([
        Buffer.from([(service.length) << 2]),
        service,
        Buffer.from([(method.length) << 2]),
        method,
        spender,
        amountBuffer
    ]);

    return "0x" + payload.toString("hex");
}

async function init() {
    log("🔌 Connecting to Vara WebSocket...");
    api = await GearApi.create({ providerAddress: RPC });

    const keyring = new Keyring({ type: "sr25519" });
    if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY missing in .env");
    account = keyring.addFromUri(process.env.PRIVATE_KEY);
    hexAddress = decodeAddress(account.address);

    log("✅ Connected:", account.address);
    log("📍 Hex address:", hexAddress);
}

async function ensureVoucher() {
    try {
        const res = await fetch(`${VOUCHER_URL}/${hexAddress}`);
        const data = await res.json();
        console.log("VOUCHER DEBUG:", JSON.stringify(data));

        if (data.voucherId && data.canTopUpNow === false) {
            voucherId = data.voucherId;
            return;
        }

        const postRes = await fetch(VOUCHER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ account: hexAddress, programs: [BASKET_MARKET, BET_TOKEN, BET_LANE] })
        });

        const postData = await postRes.json();
        if (postData.voucherId) voucherId = postData.voucherId;
        else if (data.voucherId) voucherId = data.voucherId;
        
        log("🎫 Voucher:", voucherId);
    } catch (err) {
        log("⚠️ Voucher error:", err.message);
    }
}

async function spamApproveDirectAPI(batchSize = 10) {
    if (!voucherId) return 0;

    try {
        const startingNonce = await api.rpc.system.accountNextIndex(account.address);
        let nonce = startingNonce.toNumber();
        const promises = [];

        for (let i = 0; i < batchSize; i++) {
            // FIX: Set amount to 0n! If the contract panics due to allowance overflow, 
            // setting it to 0 stops the panic, stopping the gas drain!
            const amount = 0n; 
            const payloadHex = buildApprovePayload(amount);

            const message = {
                destination: BET_TOKEN,
                payload: payloadHex,
                gasLimit: 500000000,  // Restored to optimal 500 Million (0.05 VARA)
                value: 0
            };

            const msgTx = api.message.send(message);
            const tx = api.voucher.call(voucherId, { SendMessage: msgTx });

            const currentNonce = nonce++;

            const txPromise = new Promise((resolve) => {
                tx.signAndSend(account, { nonce: currentNonce }, ({ status, events }) => {
                    // MUST wait for block inclusion so the 0.2 VARA reservation is refunded!
                    if (status.isInBlock || status.isFinalized) {
                        resolve(true);
                    } else if (status.isInvalid || status.isDropped) {
                        resolve(false);
                    }
                }).catch(err => {
                    resolve(false);
                });
            });

            promises.push(txPromise);
            txCounter++;
            log(`✅ TX #${txCounter} | Nonce pipelined: ${currentNonce}`);
        }

        await Promise.all(promises);
        return batchSize;

    } catch (err) {
        log("❌ Batch error:", err.message);
        return 0;
    }
}

async function loop() {
    log("🚀 ULTRA-FAST NONCE-PIPELINING LOOP STARTED (VOUCHER MODE RE-ENABLED)");
    
    await ensureVoucher();
    setInterval(ensureVoucher, 60_000);

    // Wait for mempool to clear from any previous run
    log("⏳ Waiting 30s for mempool to clear...");
    await new Promise(r => setTimeout(r, 30000));

    let round = 0;
    while (true) {
        try {
            round++;
            await spamApproveDirectAPI(10);
            await new Promise(r => setTimeout(r, 3000));
        } catch (err) {
            log("💥 Loop error:", err.message);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}
async function main() {
    await init();
    await loop();
}

main().catch(err => {
    console.error("💥 Fatal:", err);
    process.exit(1);
});
