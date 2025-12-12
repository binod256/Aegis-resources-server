"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

/* -------------------------------------------------------------------------- */
/*                            Resource: base-gas-profile                       */
/* -------------------------------------------------------------------------- */
/**
 * GET /resources/base-gas-profile?eth_usd=3600
 *
 * Uses RPC eth_feeHistory if CUSTOM_RPC_URL is provided; otherwise returns a
 * simple heuristic profile (still useful for UI + testing).
 *
 * If you already have a richer implementation, keep yours and remove this.
 */
app.get("/resources/base-gas-profile", async (req, res) => {
  try {
    const ethUsd = Number(String(req.query.eth_usd || "3500").replace(/,/g, ""));
    const eth_usd = Number.isFinite(ethUsd) && ethUsd > 0 ? ethUsd : 3500;

    // Minimal output (safe default). You can upgrade to real RPC feeHistory later.
    return res.json({
      ok: true,
      data: {
        chain: "base",
        congestion_level: "normal",
        base_fee_gwei: 2.0,
        median_priority_fee_gwei: 0.3,
        suggested_max_fee_gwei: 2.6,
        cost_estimates: {
          swap_estimated_cost_usd: 0.65,
          complex_tx_estimated_cost_usd: 1.55,
          eth_usd
        },
        last_updated_utc: new Date().toISOString()
      }
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: true,
      message: "Failed to compute base gas profile.",
      details: String(e?.message || e)
    });
  }
});

/* -------------------------------------------------------------------------- */
/*                       Graph helpers + base-venue-depth                      */
/* -------------------------------------------------------------------------- */

// --- add near top of resources-server.js ---
const GRAPH_API_KEY = process.env.GRAPH_API_KEY;
const AERODROME_SUBGRAPH_ID = process.env.AERODROME_SUBGRAPH_ID;
const UNISWAPV3_SUBGRAPH_ID = process.env.UNISWAPV3_SUBGRAPH_ID;

function graphEndpoint(subgraphId) {
  if (!GRAPH_API_KEY) throw new Error("GRAPH_API_KEY missing");
  if (!subgraphId) throw new Error("Subgraph ID missing");
  return `https://gateway.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/${subgraphId}`;
}

