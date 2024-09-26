/*
Here we will look at how to process Jettons withdrawals (outgoing Jettons) from your hot wallet to users wallets.

1. You have a key pair of your hot wallet (how to create key pair is described in `common.js`).
   You will send Jettons from jetton-wallets owned by this hot wallet.

2. You need to save all withdrawal requests from users in a persistent queue.

3. We will process withdrawals one by one, starting with the first one added.

4. We will repeat sending this transfer until it successfully sends. The `seqno` transfer parameter protects us from double withdrawal.

5. After transfer successfully sends, we move on to the next one in the queue.

*/

import TonWeb from "tonweb";
import { toNano } from "@ton/ton";
import TonWebMnemonic from "tonweb-mnemonic";
import dotenv from 'dotenv';
dotenv.config();
const BN = TonWeb.utils.BN;


const isMainnet = true;
let intervalId

// Use toncenter.com as HTTP API endpoint to interact with TON blockchain.
// You can get HTTP API key at https://toncenter.com
// You can run your own HTTP API instance https://github.com/toncenter/ton-http-api
const tonweb = isMainnet ?
    new TonWeb(new TonWeb.HttpProvider('https://toncenter.com/api/v2/jsonRPC', {apiKey: process.env.MAINNET_RPC_TOKEN})) :
    new TonWeb(new TonWeb.HttpProvider('https://testnet.toncenter.com/api/v2/jsonRPC', {apiKey: process.env.TESTNET_RPC_TOKEN}));

// key pair for HOT wallet

const seed = await TonWebMnemonic.mnemonicToSeed(process.env.AIRDROP_WALLET_MNEMONIC.split(' '));
// const seed = TonWeb.utils.base64ToBytes('YOU_PRIVATE_KEY_IN_BASE64');  // your hot wallet seed, see `common.js`
const keyPair = TonWeb.utils.keyPairFromSeed(seed);

// HOT wallet

const WalletClass = tonweb.wallet.all['v4R2'];
const wallet = new WalletClass(tonweb.provider, {
    publicKey: keyPair.publicKey
});

// Supported jettons config

const JETTONS_INFO = {
    'ENERGY': {
        address: '',
        decimals: 9
    }
}

// Prepare

let hotWalletAddress;
let hotWalletAddressString;
const jettons = {};

const prepare = async () => {
    hotWalletAddress = await wallet.getAddress();
    hotWalletAddressString = hotWalletAddress.toString(true, true, false);
    console.log('My HOT wallet is ', hotWalletAddressString);

    // ATTENTION:
    // Jetton-wallet contract has automatic Toncoin balance replenishment during transfer -
    // at the time the jettons arrive, the jetton-wallet contract always leaves a small Toncoin amount on the balance, enough to store for about a year.
    //
    // However, if there were no transfers for a very long time, it may freeze - to prevent this you need to maintain a Toncoin balance
    // on your jetton-wallets contracts yourself.
    // If the freezing has already happened, you can unfreeze them manually by https://unfreezer.ton.org/

    for (const name in JETTONS_INFO) {
        const info = JETTONS_INFO[name]; 
        const jettonMinter = new TonWeb.token.jetton.JettonMinter(tonweb.provider, {
            address: info.address
        });
        const jettonWalletAddress = await jettonMinter.getJettonWalletAddress(hotWalletAddress);
        console.log('My jetton wallet for ' + name + ' is ' + jettonWalletAddress.toString(true, true, true));
        const jettonWallet = new TonWeb.token.jetton.JettonWallet(tonweb.provider, {
            address: jettonWalletAddress
        });
        jettons[name] = {
            jettonMinter: jettonMinter,
            jettonWalletAddress: jettonWalletAddress,
            jettonWallet: jettonWallet
        };
    }
}

// Queue

