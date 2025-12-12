"use strict";

/**
 * AegisAI — ACP Provider (Base-only) using AcpContractClientV2 (acp-node 0.3.0-beta.14)
 *
 * Jobs supported:
 *  1) pre_trade_risk_pack
 *  2) execution_quote_and_route
 *  3) market_intelligence_feed
 *
 * Notes:
 * - Base-only: chain must be "base" (or "base-sepolia" if you set ACP_CHAIN accordingly and want testnet)
 * - Accepts numeric strings from Virtual UI (e.g., "50000", "50,000")
 * - Uses 2 resources from your resources-server.js:
 *    - /resources/base-gas-profile
 *    - /resources/base-venue-depth
 */

require("dotenv").config();

const AcpClientModule = require("@virtuals-protocol/acp-node");
const AcpClient = AcpClientModule.default;

const {
  AcpContractClientV2,
  baseAcpConfigV2,
  baseSepoliaAcpConfigV2
} = AcpClientModule;

// In-memory cache to remember job type + requirement between phases
const jobCache = new Map();

const AGENT_VERSION = "1.0.0";

// Base-only (mainnet) by default; allow base-sepolia via env ACP_CHAIN=base-sepolia
const ACP_CHAIN = String(process.env.ACP_CHAIN || "base").toLowerCase();
const SUPPORTED_CHAINS = ["base", "base-sepolia"];

// Your resources server base URL (optional). If omitted, defaults to localhost:4000.
const RESOURCES_BASE_URL =
  process.env.RESOURCES_BASE_URL ||
  `http://localhost:${process.env.RESOURCES_PORT || 4000}`;

/* -------------------------------------------------------------------------- */
/*                               Utility Helpers                              */
/* -------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function oneOf(v, allowed) {
  return allowed.includes(v);
}

function pushErr(errors, field, message) {
  errors.push(`${field}: ${message}`);
}

// Accept numbers or numeric strings like "50000" or "50,000"
function toNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.trim().replace(/,/g, "");
    if (!cleaned) return NaN;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function toInt(v) {
  const n = toNumber(v);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

async function safeFetchJson(url) {
  try {
    const r = await fetch(url, { method: "GET" });
    const j = await r.json();
    return { ok: r.ok, status: r.status, json: j };
  } catch (e) {
    return { ok: false, status: 0, json: null, error: String(e?.message || e) };
  }
}

function confidenceFromEvidence(evidence) {
  const src = new Set((evidence || []).map((x) => x.source));
  const hasGas = src.has("resources/base-gas-profile");
  const hasDepth = src.has("resources/base-venue-depth");
  if (hasGas && hasDepth) return "high";
  if (hasGas || hasDepth) return "medium";
  return "low";
}

/* -------------------------------------------------------------------------- */
/*                           Resource Fetch Functions                          */
/* -------------------------------------------------------------------------- */

async function fetchBaseGasProfile(ethUsdOpt) {
  const url = new URL(`${RESOURCES_BASE_URL}/resources/base-gas-profile`);
  if (ethUsdOpt != null && Number.isFinite(ethUsdOpt)) {
    url.searchParams.set("eth_usd", String(ethUsdOpt));
  }

  const r = await safeFetchJson(url.toString());
  if (!r.ok || !r.json?.ok) {
    return {
      ok: false,
      evidence: [
        {
          source: "resources/base-gas-profile",
          error: r.error || r.json?.message || "unavailable"
        }
      ],
      data: null
    };
  }

  return {
    ok: true,
    evidence: [{ source: "resources/base-gas-profile", freshness_seconds: 60 }],
    data: r.json.data
  };
}

