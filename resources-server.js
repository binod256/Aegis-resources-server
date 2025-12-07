"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const app = express();
const PORT = process.env.PORT || 3000;

// Basic middleware
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

/**
 * Helper: normalize chain string
 */
function normalizeChain(chain) {
  if (!chain || typeof chain !== "string") return "base";
  return chain.trim().toLowerCase();
}

/**
 * Helper: normalize risk tolerance
 */
function normalizeRiskTolerance(risk) {
  if (!risk || typeof risk !== "string") return "moderate";
  const v = risk.trim().toLowerCase();
  if (["conservative", "moderate", "aggressive"].includes(v)) return v;
  return "moderate";
}

/**
 * Helper: normalize objective
 */
function normalizeObjective(obj) {
  if (!obj || typeof obj !== "string") return "balanced";
  const v = obj.trim().toLowerCase();
  if (["maximize_yield", "preserve_capital", "balanced"].includes(v)) return v;
  return "balanced";
}

/* -------------------------------------------------------------------------- */
/*                                Health Routes                               */
/* -------------------------------------------------------------------------- */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "AegisAI Resources Server",
    description:
      "Static helper endpoints for AegisAI ACP agent (risk_sentinel, gas_execution_optimizer, strategy_safety_audit, market_intelligence_feed, portfolio_rebalancer).",
    endpoints: [
      "/health",
      "/resources/risk-policies",
      "/resources/gas-bands",
      "/resources/strategy-archetypes",
      "/resources/market-signal-taxonomy",
      "/resources/portfolio-templates",
      "/resources/supported-chains",
      "/resources/supported-venues"
    ]
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    timestamp_utc: new Date().toISOString()
  });
});

/* -------------------------------------------------------------------------- */
/* 1) risk_sentinel helper: /resources/risk-policies                          */
/* -------------------------------------------------------------------------- */
/**
 * Query params:
 *  - chain  (optional, default: base)
 *  - venue  (optional, example: "uniswap_v3", "aerodrome")
 */
app.get("/resources/risk-policies", (req, res) => {
  const chain = normalizeChain(req.query.chain);
  const venue = (req.query.venue || "generic").toLowerCase();

  // Simple static risk bands per chain
  const chainBands = {
    base: {
      notional_usd: {
        low: 25000,
        medium: 100000,
        high: 250000
      },
      leverage: {
        max_spot: 1,
        max_margin: 3
      }
    },
    "ethereum-mainnet": {
      notional_usd: {
        low: 50000,
        medium: 200000,
        high: 500000
      },
      leverage: {
        max_spot: 1,
        max_margin: 5
      }
    },
    arbitrum: {
      notional_usd: {
        low: 20000,
        medium: 100000,
        high: 300000
      },
      leverage: {
        max_spot: 1,
        max_margin: 4
      }
    }
  };

  const defaultBands = {
    notional_usd: {
      low: 20000,
      medium: 75000,
      high: 200000
    },
    leverage: {
      max_spot: 1,
      max_margin: 3
    }
  };

  const bands = chainBands[chain] || defaultBands;

  res.json({
    resource: "risk-policies",
    chain,
    venue,
    version: "1.0.0",
    description:
      "Static risk band definitions used by AegisAI's risk_sentinel job for heuristic scoring.",
    notional_bands_usd: {
      low_risk_max: bands.notional_usd.low,
      medium_risk_max: bands.notional_usd.medium,
      high_risk_max: bands.notional_usd.high
    },
    leverage_limits: {
      max_spot: bands.leverage.max_spot,
      max_margin: bands.leverage.max_margin
    },
    notes: [
      "These thresholds are heuristic and should be aligned with the caller's own risk framework.",
      "For very illiquid venues, effective risk may be higher than implied by notional/leverage alone."
    ],
    timestamp_utc: new Date().toISOString()
  });
});