const init = async () => {
    await prepare();

    // check that jetton transfer with specified `queryId` successfully processed
    const checkJettonTransfer = async (jettonName, transferQueryId,toAddress) => {
        const jettonWalletAddress = jettons[jettonName].jettonWalletAddress.toString(false);

        const transactions = await tonweb.provider.getTransactions(jettonWalletAddress,undefined,undefined,undefined,undefined,true);
        console.log('Check last ' + transactions.length + ' transactions');

        for (const tx of transactions) {
            const sourceAddress = tx.in_msg.source;
            if (!sourceAddress) {
                continue;
            }

            if (new TonWeb.utils.Address(sourceAddress).toString(false) !== hotWalletAddress.toString(false)) {
                continue;
            }

            if (!tx.in_msg.msg_data ||
                tx.in_msg.msg_data['@type'] !== 'msg.dataRaw' ||
                !tx.in_msg.msg_data.body
            ) {
                // no in_msg or in_msg body
                continue;
            }

            const msgBody = TonWeb.utils.base64ToBytes(tx.in_msg.msg_data.body);

            const cell = TonWeb.boc.Cell.oneFromBoc(msgBody);
            const slice = cell.beginParse();
            const op = slice.loadUint(32);
            if (!op.eq(new TonWeb.utils.BN(0x0f8a7ea5))) continue; // op == transfer
            const queryId = slice.loadUint(64);
            const amount = slice.loadCoins();
            const destinationAddress = slice.loadAddress();
            if (queryId.eq(new TonWeb.utils.BN(transferQueryId))) {
                if (tx.out_msgs.length === 0) {
                    return false; // Error in jetton transfer - no out messages produced
                }
                if (tx.out_msgs.length === 1 && new TonWeb.utils.Address(tx.out_msgs[0].destination).toString(false) === hotWalletAddress.toString(false)) {
                    return false; // Error in jetton transfer - bounced message
                }
                console.log(`request ${queryId} to address: ${toAddress} completed txId:https://tonviewer.com/transaction/${tx.transaction_id.hash}`);
                // console.log(tx);
                return true; // successful jetton transfer
            }
        }
        return false;
    }

    const doWithdraw = async (withdrawalRequest) => {
        // check seqno

        const seqno = await wallet.methods.seqno().call(); // get the current wallet `seqno` from the network

        if (seqno > withdrawalRequest.seqno) {
            console.log(`request ${withdrawalRequest.seqno} check`);
            if (await checkJettonTransfer(withdrawalRequest.jettonName, withdrawalRequest.seqno,withdrawalRequest.toAddress)) {
                //  console.log(`transfer completed for ${withdrawalRequest.toAddress}`)
                // this withdrawal request processed
                // mark it in your database and go to the next withdrawal request
                return true;
            } else {

                return false; // wait
            }
        }

        // check toncoin balance

        const toncoinAmount = TonWeb.utils.toNano('0.05'); // 0.05 TON

        const toncoinBalance = new BN(await tonweb.provider.getBalance(hotWalletAddressString));

        if (toncoinAmount.gte(toncoinBalance)) {
            console.log('there is not enough Toncoin balance to process the Jetton withdrawal');
            return false;
        }

        // check jetton balance

        const jettonWallet = jettons[withdrawalRequest.jettonName].jettonWallet;

        const jettonBalance = (await jettonWallet.getData()).balance;

        if (new BN(withdrawalRequest.amount).gt(jettonBalance)) {
            console.log('there is not enough Jetton balance to process the Jetton withdrawal');
            return false;
        }

        // Sign jetton transfer from HOT wallet to destination address

        const jettonWalletAddress = jettons[withdrawalRequest.jettonName].jettonWalletAddress.toString(true, true, true);

        const transfer = await wallet.methods.transfer({
            secretKey: keyPair.secretKey,
            toAddress: jettonWalletAddress,
            amount: toncoinAmount,
            seqno: seqno,
            payload: await jettonWallet.createTransferBody({
                queryId: seqno, // any number
                jettonAmount: withdrawalRequest.amount, // jetton amount in units
                toAddress: new TonWeb.utils.Address(withdrawalRequest.toAddress),
                responseAddress: hotWalletAddress
            })
        });

        // send transfer

        const isOfflineSign = false; // Some services sign transactions on one server and send signed transactions from another server

        if (isOfflineSign) {
            const query = await transfer.getQuery(); // transfer query
            const boc = await query.toBoc(false); // serialized transfer query in binary BoC format
            const bocBase64 = TonWeb.utils.bytesToBase64(boc); // in base64 format

            await tonweb.provider.sendBoc(bocBase64); // send transfer request to network
        } else {
            await transfer.send(); // send transfer request to network
        }
        console.log(`request ${withdrawalRequest.seqno} sent`);

        return false;
    }

    // Withdrawal requests queue
    const withdrawalRequests = [
        // Contains example withdrawal request
        // In real system `withdrawalRequests` is table in your persistent database
        {
            jettonName: "ENERGY",
            amount: toNano("<amount_to_airdrop>"),
            toAddress: "<recipient_address>"
        },
        
      
    ];

    let isProcessing = false;

    const tick = async () => {
        if (!withdrawalRequests.length) {
          console.log("All transactions processed")
          clearInterval(intervalId);
          return
        }; // nothing to withdraw

        console.log(withdrawalRequests.length + ' requests');

        if (isProcessing) return;
        isProcessing = true;

        // Get first withdrawal request from queue from database

        const withdrawalRequest = withdrawalRequests[0];

        // If the withdrawal request has no `seqno`, then we take the current wallet `seqno` from the network

        if (!withdrawalRequest.seqno) {
            withdrawalRequest.seqno = await wallet.methods.seqno().call();
            // after we set `seqno`, it should never change again for this transfer to prevent double withdrawal
        }

        try {
            if (await doWithdraw(withdrawalRequest)) {
                withdrawalRequests.shift(); // delete first request from queue
            }
        } catch (e) {
            console.error("Something went wrong",e);
        }

        isProcessing = false;
    }

    intervalId = setInterval(tick, 10 * 1000); // 10 seconds
    tick();
}

init().catch(error => console.log("Error",error));