async function fetchBaseVenueDepth(assetIn, assetOut, notionalUsd) {
  const url = new URL(`${RESOURCES_BASE_URL}/resources/base-venue-depth`);
  url.searchParams.set("asset_in", String(assetIn));
  url.searchParams.set("asset_out", String(assetOut));
  url.searchParams.set("notional_usd", String(notionalUsd));

  const r = await safeFetchJson(url.toString());
  if (!r.ok || !r.json?.ok) {
    return {
      ok: false,
      evidence: [
        {
          source: "resources/base-venue-depth",
          error: r.error || r.json?.message || "unavailable"
        }
      ],
      data: null
    };
  }

  return {
    ok: true,
    evidence: [{ source: "resources/base-venue-depth", freshness_seconds: 60 }],
    data: r.json.data
  };
}

/* -------------------------------------------------------------------------- */
/*                               Validations                                  */
/* -------------------------------------------------------------------------- */

function validateBaseChain(req, errors) {
  if (!isNonEmptyString(req.chain)) {
    pushErr(errors, "chain", "must be a non-empty string");
    return;
  }
  const c = String(req.chain).toLowerCase();
  if (!SUPPORTED_CHAINS.includes(c)) {
    pushErr(errors, "chain", `must be one of: ${SUPPORTED_CHAINS.join(", ")}`);
  }
  // If your agent is strictly mainnet base-only, uncomment below:
  // if (c !== "base") pushErr(errors, "chain", "must be 'base' (mainnet only)");
  req.chain = c;
}

function validatePreTradeRiskPack(req) {
  const errors = [];

  if (!isNonEmptyString(req.client_agent_id)) pushErr(errors, "client_agent_id", "must be a non-empty string");
  validateBaseChain(req, errors);

  if (!isNonEmptyString(req.asset_in)) pushErr(errors, "asset_in", "must be token symbol or address");
  if (!isNonEmptyString(req.asset_out)) pushErr(errors, "asset_out", "must be token symbol or address");

  const side = String(req.side || "").toLowerCase();
  if (!oneOf(side, ["buy", "sell"])) pushErr(errors, "side", "must be 'buy' or 'sell'");
  req.side = side;

  const notional = toNumber(req.notional_value_usd);
  if (!Number.isFinite(notional) || notional <= 0) {
    pushErr(errors, "notional_value_usd", "must be a positive number (numeric string allowed)");
  }
  req.notional_value_usd = notional;

  const venue = String(req.execution_venue || "unknown").toLowerCase();
  const allowedVenues = ["aerodrome", "uniswap_v3", "uniswap_v2", "unknown"];
  if (!allowedVenues.includes(venue)) pushErr(errors, "execution_venue", `must be one of: ${allowedVenues.join(", ")}`);
  req.execution_venue = venue;

  const slip = toInt(req.max_slippage_bps);
  if (!Number.isFinite(slip) || slip < 1 || slip > 2000) {
    pushErr(errors, "max_slippage_bps", "must be integer 1..2000 (e.g., 50 = 0.50%)");
  }
  req.max_slippage_bps = slip;

  const urgency = String(req.urgency || "normal").toLowerCase();
  if (!oneOf(urgency, ["low", "normal", "high"])) pushErr(errors, "urgency", "must be low/normal/high");
  req.urgency = urgency;

  const lev = toNumber(req.leverage ?? 1);
  if (!Number.isFinite(lev) || lev < 1) pushErr(errors, "leverage", "must be >= 1 (1 for spot)");
  req.leverage = lev;

  const horizon = req.time_horizon_minutes == null ? null : toInt(req.time_horizon_minutes);
  if (horizon != null && (!Number.isFinite(horizon) || horizon < 1 || horizon > 10080)) {
    pushErr(errors, "time_horizon_minutes", "must be integer 1..10080 (optional)");
  }
  if (horizon != null) req.time_horizon_minutes = horizon;

  return { ok: errors.length === 0, errors };
}