/* -------------------------------------------------------------------------- */
/* 2) gas_execution_optimizer helper: /resources/gas-bands                    */
/* -------------------------------------------------------------------------- */
/**
 * Query params:
 *  - chain    (optional, default: base)
 *  - urgency  (optional, low/normal/high; default normal)
 */
app.get("/resources/gas-bands", (req, res) => {
  const chain = normalizeChain(req.query.chain);
  const urgency = (req.query.urgency || "normal").toLowerCase();

  const baseBands = {
    base: {
      low: 5n * 10n ** 9n,
      normal: 15n * 10n ** 9n,
      high: 30n * 10n ** 9n
    },
    "ethereum-mainnet": {
      low: 10n * 10n ** 9n,
      normal: 30n * 10n ** 9n,
      high: 60n * 10n ** 9n
    },
    arbitrum: {
      low: 1n * 10n ** 9n,
      normal: 3n * 10n ** 9n,
      high: 6n * 10n ** 9n
    }
  };

  const bands = baseBands[chain] || baseBands["base"];

  res.json({
    resource: "gas-bands",
    chain,
    urgency,
    version: "1.0.0",
    description:
      "Static gas price bands (heuristic) used by gas_execution_optimizer as defaults when no baseline is provided.",
    gas_price_wei: {
      low: bands.low.toString(),
      normal: bands.normal.toString(),
      high: bands.high.toString()
    },
    notes: [
      "These values are illustrative defaults only and should be overridden by live gas data where available.",
      "AegisAI will still adjust gas heuristically based on urgency in the job input."
    ],
    timestamp_utc: new Date().toISOString()
  });
});

/* -------------------------------------------------------------------------- */
/* 3) strategy_safety_audit helper: /resources/strategy-archetypes           */
/* -------------------------------------------------------------------------- */
/**
 * Query params:
 *  - chain           (optional, default: base)
 *  - risk_tolerance  (optional, conservative/moderate/aggressive)
 */
app.get("/resources/strategy-archetypes", (req, res) => {
  const chain = normalizeChain(req.query.chain);
  const riskTolerance = normalizeRiskTolerance(req.query.risk_tolerance);

  const archetypes = [
    {
      id: "stable_lending",
      label: "Stablecoin Lending",
      baseline_risk: "low",
      description:
        "Lend major stablecoins on blue-chip lending markets; focus on preserving capital with modest yield.",
      typical_protocols: ["Aave", "Compound", "Spark"],
      typical_leverage: 1
    },
    {
      id: "delta_neutral_farming",
      label: "Delta-Neutral Yield Farming",
      baseline_risk: "medium",
      description:
        "Hedge price exposure while farming incentives; relies on hedging/liquidity efficiency.",
      typical_protocols: ["GMX", "Pendle", "Perp DEXs"],
      typical_leverage: 1.5
    },
    {
      id: "high_beta_liquidity",
      label: "High-Beta Liquidity Provision",
      baseline_risk: "high",
      description:
        "Provide liquidity to volatile pairs for high fees/emissions; exposed to IL and protocol risk.",
      typical_protocols: ["Uniswap v3 style AMMs", "Aerodrome"],
      typical_leverage: 2
    }
  ];

  res.json({
    resource: "strategy-archetypes",
    chain,
    risk_tolerance: riskTolerance,
    version: "1.0.0",
    description:
      "Reference strategy archetypes and their baseline risk profiles used by strategy_safety_audit.",
    archetypes,
    notes: [
      "AegisAI uses these archetypes as mental models when classifying strategies and generating findings.",
      "The caller can still provide arbitrary strategy descriptions; this mapping is for context and explanation."
    ],
    timestamp_utc: new Date().toISOString()
  });
});

/* -------------------------------------------------------------------------- */
/* 4) market_intelligence_feed helper: /resources/market-signal-taxonomy     */
/* -------------------------------------------------------------------------- */
/**
 * Query params:
 *  - chain           (optional, default: base)
 *  - min_notional    (optional, numeric; default 50000)
 */