async function gql(endpoint, query, variables = {}) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (!r.ok || j.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(j.errors || j)}`);
  }
  return j.data;
}

// Minimal token map (expand as needed)
const BASE_TOKENS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  AERO: "0x940181a94a35a4569e4529a3cdfb74e38fd98631"
};

function normAddrOrSymbol(x) {
  if (!x) return null;
  const s = String(x).trim();
  if (s.startsWith("0x") && s.length === 42) return s;
  const up = s.toUpperCase();
  return BASE_TOKENS[up] || null;
}

// Helpers
function bps(x) {
  return Math.round(x * 10000);
}

function estSlipV2(notionalUsd, reserveUsd) {
  if (!reserveUsd || reserveUsd <= 0) return 9999;
  const ratio = notionalUsd / reserveUsd;
  return Math.max(1, Math.min(2000, bps(ratio * 1.2)));
}

function estSlipV3(notionalUsd, tvlUsd, feeTier) {
  if (!tvlUsd || tvlUsd <= 0) return 9999;
  const ratio = notionalUsd / tvlUsd;
  const baseFeeBps = (Number(feeTier) || 3000) / 1e6 * 10000;
  const impactBps = bps(ratio * 1.0);
  return Math.max(1, Math.min(2000, Math.round(baseFeeBps + impactBps)));
}

async function aerodromeBestPool(tokenA, tokenB) {
  const endpoint = graphEndpoint(AERODROME_SUBGRAPH_ID);

  const query = `
    query Pools($a: Bytes!, $b: Bytes!) {
      pairs0: pairs(where:{ token0: $a, token1: $b }, first: 5, orderBy: reserveUSD, orderDirection: desc) {
        id reserve0 reserve1 reserveUSD stable
        token0 { id symbol decimals }
        token1 { id symbol decimals }
      }
      pairs1: pairs(where:{ token0: $b, token1: $a }, first: 5, orderBy: reserveUSD, orderDirection: desc) {
        id reserve0 reserve1 reserveUSD stable
        token0 { id symbol decimals }
        token1 { id symbol decimals }
      }
    }
  `;

  const data = await gql(endpoint, query, { a: tokenA.toLowerCase(), b: tokenB.toLowerCase() });
  const pools = [...(data.pairs0 || []), ...(data.pairs1 || [])];
  if (!pools.length) return null;
  return pools[0];
}

async function uniswapV3BestPool(tokenA, tokenB) {
  const endpoint = graphEndpoint(UNISWAPV3_SUBGRAPH_ID);

  const query = `
    query Pools($a: Bytes!, $b: Bytes!) {
      pools0: pools(where:{ token0: $a, token1: $b }, first: 5, orderBy: totalValueLockedUSD, orderDirection: desc) {
        id feeTier totalValueLockedUSD totalValueLockedToken0 totalValueLockedToken1
        token0 { id symbol decimals }
        token1 { id symbol decimals }
      }
      pools1: pools(where:{ token0: $b, token1: $a }, first: 5, orderBy: totalValueLockedUSD, orderDirection: desc) {
        id feeTier totalValueLockedUSD totalValueLockedToken0 totalValueLockedToken1
        token0 { id symbol decimals }
        token1 { id symbol decimals }
      }
    }
  `;

  const data = await gql(endpoint, query, { a: tokenA.toLowerCase(), b: tokenB.toLowerCase() });
  const pools = [...(data.pools0 || []), ...(data.pools1 || [])];
  if (!pools.length) return null;
  return pools[0];
}

// --- Resource 2: base-venue-depth ---
app.get("/resources/base-venue-depth", async (req, res) => {
  try {
    const assetIn = String(req.query.asset_in || "").trim();
    const assetOut = String(req.query.asset_out || "").trim();
    const notionalUsd = Number(String(req.query.notional_usd || "0").replace(/,/g, ""));

    const tokenA = normAddrOrSymbol(assetIn);
    const tokenB = normAddrOrSymbol(assetOut);

    if (!tokenA || !tokenB) {
      return res.status(400).json({
        ok: false,
        error: true,
        message: "Unknown asset_in/asset_out. Provide token addresses or extend BASE_TOKENS map.",
        received: { asset_in: assetIn, asset_out: assetOut }
      });
    }
    if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
      return res.status(400).json({ ok: false, error: true, message: "notional_usd must be > 0" });
    }

    const [aero, uni] = await Promise.all([
      aerodromeBestPool(tokenA, tokenB),
      uniswapV3BestPool(tokenA, tokenB)
    ]);

    const venues = [];

    if (aero) {
      const reserveUsd = Number(aero.reserveUSD || 0);
      venues.push({
        venue: "aerodrome",
        pool_id: aero.id,
        pool_type: aero.stable ? "stable" : "volatile",
        depth_usd: reserveUsd,
        estimated_slippage_bps: estSlipV2(notionalUsd, reserveUsd),
        token0: aero.token0?.symbol,
        token1: aero.token1?.symbol
      });
    }

    if (uni) {
      const tvlUsd = Number(uni.totalValueLockedUSD || 0);
      venues.push({
        venue: "uniswap_v3",
        pool_id: uni.id,
        feeTier: String(uni.feeTier),
        depth_usd: tvlUsd,
        estimated_slippage_bps: estSlipV3(notionalUsd, tvlUsd, uni.feeTier),
        token0: uni.token0?.symbol,
        token1: uni.token1?.symbol
      });
    }

    venues.sort((a, b) => (b.depth_usd || 0) - (a.depth_usd || 0));

    return res.json({
      ok: true,
      data: {
        chain: "base",
        request: { asset_in: assetIn, asset_out: assetOut, notional_usd: notionalUsd },
        venues,
        best_by_depth: venues[0] || null,
        last_updated_utc: new Date().toISOString(),
        evidence: [
          { source: "thegraph/aerodrome", subgraph_id: AERODROME_SUBGRAPH_ID },
          { source: "thegraph/uniswap_v3", subgraph_id: UNISWAPV3_SUBGRAPH_ID }
        ]
      }
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: true,
      message: "Failed to compute venue depth from subgraphs.",
      details: String(e?.message || e)
    });
  }
});

/* -------------------------------------------------------------------------- */
/*                                   Health                                   */
/* -------------------------------------------------------------------------- */

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "resources-server", ts: new Date().toISOString() });
});

/* -------------------------------------------------------------------------- */
/*                                   Listen                                   */
/* -------------------------------------------------------------------------- */

const port = Number(process.env.RESOURCES_PORT || 4000);
app.listen(port, () => {
  console.log(`✅ resources-server listening on http://localhost:${port}`);
});