function validateExecutionQuoteAndRoute(req) {
  const errors = [];

  if (!isNonEmptyString(req.client_agent_id)) pushErr(errors, "client_agent_id", "must be a non-empty string");
  validateBaseChain(req, errors);

  if (!isNonEmptyString(req.asset_in)) pushErr(errors, "asset_in", "must be token symbol or address");
  if (!isNonEmptyString(req.asset_out)) pushErr(errors, "asset_out", "must be token symbol or address");

  const notional = toNumber(req.notional_value_usd);
  if (!Number.isFinite(notional) || notional <= 0) {
    pushErr(errors, "notional_value_usd", "must be a positive number (numeric string allowed)");
  }
  req.notional_value_usd = notional;

  const slip = toInt(req.max_slippage_bps);
  if (!Number.isFinite(slip) || slip < 1 || slip > 2000) {
    pushErr(errors, "max_slippage_bps", "must be integer 1..2000");
  }
  req.max_slippage_bps = slip;

  if (req.allowed_venues != null) {
    if (!Array.isArray(req.allowed_venues) || req.allowed_venues.length === 0) {
      pushErr(errors, "allowed_venues", "must be a non-empty array if provided");
    } else {
      const lower = req.allowed_venues.map((v) => String(v).toLowerCase());
      const allowed = ["aerodrome", "uniswap_v3", "uniswap_v2"];
      const bad = lower.filter((v) => !allowed.includes(v));
      if (bad.length) pushErr(errors, "allowed_venues", `unsupported: ${bad.join(", ")}`);
      req.allowed_venues = lower;
    }
  } else {
    req.allowed_venues = ["uniswap_v3", "aerodrome"];
  }

  req.prefer_stable_routes = Boolean(req.prefer_stable_routes);

  const deadline = req.deadline_seconds == null ? 180 : toInt(req.deadline_seconds);
  if (!Number.isFinite(deadline) || deadline < 60 || deadline > 3600) {
    pushErr(errors, "deadline_seconds", "must be integer 60..3600 (default 180)");
  }
  req.deadline_seconds = deadline;

  return { ok: errors.length === 0, errors };
}

function validateMarketIntel(req) {
  const errors = [];

  if (!isNonEmptyString(req.client_agent_id)) pushErr(errors, "client_agent_id", "must be a non-empty string");
  validateBaseChain(req, errors);

  const lb = toInt(req.lookback_minutes);
  if (!Number.isFinite(lb) || lb < 5 || lb > 43200) {
    pushErr(errors, "lookback_minutes", "must be integer 5..43200");
  }
  req.lookback_minutes = lb;

  // accept both keys: minimum_notional_usd or min_notional_usd
  const minN = req.minimum_notional_usd != null ? toNumber(req.minimum_notional_usd) : toNumber(req.min_notional_usd);
  if (!Number.isFinite(minN) || minN <= 0) {
    pushErr(errors, "minimum_notional_usd", "must be a positive number (numeric string allowed)");
  }
  req.minimum_notional_usd = minN;

  if (req.focus_assets != null) {
    if (!Array.isArray(req.focus_assets)) pushErr(errors, "focus_assets", "must be array(string) if provided");
    else req.focus_assets = req.focus_assets.map((x) => String(x).trim()).filter(Boolean);
  } else {
    req.focus_assets = [];
  }

  const sev = String(req.severity_floor || "info").toLowerCase();
  const allowed = ["info", "low", "medium", "high", "critical"];
  if (!allowed.includes(sev)) pushErr(errors, "severity_floor", `must be one of: ${allowed.join(", ")}`);
  req.severity_floor = sev;

  return { ok: errors.length === 0, errors };
}

/* -------------------------------------------------------------------------- */
/*                              Deliverable Builders                           */
/* -------------------------------------------------------------------------- */

function invalidDeliverable(jobName, validation) {
  return {
    job_name: jobName,
    agent_version: AGENT_VERSION,
    chain: ACP_CHAIN,
    validation_passed: false,
    validation_errors: validation.errors,
    decision: "REJECT",
    risk_score: 0,
    recommended_size_factor: 0,
    confidence_level: "low",
    key_risks: ["Input validation failed; no analysis performed."],
    evidence: [],
    assumptions: ["No analysis performed due to invalid input."],
    timestamp_utc: nowIso()
  };
}