app.get("/resources/market-signal-taxonomy", (req, res) => {
  const chain = normalizeChain(req.query.chain);
  const minNotional = Number(req.query.min_notional || 50000);

  const taxonomy = [
    {
      id: "whale_swaps",
      label: "Whale Swaps",
      severity_default: "medium",
      description:
        "Large on-chain swaps that may indicate accumulation, distribution, or hedging by large actors.",
      typical_threshold_usd: minNotional
    },
    {
      id: "liquidity_drains",
      label: "Liquidity Drains",
      severity_default: "high",
      description:
        "Sudden withdrawal or migration of liquidity from pools, potentially leading to slippage spikes.",
      typical_threshold_usd: minNotional * 2
    },
    {
      id: "volatility_spike",
      label: "Volatility Spike",
      severity_default: "medium",
      description:
        "Short-term surge in price volatility which may trigger liquidations or risk-off flows.",
      typical_threshold_usd: minNotional
    }
  ];

  res.json({
    resource: "market-signal-taxonomy",
    chain,
    minimum_notional_usd: minNotional,
    version: "1.0.0",
    description:
      "Canonical taxonomy for market_intelligence_feed signals, used to structure alerts and findings.",
    taxonomy,
    notes: [
      "These are template categories; a production deployment may refine thresholds per asset and venue.",
      "AegisAI's synthetic outputs for market_intelligence_feed are shaped according to this taxonomy."
    ],
    timestamp_utc: new Date().toISOString()
  });
});

/* -------------------------------------------------------------------------- */
/* 5) portfolio_rebalancer helper: /resources/portfolio-templates            */
/* -------------------------------------------------------------------------- */
/**
 * Query params:
 *  - risk_tolerance   (optional, conservative/moderate/aggressive)
 *  - objective        (optional, maximize_yield/preserve_capital/balanced)
 */
app.get("/resources/portfolio-templates", (req, res) => {
  const riskTolerance = normalizeRiskTolerance(req.query.risk_tolerance);
  const objective = normalizeObjective(req.query.target_objective || req.query.objective);

  const templates = {
    conservative: {
      preserve_capital: [
        { asset: "USDC", target_weight_pct: 60 },
        { asset: "USDT", target_weight_pct: 20 },
        { asset: "WETH", target_weight_pct: 10 },
        { asset: "WBTC", target_weight_pct: 10 }
      ],
      balanced: [
        { asset: "USDC", target_weight_pct: 40 },
        { asset: "WETH", target_weight_pct: 30 },
        { asset: "WBTC", target_weight_pct: 20 },
        { asset: "LSTs", target_weight_pct: 10 }
      ],
      maximize_yield: [
        { asset: "USDC", target_weight_pct: 30 },
        { asset: "WETH", target_weight_pct: 30 },
        { asset: "DeFi_bluechips", target_weight_pct: 40 }
      ]
    },
    moderate: {
      preserve_capital: [
        { asset: "USDC", target_weight_pct: 40 },
        { asset: "USDT", target_weight_pct: 20 },
        { asset: "WETH", target_weight_pct: 20 },
        { asset: "WBTC", target_weight_pct: 20 }
      ],
      balanced: [
        { asset: "USDC", target_weight_pct: 30 },
        { asset: "WETH", target_weight_pct: 30 },
        { asset: "WBTC", target_weight_pct: 20 },
        { asset: "DeFi_bluechips", target_weight_pct: 20 }
      ],
      maximize_yield: [
        { asset: "USDC", target_weight_pct: 20 },
        { asset: "WETH", target_weight_pct: 30 },
        { asset: "DeFi_bluechips", target_weight_pct: 50 }
      ]
    },
    aggressive: {
      preserve_capital: [
        { asset: "USDC", target_weight_pct: 30 },
        { asset: "WETH", target_weight_pct: 30 },
        { asset: "WBTC", target_weight_pct: 20 },
        { asset: "DeFi_bluechips", target_weight_pct: 20 }
      ],
      balanced: [
        { asset: "USDC", target_weight_pct: 20 },
        { asset: "WETH", target_weight_pct: 30 },
        { asset: "WBTC", target_weight_pct: 20 },
        { asset: "DeFi_bluechips", target_weight_pct: 30 }
      ],
      maximize_yield: [
        { asset: "USDC", target_weight_pct: 10 },
        { asset: "WETH", target_weight_pct: 25 },
        { asset: "WBTC", target_weight_pct: 15 },
        { asset: "DeFi_bluechips", target_weight_pct: 50 }
      ]
    }
  };

  const template =
    templates[riskTolerance][objective] || templates["moderate"]["balanced"];

  res.json({
    resource: "portfolio-templates",
    risk_tolerance: riskTolerance,
    target_objective: objective,
    version: "1.0.0",
    description:
      "Reference allocation templates used by portfolio_rebalancer as context for heuristic suggestions.",
    template,
    notes: [
      "These templates are NOT financial advice; they are illustrative shapes for different risk profiles and objectives.",
      "AegisAI's rebalance recommendations should be combined with the user's own constraints and investment policy."
    ],
    timestamp_utc: new Date().toISOString()
  });
});

