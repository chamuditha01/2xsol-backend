/**
 * SOLFLIP — House Backend / Settler Bot
 *
 * Game struct byte layout (Borsh, matches Rust exactly):
 *   player_one       [32]   offset   0
 *   player_two       [32]   offset  32
 *   amount            u64   offset  64
 *   player_one_side    u8   offset  72
 *   status             u8   offset  73   ← 1=Open, 2=Joined
 *   padding            [6]  offset  74
 *   game_id            u64  offset  80
 *   server_hash       [32]  offset  88
 *   client_seed_a     [32]  offset 120
 *   client_seed_b     [32]  offset 152
 *   TOTAL                           184  (account allocated 200)
 *
 * SettleFlip account order (7 accounts — must match Rust process_settle):
 *   0  settler_acc    (signer, !writable)
 *   1  game_pda       (!signer,  writable)
 *   2  history_pda    (!signer,  writable)  ← NEW in updated contract
 *   3  player_one     (!signer,  writable)
 *   4  player_two     (!signer,  writable)
 *   5  commission_acc (!signer,  writable)
 *   6  system_program (!signer, !writable)
 */

require('dotenv').config();
const {
    Connection, PublicKey, Keypair,
    Transaction, TransactionInstruction, SystemProgram,
    LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const bs58    = require('bs58').default;
const { createClient } = require('@supabase/supabase-js');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const PROGRAM_ID       = new PublicKey(process.env.PROGRAM_ID);
const COMMISSION_ACC   = new PublicKey(process.env.COMMISSION_ACC);
const RPC_URL          = process.env.DEVNET_URL || 'https://api.devnet.solana.com';
const PORT             = process.env.PORT || 3001;
const SETTLEMENTS_TABLE = process.env.SETTLEMENTS_TABLE || 'leaderboard';
const SCAN_INTERVAL_MS = 5000;

// ── Byte offsets (computed from struct layout above) ──
const OFFSET_PLAYER_ONE  = 0;
const OFFSET_PLAYER_TWO  = 32;
const OFFSET_AMOUNT      = 64;
const OFFSET_STATUS      = 73;   // u8
const OFFSET_GAME_ID     = 80;   // u64 LE
const GAME_DATA_SIZE     = 200;  // allocated size; serialized is 184

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

if (!process.env.HOUSE_SECRET_KEY) {
    console.error('❌  HOUSE_SECRET_KEY missing in .env');
    process.exit(1);
}
const houseKeypair = Keypair.fromSecretKey(bs58.decode(process.env.HOUSE_SECRET_KEY));
const connection   = new Connection(RPC_URL, 'confirmed');

console.log(`🏠 House wallet: ${houseKeypair.publicKey.toBase58()}`);
console.log(`📡 RPC: ${RPC_URL}`);

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// SUPABASE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
async function saveSeed(gameId, seedHex) {
    const { error } = await supabase
        .from('game_seeds')
        .insert([{ game_id: gameId.toString(), seed_hex: seedHex }]);
    if (error) throw new Error(`Supabase saveSeed: ${error.message}`);
}

async function getSeed(gameId) {
    const { data, error } = await supabase
        .from('game_seeds')
        .select('seed_hex')
        .eq('game_id', gameId.toString())
        .single();
    if (error || !data) return null;
    return data.seed_hex;
}

async function saveSettlement(roundId, winner, prize) {
    const { error } = await supabase
        .from(SETTLEMENTS_TABLE)
        .insert([{
            roundid: roundId.toString(),
            winner,
            prize: prize.toString(),
        }]);
    if (error) throw new Error(`Supabase saveSettlement: ${error.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// WINNER DERIVATION FROM TX BALANCE DELTA
// ─────────────────────────────────────────────────────────────────────────────
async function deriveWinnerAndPrize(signature, playerOne, playerTwo) {
    const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
    });
    if (!tx?.meta) return null;

    const keys        = tx.transaction.message.accountKeys.map(k =>
        typeof k.toBase58 === 'function' ? k.toBase58() : k?.pubkey?.toBase58?.() ?? String(k));
    const pre         = tx.meta.preBalances  || [];
    const post        = tx.meta.postBalances || [];
    const deltas      = new Map();
    keys.forEach((k, i) => deltas.set(k, (post[i] ?? 0) - (pre[i] ?? 0)));

    const p1 = playerOne.toBase58();
    const p2 = playerTwo.toBase58();
    const d1 = deltas.get(p1) ?? 0;
    const d2 = deltas.get(p2) ?? 0;

    if (d1 <= 0 && d2 <= 0) return null;
    return d1 >= d2
        ? { winner: p1, prize: Math.max(d1, 0) }
        : { winner: p2, prize: Math.max(d2, 0) };
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSE GAME ACCOUNT FROM RAW BUFFER
// Returns null if buffer is too short or zeroed (closed account)
// ─────────────────────────────────────────────────────────────────────────────
function parseGameAccount(data) {
    if (!data || data.length < GAME_DATA_SIZE) return null;
    if (data.every(b => b === 0)) return null;         // closed/wiped

    const status = data.readUInt8(OFFSET_STATUS);
    const playerOne = new PublicKey(data.slice(OFFSET_PLAYER_ONE, OFFSET_PLAYER_ONE + 32));
    const playerTwo = new PublicKey(data.slice(OFFSET_PLAYER_TWO, OFFSET_PLAYER_TWO + 32));
    const amount    = data.readBigUInt64LE(OFFSET_AMOUNT);
    const gameId    = data.readBigUInt64LE(OFFSET_GAME_ID);

    return { status, playerOne, playerTwo, amount, gameId };
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTLE ONE GAME
// ─────────────────────────────────────────────────────────────────────────────

// Track PDAs currently being settled to avoid double-fire
const inFlight = new Set();

async function settleGame(gamePda, playerOne, playerTwo, gameId) {
    const pdaStr = gamePda.toBase58();
    if (inFlight.has(pdaStr)) return;
    inFlight.add(pdaStr);

    try {
        // ── 1. Get server seed from Supabase ──────────────────────────────
        const hexSeed = await getSeed(gameId.toString());
        if (!hexSeed) {
            console.warn(`⚠️  No seed for game ${gameId} — skipping`);
            return;
        }
        const serverSeed = Buffer.from(hexSeed, 'hex');

        // ── 2. Derive history PDA (seeds: ["history", player_one, game_id_le]) ──
        const gameIdBytes = Buffer.alloc(8);
        gameIdBytes.writeBigUInt64LE(gameId);
        const [historyPda] = await PublicKey.findProgramAddress(
            [Buffer.from('history'), playerOne.toBuffer(), gameIdBytes],
            PROGRAM_ID,
        );

        // ── 3. Build instruction data: [u8 variant=2][32b server_seed] ───
        const data = Buffer.alloc(33);
        data.writeUInt8(2, 0);
        serverSeed.copy(data, 1);

        // ── 4. Build instruction with correct 7-account list ─────────────
        const instruction = new TransactionInstruction({
            keys: [
                // 0 — settler (house wallet, signer)
                { pubkey: houseKeypair.publicKey, isSigner: true,  isWritable: false },
                // 1 — game PDA
                { pubkey: gamePda,                isSigner: false, isWritable: true  },
                // 2 — history PDA (created by settle instruction)
                { pubkey: historyPda,             isSigner: false, isWritable: true  },
                // 3 — player one
                { pubkey: playerOne,              isSigner: false, isWritable: true  },
                // 4 — player two
                { pubkey: playerTwo,              isSigner: false, isWritable: true  },
                // 5 — commission
                { pubkey: COMMISSION_ACC,         isSigner: false, isWritable: true  },
                // 6 — system program (needed for history PDA creation)
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            programId: PROGRAM_ID,
            data,
        });

        // ── 5. Send & confirm ─────────────────────────────────────────────
        const tx  = new Transaction().add(instruction);
        const sig = await connection.sendTransaction(tx, [houseKeypair], {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
        });
        await connection.confirmTransaction(sig, 'confirmed');

        console.log(`✅  Settled game ${gameId} | sig: ${sig.slice(0, 16)}...`);

        // ── 6. Derive winner from balance delta & save ────────────────────
        const settlement = await deriveWinnerAndPrize(sig, playerOne, playerTwo);
        if (settlement) {
            console.log(`🏆  Winner: ${settlement.winner} | Prize: ${settlement.prize / LAMPORTS_PER_SOL} SOL`);
            await saveSettlement(gameId, settlement.winner, settlement.prize);
        } else {
            console.warn(`⚠️  Could not derive winner for game ${gameId}`);
        }

    } catch (err) {
        if (err.message?.includes('already been processed')) {
            console.log(`ℹ️  Game ${gameId} already settled`);
        } else {
            console.error(`❌  settleGame(${gameId}):`, err.message);
        }
    } finally {
        inFlight.delete(pdaStr);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCANNER — polls for status=2 accounts every SCAN_INTERVAL_MS
// ─────────────────────────────────────────────────────────────────────────────
async function scanForJoins() {
    try {
        // Filter to accounts exactly GAME_DATA_SIZE bytes (avoids history PDAs etc.)
        const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
            filters: [{ dataSize: GAME_DATA_SIZE }],
        });

        if (accounts.length > 0)
            console.log(`🔍 Scanning ${accounts.length} game account(s)...`);

        for (const { pubkey, account } of accounts) {
            const game = parseGameAccount(account.data);
            if (!game) continue;

            // status 2 = both players joined, ready for settlement
            if (game.status === 2) {
                console.log(`🎰  Match found! game_id=${game.gameId} pda=${pubkey.toBase58().slice(0,8)}...`);
                // await so house wallet nonce doesn't collide between concurrent settles
                await settleGame(pubkey, game.playerOne, game.playerTwo, game.gameId);
            }
        }
    } catch (e) {
        console.error('❌  Scanner error:', e.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /generate-game  — called by frontend before CreateGame tx
app.post('/generate-game', async (req, res) => {
    try {
        const { gameId } = req.body;
        if (!gameId) return res.status(400).json({ error: 'Missing gameId' });

        const serverSeed = crypto.randomBytes(32);
        // Use SHA-256 to match Rust: solana_program::hash::hash() = SHA-256
        const serverHash = crypto.createHash('sha256').update(serverSeed).digest();

        await saveSeed(gameId.toString(), serverSeed.toString('hex'));

        console.log(`🆕  Game ${gameId} | hash: ${serverHash.toString('hex').slice(0, 12)}...`);

        // Return as byte array — frontend writes it directly into instruction buffer
        res.json({ serverHash: Array.from(serverHash) });
    } catch (e) {
        console.error('❌  /generate-game:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /health
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        house:  houseKeypair.publicKey.toBase58(),
        rpc:    RPC_URL,
    });
});

// GET /test-db
app.get('/test-db', async (req, res) => {
    try {
        const { data, error } = await supabase.from('game_seeds').select('count');
        if (error) throw error;
        res.json({ status: 'connected', data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /rpc  — transparent RPC proxy (used by some wallet adapters)
app.post('/rpc', async (req, res) => {
    try {
        const { method, params } = req.body;
        const result = await connection.rpcRequest(method, params ?? []);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: { message: e.message } });
    }
});

// POST /broadcast  — raw tx relay
app.post('/broadcast', async (req, res) => {
    try {
        const { transaction } = req.body;
        if (!transaction) return res.status(400).json({ error: 'Missing transaction' });
        const buf = Buffer.from(transaction, 'base64');
        const sig = await connection.sendRawTransaction(buf, {
            skipPreflight: true,
            preflightCommitment: 'confirmed',
        });
        await connection.confirmTransaction(sig, 'confirmed');
        res.json({ signature: sig });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀  House API listening on http://localhost:${PORT}`);
    console.log(`🤖  Settlement bot scanning every ${SCAN_INTERVAL_MS / 1000}s`);
    setInterval(scanForJoins, SCAN_INTERVAL_MS);
});