async function buildPreTradeRiskPackDeliverable(req, validation) {
  if (!validation.ok) return invalidDeliverable("pre_trade_risk_pack", validation);

  const evidence = [];
  const assumptions = [];
  const timestamp = nowIso();

  const ethUsd = toNumber(req.eth_usd); // optional if you later add it
  const gasR = await fetchBaseGasProfile(Number.isFinite(ethUsd) ? ethUsd : undefined);
  evidence.push(...gasR.evidence);

  const depthR = await fetchBaseVenueDepth(req.asset_in, req.asset_out, req.notional_value_usd);
  evidence.push(...depthR.evidence);

  const confidence = confidenceFromEvidence(evidence);

  // Venue depth response
  const venues = depthR.data?.venues || [];
  const best = depthR.data?.best_by_depth || null;

  if (!best) {
    assumptions.push("No venue depth returned from subgraphs. Falling back to conservative estimates.");
  }

  const estSlipBps = best?.estimated_slippage_bps ?? clamp(Math.round((req.notional_value_usd / 50000) * 80), 15, 180);
  const depthUsd = best?.depth_usd ?? 300000;

  // Gas analysis
  const gas = gasR.data || {};
  const congestion = gas.congestion_level || "unknown";
  const suggestedMaxFeeWei = gas.suggested_max_fee_gwei != null ? Number(gas.suggested_max_fee_gwei) * 1e9 : 2.5e9;

  // Score components (transparent heuristic)
  const sizeScore = clamp(Math.round((req.notional_value_usd / 100000) * 25), 0, 35);
  const slipScore = clamp(Math.round((estSlipBps / 100) * 40), 5, 45);
  const gasScore = congestion === "high" ? 18 : congestion === "elevated" ? 10 : 6;
  const levScore = req.leverage > 1 ? clamp(Math.round((req.leverage - 1) * 20), 0, 30) : 0;

  const riskScore = clamp(sizeScore + slipScore + gasScore + levScore, 0, 100);

  // Decision logic
  let decision = "APPROVE";
  let sizeFactor = 1.0;

  if (estSlipBps > req.max_slippage_bps) {
    decision = "SIZE_DOWN";
    sizeFactor = clamp(req.max_slippage_bps / estSlipBps, 0.2, 0.8);
  }

  if (riskScore >= 80) {
    decision = "REJECT";
    sizeFactor = 0;
  }

  // Split suggestion
  const splitCount =
    req.notional_value_usd > 75000 ? 3 :
    req.notional_value_usd > 30000 ? 2 : 1;

  const recommendedMaxSlip = Math.min(req.max_slippage_bps, Math.max(20, Math.round(estSlipBps * 0.85)));

  const keyRisks = [];
  if (estSlipBps >= 60) keyRisks.push("Slippage increases materially at this size; split execution recommended.");
  if (congestion === "elevated" || congestion === "high") keyRisks.push("Gas regime elevated; prefer batching or waiting for calmer blocks.");
  if (req.leverage > 1) keyRisks.push("Leverage amplifies liquidation and execution sensitivity.");
  if (!best) keyRisks.push("Venue depth data unavailable; results rely on conservative fallback.");

  const fallbackVenues = venues
    .map(v => v.venue)
    .filter(v => v && v !== best?.venue);

  return {
    job_name: "pre_trade_risk_pack",
    agent_version: AGENT_VERSION,
    chain: req.chain,

    validation_passed: true,
    validation_errors: [],

    decision,
    risk_score: riskScore,
    recommended_size_factor: Number(sizeFactor.toFixed(2)),
    confidence_level: confidence,

    key_risks: keyRisks,

    execution_plan: {
      recommended_venue: best?.venue || req.execution_venue || "unknown",
      fallback_venues: fallbackVenues.length ? fallbackVenues : ["uniswap_v3", "aerodrome"].filter(v => v !== best?.venue),
      recommended_split_count: splitCount,
      recommended_max_slippage_bps: recommendedMaxSlip,
      deadline_seconds: 180,
      notes:
        decision === "APPROVE"
          ? "Proceed with standard protection parameters."
          : decision === "SIZE_DOWN"
          ? "Reduce size and/or split into clips; re-check depth if market moves."
          : "Do not execute under current conditions without explicit risk sign-off."
    },

    liquidity_analysis: {
      pair: `${String(req.asset_in).toUpperCase()}/${String(req.asset_out).toUpperCase()}`,
      notional_usd: req.notional_value_usd,
      best_by_depth: best || null,
      venues_considered: venues,
      estimated_liquidity_depth_usd: depthUsd,
      estimated_slippage_bps_at_size: estSlipBps,
      price_impact_estimate_bps: clamp(Math.round(estSlipBps * 0.7), 5, 250)
    },

    gas_analysis: {
      congestion_level: congestion,
      suggested_max_fee_gwei: gas.suggested_max_fee_gwei ?? null,
      median_priority_fee_gwei: gas.median_priority_fee_gwei ?? null,
      base_fee_gwei: gas.base_fee_gwei ?? null,
      estimated_gas_units: 180000,
      estimated_gas_price_wei: Math.round(suggestedMaxFeeWei),
      cost_estimates: gas.cost_estimates || null
    },

    scenario_analysis: [
      {
        scenario: "gas_spike_30pct",
        impact: "Higher inclusion cost; can reduce net edge on small-margin trades.",
        recommendation: req.urgency === "high" ? "Proceed but accept higher cost." : "Wait or split order."
      },
      {
        scenario: "liquidity_drop_20pct",
        impact: "Slippage can exceed cap at full size.",
        recommendation: "Increase split count and re-run base_venue_depth before each clip."
      },
      {
        scenario: "fast_price_move",
        impact: "MinOut may be hit; trade could revert under tight slippage.",
        recommendation: "Split execution and re-quote each clip."
      }
    ],

    evidence,
    assumptions: assumptions.length ? assumptions : ["No additional assumptions."],
    timestamp_utc: timestamp
  };
}