/* -------------------------------------------------------------------------- */
/* 6) Supported chains: /resources/supported-chains                           */
/* -------------------------------------------------------------------------- */

app.get("/resources/supported-chains", (req, res) => {
  res.json({
    resource: "supported-chains",
    version: "1.0.0",
    chains: [
      {
        id: "base",
        chain_id: 8453,
        role: "primary",
        notes: "Default chain for AegisAI examples and testing."
      },
      {
        id: "ethereum-mainnet",
        chain_id: 1,
        role: "mainnet",
        notes: "Main Ethereum network. Higher gas, highest economic weight."
      },
      {
        id: "arbitrum",
        chain_id: 42161,
        role: "layer2",
        notes: "Layer 2 rollup environment with lower fees."
      }
    ],
    timestamp_utc: new Date().toISOString()
  });
});

/* -------------------------------------------------------------------------- */
/* 7) Supported venues: /resources/supported-venues                           */
/* -------------------------------------------------------------------------- */
/**
 * Query params:
 *  - chain  (optional, default: base)
 */
app.get("/resources/supported-venues", (req, res) => {
  const chain = normalizeChain(req.query.chain);

  const venuesByChain = {
    base: [
      {
        id: "aerodrome",
        type: "amm",
        description: "Main DEX/AMM on Base for many AegisAI examples."
      },
      {
        id: "uniswap_v3",
        type: "amm",
        description: "Uniswap v3-style deployments on Base."
      }
    ],
    "ethereum-mainnet": [
      {
        id: "uniswap_v3",
        type: "amm",
        description: "Flagship AMM on mainnet."
      },
      {
        id: "curve",
        type: "stable_amm",
        description: "Stablecoin-focused pools and stableswaps."
      }
    ],
    arbitrum: [
      {
        id: "gmx",
        type: "perp_dex",
        description: "Perpetual futures DEX exposure."
      },
      {
        id: "uniswap_v3",
        type: "amm",
        description: "Uniswap v3 deployments on Arbitrum."
      }
    ]
  };

  const venues = venuesByChain[chain] || venuesByChain["base"];

  res.json({
    resource: "supported-venues",
    chain,
    version: "1.0.0",
    venues,
    notes: [
      "These venue identifiers are suitable for use in risk_sentinel and gas_execution_optimizer job requests.",
      "AegisAI does not execute trades itself; these venues are metadata for risk and gas reasoning."
    ],
    timestamp_utc: new Date().toISOString()
  });
});

/* -------------------------------------------------------------------------- */
/*                               Start the server                             */
/* -------------------------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`🌐 AegisAI Resources Server listening on port ${PORT}`);
});