async function buildExecutionQuoteAndRouteDeliverable(req, validation) {
  if (!validation.ok) return invalidDeliverable("execution_quote_and_route", validation);

  const evidence = [];
  const timestamp = nowIso();

  const depthR = await fetchBaseVenueDepth(req.asset_in, req.asset_out, req.notional_value_usd);
  evidence.push(...depthR.evidence);

  const venues = depthR.data?.venues || [];
  const best = depthR.data?.best_by_depth || null;

  // If caller restricts venues, pick best among allowed
  const allowed = new Set((req.allowed_venues || []).map((v) => String(v).toLowerCase()));
  const ranked = venues
    .filter(v => !allowed.size || allowed.has(String(v.venue).toLowerCase()))
    .sort((a, b) => (Number(b.depth_usd || 0) - Number(a.depth_usd || 0)));

  const chosen = ranked[0] || best || null;
  const fallback = ranked.slice(1, 4).map(v => v.venue).filter(Boolean);

  const estSlip = chosen?.estimated_slippage_bps ?? clamp(Math.round((req.notional_value_usd / 50000) * 80), 15, 180);
  const impact = clamp(Math.round(estSlip * 0.7), 5, 250);

  const warnings = [];
  if (!chosen) warnings.push("No venue depth returned; using fallback estimates.");
  if (estSlip > req.max_slippage_bps) warnings.push("Estimated slippage may exceed cap; reduce size or split.");

  const split = req.notional_value_usd > 60000 ? 3 : req.notional_value_usd > 25000 ? 2 : 1;
  const recommendedMaxSlip = Math.min(req.max_slippage_bps, Math.max(20, Math.round(estSlip * 0.85)));

  return {
    job_name: "execution_quote_and_route",
    agent_version: AGENT_VERSION,
    chain: req.chain,

    validation_passed: true,
    validation_errors: [],

    best_venue: chosen?.venue || "unknown",
    fallback_venues: fallback.length ? fallback : ["aerodrome", "uniswap_v3"].filter(v => v !== chosen?.venue),

    estimated_slippage_bps: Math.round(estSlip),
    estimated_price_impact_bps: impact,
    recommended_max_slippage_bps: recommendedMaxSlip,
    recommended_split_count: split,

    safety_parameters: {
      deadline_seconds: req.deadline_seconds,
      min_out_strategy: "minOut = quote * (1 - recommended_max_slippage_bps/10000)",
      retry_policy: "If revert due to slippage, reduce size by 20% and retry once."
    },

    warnings,
    evidence,
    timestamp_utc: timestamp
  };
}

async function buildMarketIntelDeliverable(req, validation) {
  if (!validation.ok) return invalidDeliverable("market_intelligence_feed", validation);

  const evidence = [];
  const timestamp = nowIso();

  const gasR = await fetchBaseGasProfile(undefined);
  evidence.push(...gasR.evidence);

  const gas = gasR.data || {};
  const congestion = gas.congestion_level || "unknown";
  const volatility = gas.variance_hint?.volatility_ratio ?? 0;

  const alerts = [];

  if (volatility > 0.25) {
    alerts.push({
      id: "gas_variance",
      severity: volatility > 0.5 ? "high" : "medium",
      title: "Gas variance elevated vs recent median",
      description: "Fee variance is elevated; execution cost and inclusion may fluctuate.",
      recommended_action:
        req.severity_floor === "high" || req.severity_floor === "critical"
          ? "If urgent, proceed with higher max fee; otherwise split or wait."
          : "Wait or split execution to reduce revert/cost risk."
    });
  }

  // Optional: lightweight depth check for watchlist pairs (if user provides pairs as "USDC/WETH")
  const watchlist_summary = {};
  for (const item of req.focus_assets || []) {
    watchlist_summary[item] = { note: "normal", risk_flag: false };
  }

  const regime = {
    gas_regime: congestion,
    liquidity_regime: "venue-specific",
    risk_note:
      congestion === "high"
        ? "Network stress detected; reduce clip size, widen timing window, and be careful with tight slippage."
        : congestion === "elevated"
        ? "Moderate congestion; standard execution with mild caution."
        : "No broad network stress detected; normal execution recommended."
  };

  return {
    job_name: "market_intelligence_feed",
    agent_version: AGENT_VERSION,
    chain: req.chain,

    validation_passed: true,
    validation_errors: [],

    regime,
    alerts,

    stats: {
      lookback_minutes: req.lookback_minutes,
      minimum_notional_usd: req.minimum_notional_usd,
      alerts_count: alerts.length,
      data_freshness_seconds: 60,
      coverage: ["resources/base-gas-profile"]
    },

    watchlist_summary,
    evidence,
    timestamp_utc: timestamp
  };
}

/* -------------------------------------------------------------------------- */
/*                             Job Dispatcher                                 */
/* -------------------------------------------------------------------------- */

async function buildDeliverableForJob(jobName, requirement) {
  switch (jobName) {
    case "pre_trade_risk_pack": {
      const val = validatePreTradeRiskPack(requirement || {});
      return buildPreTradeRiskPackDeliverable(requirement || {}, val);
    }
    case "execution_quote_and_route": {
      const val = validateExecutionQuoteAndRoute(requirement || {});
      return buildExecutionQuoteAndRouteDeliverable(requirement || {}, val);
    }
    case "market_intelligence_feed": {
      const val = validateMarketIntel(requirement || {});
      return buildMarketIntelDeliverable(requirement || {}, val);
    }
    default: {
      return {
        job_name: jobName || "unknown",
        agent_version: AGENT_VERSION,
        chain: ACP_CHAIN,
        validation_passed: false,
        validation_errors: ["Unknown or unsupported job_name."],
        error: true,
        message:
          "Unsupported job. Use: pre_trade_risk_pack, execution_quote_and_route, market_intelligence_feed",
        timestamp_utc: nowIso()
      };
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Main Logic                                 */
/* -------------------------------------------------------------------------- */

async function main() {
  const privateKey = process.env.WHITELISTED_WALLET_PRIVATE_KEY;
  const sellerEntityId = process.env.SELLER_ENTITY_ID;
  const sellerWalletAddress = process.env.SELLER_AGENT_WALLET_ADDRESS;

  if (!privateKey || !sellerEntityId || !sellerWalletAddress) {
    throw new Error(
      "Missing env vars. Required: WHITELISTED_WALLET_PRIVATE_KEY, SELLER_ENTITY_ID, SELLER_AGENT_WALLET_ADDRESS"
    );
  }

  console.log("🔑 Seller Entity:", sellerEntityId);
  console.log("👛 Seller Wallet:", sellerWalletAddress);
  console.log("🧠 Agent Version:", AGENT_VERSION);
  console.log("🌐 ACP_CHAIN:", ACP_CHAIN);
  console.log("🧩 Resources Base URL:", RESOURCES_BASE_URL);

  // V2 config selection
  const acpConfig =
    ACP_CHAIN === "base-sepolia" ? baseSepoliaAcpConfigV2 : baseAcpConfigV2;

  // Optional RPC override
  const rpcUrl = process.env.CUSTOM_RPC_URL || undefined;

  // ✅ Use AcpContractClientV2
  const acpContractClient = await AcpContractClientV2.build(
    privateKey,
    sellerEntityId,
    sellerWalletAddress,
    rpcUrl,
    acpConfig
  );

  const acpClient = new AcpClient({
    acpContractClient,

    /**
     * onNewTask(job, memoToSign)
     * Handles negotiation (nextPhase=1) and delivery (nextPhase=3).
     */
    onNewTask: async (job, memoToSign) => {
      console.log("🟢 New job received:", job.id);
      console.log("📌 Job phase:", job.phase);

      if (!memoToSign || memoToSign.status !== "PENDING") {
        console.log("⚪ No pending memo to act on.");
        return;
      }

      // Phase 0 -> 1: Accept/reject and cache requirement
      if (memoToSign.nextPhase === 1) {
        let jobName = "unknown";
        let requirement = {};

        if (isObj(memoToSign.structuredContent)) {
          jobName = memoToSign.structuredContent.name || jobName;
          requirement = memoToSign.structuredContent.requirement || {};
        } else if (isObj(job.input)) {
          jobName = job.input.name || jobName;
          requirement = job.input.requirement || job.input;
        }

        // Normalize chain if missing
        if (!requirement.chain) requirement.chain = ACP_CHAIN;

        // Cache for delivery phase
        jobCache.set(job.id, { jobName, requirement });

        console.log("📛 Cached job_name:", jobName);
        console.log("📦 Cached requirement:", requirement);

        console.log("🤝 Accepting job...");
        await job.respond(true, "Accepted by AegisAI — deep analysis will be produced at delivery.");
        console.log("✅ Job accepted:", job.id);
        return;
      }

      // Phase 2 -> 3: Deliver result
      if (memoToSign.nextPhase === 3) {
        console.log("📦 Preparing deliverable...");

        const cached = jobCache.get(job.id) || {};
        const jobName = cached.jobName || "unknown";
        const requirement = cached.requirement || {};

        console.log("📛 Job type:", jobName);
        console.log("📦 Requirement:", requirement);

        const deliverable = await buildDeliverableForJob(jobName, requirement);

        console.log("📤 Deliverable built:", deliverable);

        await job.deliver(deliverable);
        console.log("✅ Job delivered:", job.id);
        return;
      }

      console.log("⚪ Memo nextPhase not handled:", memoToSign.nextPhase);
    },

    onEvaluate: async (job) => {
      console.log("📊 onEvaluate fired for job:", job.id, "phase:", job.phase);
    }
  });

  console.log("🚀 Initializing ACP client...");
  if (typeof acpClient.init === "function") {
    await acpClient.init();
  }
  console.log("🟢 ACP client initialized. Waiting for jobs...");

  setInterval(() => {
    console.log("⏱ Heartbeat: provider is still running...");
  }, 60000);
}

main().catch((err) => {
  console.error("❌ ERROR:", err);
  process.exit(1);
});
