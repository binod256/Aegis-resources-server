"use strict";

require("dotenv").config();

const AcpClientModule = require("@virtuals-protocol/acp-node");
const AcpClient = AcpClientModule.default;
// ⬇️ use V2 client
const { AcpContractClientV2 } = AcpClientModule;

// In-memory cache to remember job type + requirement between phases
const jobCache = new Map();

/* -------------------------------------------------------------------------- */
/*                               Validation Utils                             */
/* -------------------------------------------------------------------------- */

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isPositiveNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isNonNegativeNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isAddressLike(v) {
  return typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v.trim());
}

function oneOf(v, allowed) {
  return allowed.includes(v);
}

function pushErr(errors, field, message) {
  errors.push(`${field}: ${message}`);
}

function severityWeight(sev) {
  switch (sev) {
    case "critical":
      return 5;
    case "high":
      return 4;
    case "medium":
      return 3;
    case "low":
      return 2;
    case "info":
      return 1;
    default:
      return 0;
  }
}

/* -------------------------------------------------------------------------- */
/*                       Job-specific Validation + Logic                      */
/* -------------------------------------------------------------------------- */

/**
 * 1) risk_sentinel
 * Requirements:
 *  - client_agent_id: string
 *  - asset_pair: string
 *  - side: one of buy/sell/long/short
 *  - notional_value_usd: number > 0
 *  - execution_venue: string
 *  - chain: string, from a small whitelist
 *  - leverage: number >= 1
 */
function validateRiskSentinel(req) {
  const errors = [];

  if (!isNonEmptyString(req.client_agent_id)) {
    pushErr(errors, "client_agent_id", "must be a non-empty string");
  }
  if (!isNonEmptyString(req.asset_pair)) {
    pushErr(errors, "asset_pair", "must be a non-empty string like 'USDC/WETH'");
  }
  if (!isNonEmptyString(req.side) || !oneOf(req.side, ["buy", "sell", "long", "short"])) {
    pushErr(errors, "side", "must be one of 'buy', 'sell', 'long', 'short'");
  }
  if (!isPositiveNumber(req.notional_value_usd)) {
    pushErr(errors, "notional_value_usd", "must be a positive number in USD");
  }
  if (!isNonEmptyString(req.execution_venue)) {
    pushErr(errors, "execution_venue", "must be a non-empty string (e.g. 'uniswap_v3')");
  }
  const allowedChains = ["base", "ethereum-mainnet", "arbitrum", "optimism", "polygon"];
  if (!isNonEmptyString(req.chain) || !allowedChains.includes(req.chain)) {
    pushErr(
      errors,
      "chain",
      `must be one of: ${allowedChains.join(", ")}`
    );
  }
  if (!isPositiveNumber(req.leverage) || req.leverage < 1) {
    pushErr(errors, "leverage", "must be >= 1 (use 1 for spot/no leverage)");
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function buildRiskSentinelDeliverable(req, validation) {
  const timestamp = new Date().toISOString();

  if (!validation.ok) {
    return {
      job_name: "risk_sentinel",
      decision: "reject",
      risk_score: 0,
      recommended_size_factor: 0,
      validation_passed: false,
      validation_errors: validation.errors,
      findings: [
        {
          id: "invalid_input",
          severity: "critical",
          description:
            "The request parameters did not pass strict validation. See validation_errors for details.",
          mitigation: "Correct the invalid fields and re-submit the risk_sentinel job."
        }
      ],
      // 🔍 New fields
      summary: {
        overall_risk_level: "invalid",
        reason: "Input validation failed; no risk evaluation performed."
      },
      methodology:
        "Pre-trade risk evaluation was not performed because one or more required fields were invalid.",
      coverage: {
        schema_validation: { checked: true, triggered: true },
        chain_whitelist: { checked: true, triggered: false },
        leverage_bounds: { checked: true, triggered: false },
        notional_bounds: { checked: true, triggered: false }
      },
      remediation_plan: [
        {
          id: "fix_invalid_fields",
          priority: 1,
          severity: "critical",
          action:
            "Review validation_errors, correct invalid or missing parameters, and re-run the risk_sentinel job."
        }
      ],
      open_questions: [
        "Is the calling client_agent_id correctly configured and authorized for this agent?",
        "Are you certain the intended chain and venue are supported for execution?"
      ],
      timestamp_utc: timestamp
    };
  }

  // Simple heuristic scoring: higher notional + leverage => higher risk
  const baseScore = 20;
  const leverageImpact = (req.leverage - 1) * 10;
  const sizeImpact = Math.min(req.notional_value_usd / 100000, 3) * 10; // up to +30
  const riskScore = Math.min(100, Math.round(baseScore + leverageImpact + sizeImpact));

  let decision = "approve";
  let sizeFactor = 1;

  if (riskScore >= 80) {
    decision = "reject";
    sizeFactor = 0;
  } else if (riskScore >= 60) {
    decision = "reduce";
    sizeFactor = 0.5;
  }

  const severity =
    riskScore >= 80 ? "high" :
    riskScore >= 60 ? "high" :
    riskScore >= 40 ? "medium" :
    "low";

  const summary = {
    asset_pair: req.asset_pair,
    side: req.side,
    chain: req.chain,
    leverage: req.leverage,
    notional_value_usd: req.notional_value_usd,
    overall_risk_level: severity,
    risk_score: riskScore,
    decision,
    recommended_size_factor: sizeFactor,
    execution_venue: req.execution_venue
  };

  const methodology =
    "Heuristic pre-trade risk model combining notional size, leverage, chain characteristics and execution venue. This is not a VaR engine or regulatory capital model.";

  const coverage = {
    schema_validation: { checked: true, triggered: false },
    chain_whitelist: { checked: true, triggered: false },
    leverage_bounds: { checked: true, triggered: req.leverage > 3 },
    notional_bounds: { checked: true, triggered: req.notional_value_usd > 500000 },
    side_supported: { checked: true, triggered: false }
  };

  const remediation_plan = [];

  if (decision !== "approve") {
    remediation_plan.push({
      id: "reduce_notional",
      priority: 1,
      severity: "high",
      action:
        "Reduce notional_value_usd and/or leverage and re-run risk evaluation to move into an acceptable risk band."
    });
  }

  remediation_plan.push({
    id: "diversify_exposure",
    priority: remediation_plan.length + 1,
    severity: "medium",
    action:
      "Consider spreading exposure across time or venues instead of concentrating in a single large trade."
  });

  const open_questions = [
    "How does this position relate to the client's existing portfolio and concentration limits?",
    "Is this trade part of a larger strategy (e.g., hedging, basis trade, yield enhancement) that alters its effective risk?",
    "What is the maximum acceptable drawdown or liquidation risk for this specific client?"
  ];

  return {
    job_name: "risk_sentinel",
    decision,
    risk_score: riskScore,
    recommended_size_factor: sizeFactor,
    validation_passed: true,
    validation_errors: [],
    findings: [
      {
        id: "base_risk_sentinel_eval",
        severity,
        description:
          "Pre-trade risk analysis based on notional size, leverage, chain and venue, classified into an overall risk level.",
        mitigation:
          decision === "approve"
            ? "Proceed with standard risk controls and monitoring."
            : decision === "reduce"
            ? "Lower position size or leverage and re-submit to fit within defined risk appetite."
            : "Avoid opening this position under current parameters or require explicit risk sign-off."
      }
    ],
    summary,
    methodology,
    coverage,
    remediation_plan,
    open_questions,
    timestamp_utc: timestamp
  };
}

/**
 * 2) gas_execution_optimizer
 * Requirements:
 *  - client_agent_id: string
 *  - chain: string
 *  - transaction_type: one of swap/liquidity_add/rebalance/leverage_open
 *  - urgency: low/normal/high
 *  - expected_notional_usd: number > 0
 *  - current_gas_price_wei: number >= 0
 */
function validateGasExecution(req) {
  const errors = [];

  if (!isNonEmptyString(req.client_agent_id)) {
    pushErr(errors, "client_agent_id", "must be a non-empty string");
  }
  if (!isNonEmptyString(req.chain)) {
    pushErr(errors, "chain", "must be a non-empty string");
  }

  const allowedTxTypes = ["swap", "liquidity_add", "rebalance", "leverage_open"];
  if (!isNonEmptyString(req.transaction_type) || !allowedTxTypes.includes(req.transaction_type)) {
    pushErr(
      errors,
      "transaction_type",
      `must be one of ${allowedTxTypes.join(", ")}`
    );
  }

  const allowedUrgency = ["low", "normal", "high"];
  if (!isNonEmptyString(req.urgency) || !allowedUrgency.includes(req.urgency)) {
    pushErr(errors, "urgency", `must be one of ${allowedUrgency.join(", ")}`);
  }

  if (!isPositiveNumber(req.expected_notional_usd)) {
    pushErr(errors, "expected_notional_usd", "must be a positive number");
  }

  if (!isNonNegativeNumber(req.current_gas_price_wei)) {
    pushErr(errors, "current_gas_price_wei", "must be a non-negative number (0 allowed for unknown)");
  }

  return { ok: errors.length === 0, errors };
}

function buildGasExecutionDeliverable(req, validation) {
  const timestamp = new Date().toISOString();

  if (!validation.ok) {
    return {
      job_name: "gas_execution_optimizer",
      validation_passed: false,
      validation_errors: validation.errors,
      recommended_gas_price_wei: null,
      suggested_priority: null,
      notes: "Request did not pass validation. See validation_errors.",
      summary: {
        overall_status: "invalid",
        reason: "Input validation failed; no gas recommendation produced."
      },
      methodology:
        "Gas optimization was not performed due to invalid or missing parameters.",
      coverage: {
        schema_validation: { checked: true, triggered: true },
        urgency_adjustment: { checked: false, triggered: false },
        baseline_present: { checked: false, triggered: false }
      },
      open_questions: [
        "Is the provided chain identifier consistent with the execution environment?",
        "Can you supply a recent baseline gas price snapshot from your infra?"
      ],
      timestamp_utc: timestamp
    };
  }

  // Simple gas heuristic
  let baseGas = req.current_gas_price_wei;
  if (!isPositiveNumber(baseGas)) {
    // default gas estimate if not provided (~20 gwei)
    const defaultWei = 20n * 10n ** 9n;
    baseGas = Number(defaultWei);
  }

  let multiplier = 1.0;
  if (req.urgency === "low") multiplier = 0.9;
  if (req.urgency === "high") multiplier = 1.2;

  const recommendedGas = Math.round(baseGas * multiplier);

  const summary = {
    chain: req.chain,
    transaction_type: req.transaction_type,
    urgency: req.urgency,
    expected_notional_usd: req.expected_notional_usd,
    baseline_gas_price_wei: baseGas,
    recommended_gas_price_wei: recommendedGas
  };

  const methodology =
    "Heuristic gas recommendation based on a baseline gas value and urgency multiplier. It does not inspect mempool or use live gas auction data.";

  const coverage = {
    schema_validation: { checked: true, triggered: false },
    urgency_adjustment: { checked: true, triggered: req.urgency !== "normal" },
    baseline_present: { checked: true, triggered: isPositiveNumber(req.current_gas_price_wei) }
  };

  const open_questions = [
    "Do you have max-fee and max-priority-fee constraints that should bound this recommendation?",
    "Should large notional or critical operations (e.g., governance actions) receive a higher default gas multiplier?"
  ];

  return {
    job_name: "gas_execution_optimizer",
    validation_passed: true,
    validation_errors: [],
    recommended_gas_price_wei: recommendedGas,
    suggested_priority: req.urgency,
    notes:
      "Gas recommendation based on urgency and provided baseline. This is a heuristic, not a guarantee of inclusion.",
    summary,
    methodology,
    coverage,
    open_questions,
    timestamp_utc: timestamp
  };
}

/**
 * 3) strategy_safety_audit
 * Requirements:
 *  - client_agent_id: string
 *  - strategy_name: string
 *  - chain: string
 *  - strategy_description: string
 *  - contracts_involved: array of strings (addresses or identifiers)
 *  - max_leverage: number >= 1
 *  - target_yield_apy: number >= 0
 */
function validateStrategyAudit(req) {
  const errors = [];

  if (!isNonEmptyString(req.client_agent_id)) {
    pushErr(errors, "client_agent_id", "must be a non-empty string");
  }
  if (!isNonEmptyString(req.strategy_name)) {
    pushErr(errors, "strategy_name", "must be a non-empty string");
  }
  if (!isNonEmptyString(req.chain)) {
    pushErr(errors, "chain", "must be a non-empty string");
  }
  if (!isNonEmptyString(req.strategy_description)) {
    pushErr(errors, "strategy_description", "must be a non-empty description of the strategy");
  }

  if (!Array.isArray(req.contracts_involved) || req.contracts_involved.length === 0) {
    pushErr(
      errors,
      "contracts_involved",
      "must be a non-empty array of contract addresses or identifiers"
    );
  } else {
    req.contracts_involved.forEach((c, idx) => {
      if (!isNonEmptyString(c)) {
        pushErr(errors, `contracts_involved[${idx}]`, "must be a non-empty string");
      }
    });
  }

  if (!isPositiveNumber(req.max_leverage) || req.max_leverage < 1) {
    pushErr(errors, "max_leverage", "must be >= 1");
  }

  if (!isNonNegativeNumber(req.target_yield_apy)) {
    pushErr(errors, "target_yield_apy", "must be a non-negative number (percent APY)");
  }

  return { ok: errors.length === 0, errors };
}

function buildStrategyAuditDeliverable(req, validation) {
  const timestamp = new Date().toISOString();

  if (!validation.ok) {
    return {
      job_name: "strategy_safety_audit",
      validation_passed: false,
      validation_errors: validation.errors,
      risk_rating: "invalid",
      issues: [
        {
          id: "invalid_input",
          severity: "critical",
          description:
            "The strategy description or parameters were invalid. See validation_errors.",
          mitigation: "Correct the invalid fields and re-run the safety audit."
        }
      ],
      checklist: [],
      summary: {
        overall_risk_level: "invalid",
        reason: "Input validation failed; no safety analysis performed."
      },
      methodology:
        "Strategy risk assessment was skipped because the basic structural requirements for the job were not satisfied.",
      coverage: {
        schema_validation: { checked: true, triggered: true },
        leverage_analysis: { checked: false, triggered: false },
        yield_sanity_check: { checked: false, triggered: false },
        contract_enumeration: { checked: false, triggered: false }
      },
      remediation_plan: [
        {
          id: "fix_strategy_input",
          priority: 1,
          severity: "critical",
          action:
            "Review validation_errors, complete missing fields such as contracts_involved and strategy_description, then re-run the audit."
        }
      ],
      open_questions: [
        "Is there a reference implementation or architecture diagram for this strategy?",
        "Has this strategy been tested in a paper-trading or sandbox environment before real funds?"
      ],
      timestamp_utc: timestamp
    };
  }

  // Heuristic risk rating & scoring
  let risk = "low";
  let riskScore = 20;

  if (req.max_leverage > 2 || req.target_yield_apy > 20) {
    risk = "medium";
    riskScore += 20;
  }
  if (req.max_leverage > 3 || req.target_yield_apy > 40) {
    risk = "high";
    riskScore += 30;
  }
  riskScore = Math.min(100, riskScore + Math.min(req.contracts_involved.length * 5, 20));

  const issues = [];

  if (req.max_leverage > 2) {
    issues.push({
      id: "leverage_exposure",
      severity: req.max_leverage > 3 ? "high" : "medium",
      description:
        "Strategy uses elevated leverage, increasing liquidation and volatility risk.",
      mitigation: "Consider lowering max_leverage or adding stricter health factor constraints."
    });
  }

  if (req.target_yield_apy > 30) {
    issues.push({
      id: "yield_expectations",
      severity: "medium",
      description:
        "Target APY is unusually high, which can indicate hidden risk, unsustainable emissions, or smart contract risk.",
      mitigation:
        "Stress-test the strategy under adverse scenarios and do independent contract audits for all protocols involved."
    });
  }

  const summary = {
    strategy_name: req.strategy_name,
    chain: req.chain,
    contracts_involved_count: req.contracts_involved.length,
    max_leverage: req.max_leverage,
    target_yield_apy: req.target_yield_apy,
    overall_risk_level: risk,
    risk_score: riskScore
  };

  const methodology =
    "Heuristic strategy safety assessment based on leverage, target yield, protocol fan-out and qualitative red flags. It does not simulate market scenarios or inspect on-chain code directly.";

  const coverage = {
    schema_validation: { checked: true, triggered: false },
    leverage_analysis: { checked: true, triggered: req.max_leverage > 2 },
    yield_sanity_check: { checked: true, triggered: req.target_yield_apy > 30 },
    contract_enumeration: {
      checked: true,
      triggered: req.contracts_involved.length > 3
    }
  };

  const remediation_plan = [];

  if (risk !== "low") {
    remediation_plan.push({
      id: "reduce_leverage_or_yield",
      priority: 1,
      severity: "high",
      action:
        "Lower max_leverage and/or target_yield_apy to align with tested, sustainable levels."
    });
  }

  remediation_plan.push({
    id: "audit_protocols",
    priority: remediation_plan.length + 1,
    severity: "medium",
    action:
      "Ensure that all contracts_involved have up-to-date security audits and clearly documented upgrade/governance processes."
  });

  const open_questions = [
    "What are the maximum acceptable drawdown and liquidation scenarios envisioned for this strategy?",
    "How correlated are the underlying protocols and assets during stress events?",
    "Is there a clear exit or unwind procedure if one of the core protocols becomes impaired?"
  ];

  return {
    job_name: "strategy_safety_audit",
    validation_passed: true,
    validation_errors: [],
    risk_rating: risk,
    issues,
    checklist: [
      "Confirm protocol audit status for all contracts_involved.",
      "Test liquidation behavior under extreme volatility.",
      "Verify oracle sources and price feeds.",
      "Simulate gas and slippage under peak network load."
    ],
    summary,
    methodology,
    coverage,
    remediation_plan,
    open_questions,
    timestamp_utc: timestamp
  };
}

/**
 * 4) market_intelligence_feed
 * Requirements:
 *  - client_agent_id: string
 *  - chain: string
 *  - lookback_minutes: number > 0
 *  - minimum_notional_usd: number > 0
 *  - focus_assets: optional array of strings
 */
function validateMarketIntel(req) {
  const errors = [];

  if (!isNonEmptyString(req.client_agent_id)) {
    pushErr(errors, "client_agent_id", "must be a non-empty string");
  }
  if (!isNonEmptyString(req.chain)) {
    pushErr(errors, "chain", "must be a non-empty string");
  }
  if (!isPositiveNumber(req.lookback_minutes)) {
    pushErr(errors, "lookback_minutes", "must be a positive number");
  }
  if (!isPositiveNumber(req.minimum_notional_usd)) {
    pushErr(errors, "minimum_notional_usd", "must be a positive number");
  }
  if (req.focus_assets != null) {
    if (!Array.isArray(req.focus_assets)) {
      pushErr(errors, "focus_assets", "must be an array of strings if provided");
    } else {
      req.focus_assets.forEach((a, idx) => {
        if (!isNonEmptyString(a)) {
          pushErr(errors, `focus_assets[${idx}]`, "must be a non-empty string");
        }
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

function buildMarketIntelDeliverable(req, validation) {
  const timestamp = new Date().toISOString();

  const focus = Array.isArray(req.focus_assets) && req.focus_assets.length > 0
    ? req.focus_assets
    : ["ALL"];

  if (!validation.ok) {
    return {
      job_name: "market_intelligence_feed",
      validation_passed: false,
      validation_errors: validation.errors,
      signals: [],
      stats: {
        events_considered: 0,
        focus_assets_count: Array.isArray(req.focus_assets) ? req.focus_assets.length : 0,
        lookback_minutes: req.lookback_minutes || 0,
        minimum_notional_usd: req.minimum_notional_usd || 0
      },
      summary: {
        chain: req.chain || null,
        focus_assets: focus,
        overall_status: "invalid"
      },
      methodology:
        "No chain data was scanned because the request parameters failed validation.",
      open_questions: [
        "Which specific assets or protocols are you most interested in monitoring for large flows?",
        "Do you have thresholds for when a signal should trigger automated or manual action?"
      ],
      timestamp_utc: timestamp
    };
  }

  // Synthetic example signals (no real chain data here)
  const signals = [
    {
      id: "sample_flow_1",
      severity: "info",
      description:
        "Synthetic example: large swap activity observed in the focus universe during the lookback window.",
      notional_usd: req.minimum_notional_usd * 3,
      chain: req.chain
    }
  ];

  const stats = {
    events_considered: 42,
    focus_assets_count: focus.length,
    lookback_minutes: req.lookback_minutes,
    minimum_notional_usd: req.minimum_notional_usd
  };

  const summary = {
    chain: req.chain,
    focus_assets: focus,
    lookback_minutes: req.lookback_minutes,
    minimum_notional_usd: req.minimum_notional_usd,
    signals_count: signals.length
  };

  const methodology =
    "Synthetic market intelligence feed illustrating how large-flow signals would be structured. In a production deployment, this would be wired to on-chain data and custom filters.";

  const open_questions = [
    "Should signals be bucketed by venue (e.g., AMM vs orderbook) or by protocol risk tier?",
    "Do you want separate thresholds for buy vs sell pressure, or a single threshold for absolute flow?",
    "Should follow-up jobs (e.g., risk_sentinel) be triggered automatically when certain signals fire?"
  ];

  return {
    job_name: "market_intelligence_feed",
    validation_passed: true,
    validation_errors: [],
    signals,
    stats,
    summary,
    methodology,
    open_questions,
    timestamp_utc: timestamp
  };
}

/**
 * 5) portfolio_rebalancer
 * Requirements:
 *  - client_agent_id: string
 *  - chain: string
 *  - current_positions: array of { asset: string, amount: >0, notional_usd: >0 }
 *  - risk_tolerance: conservative/moderate/aggressive
 *  - target_objective: maximize_yield/preserve_capital/balanced
 */
function validatePortfolioRebalancer(req) {
  const errors = [];

  if (!isNonEmptyString(req.client_agent_id)) {
    pushErr(errors, "client_agent_id", "must be a non-empty string");
  }
  if (!isNonEmptyString(req.chain)) {
    pushErr(errors, "chain", "must be a non-empty string");
  }

  if (!Array.isArray(req.current_positions) || req.current_positions.length === 0) {
    pushErr(
      errors,
      "current_positions",
      "must be a non-empty array of { asset, amount, notional_usd } objects"
    );
  } else {
    req.current_positions.forEach((p, idx) => {
      if (!p || typeof p !== "object") {
        pushErr(errors, `current_positions[${idx}]`, "must be an object");
        return;
      }
      if (!isNonEmptyString(p.asset)) {
        pushErr(errors, `current_positions[${idx}].asset`, "must be a non-empty string");
      }
      if (!isPositiveNumber(p.amount)) {
        pushErr(errors, `current_positions[${idx}].amount`, "must be a positive number");
      }
      if (!isPositiveNumber(p.notional_usd)) {
        pushErr(errors, `current_positions[${idx}].notional_usd`, "must be a positive number");
      }
    });
  }

  const allowedRisk = ["conservative", "moderate", "aggressive"];
  if (!isNonEmptyString(req.risk_tolerance) || !allowedRisk.includes(req.risk_tolerance)) {
    pushErr(
      errors,
      "risk_tolerance",
      `must be one of ${allowedRisk.join(", ")}`
    );
  }

  const allowedObj = ["maximize_yield", "preserve_capital", "balanced"];
  if (!isNonEmptyString(req.target_objective) || !allowedObj.includes(req.target_objective)) {
    pushErr(
      errors,
      "target_objective",
      `must be one of ${allowedObj.join(", ")}`
    );
  }

  return { ok: errors.length === 0, errors };
}

function buildPortfolioRebalancerDeliverable(req, validation) {
  const timestamp = new Date().toISOString();

  if (!validation.ok) {
    return {
      job_name: "portfolio_rebalancer",
      validation_passed: false,
      validation_errors: validation.errors,
      recommended_trades: [],
      risk_summary: {
        total_notional_usd: 0,
        comment: "Validation failed. No rebalance recommendations generated."
      },
      resulting_allocations: [],
      summary: {
        overall_status: "invalid",
        reason: "Input validation failed; portfolio was not analyzed."
      },
      methodology:
        "Portfolio analysis was not performed due to missing or invalid current_positions or risk parameters.",
      open_questions: [
        "Can you provide a complete, up-to-date snapshot of the portfolio, including all positions and cash?",
        "What drawdown or volatility limits define success for this portfolio?"
      ],
      timestamp_utc: timestamp
    };
  }

  const total = req.current_positions.reduce((sum, p) => sum + p.notional_usd, 0);
  const recommended_trades = [];

  const stableSymbols = ["USDC", "USDT", "DAI"];
  const stableValue = req.current_positions
    .filter(p => stableSymbols.includes(p.asset.toUpperCase()))
    .reduce((s, p) => s + p.notional_usd, 0);

  // Very simple heuristic: if aggressive + lots of stable, recommend rotating
  if (req.risk_tolerance === "aggressive" && total > 0) {
    const stableRatio = stableValue / total;
    if (stableRatio > 0.4) {
      recommended_trades.push({
        action: "rotate_out_of_stables",
        description:
          "Portfolio appears too stable-heavy for an aggressive profile. Suggest rotating a portion into higher-beta assets.",
        suggested_notional_to_rotate_usd: Math.round(stableValue * 0.3)
      });
    }
  }

  const resulting_allocations = req.current_positions.map(p => ({
    asset: p.asset,
    notional_usd: p.notional_usd,
    weight_pct: (p.notional_usd / total) * 100
  }));

  const risk_summary = {
    total_notional_usd: total,
    comment:
      "Rebalance suggestions are heuristic only. Validate with your own risk framework before execution."
  };

  const summary = {
    chain: req.chain,
    risk_tolerance: req.risk_tolerance,
    target_objective: req.target_objective,
    total_notional_usd: total,
    stable_value_usd: stableValue,
    stable_ratio: total > 0 ? stableValue / total : 0,
    recommended_trades_count: recommended_trades.length
  };

  const methodology =
    "Heuristic allocation review using current notional weights, risk tolerance and objective. It does not consider asset correlations, tax implications or protocol-specific risks.";

  const open_questions = [
    "Are there concentration limits per asset or protocol that should constrain rebalancing suggestions?",
    "Do you have liquidity constraints or on-chain slippage limits that must be respected when rotating out of stablecoins?",
    "Is there a required minimum cash or stable buffer for withdrawals or margin calls?"
  ];

  return {
    job_name: "portfolio_rebalancer",
    validation_passed: true,
    validation_errors: [],
    recommended_trades,
    risk_summary,
    resulting_allocations,
    summary,
    methodology,
    open_questions,
    timestamp_utc: timestamp
  };
}

/* -------------------------------------------------------------------------- */
/*                               Job Dispatcher                               */
/* -------------------------------------------------------------------------- */

function buildDeliverableForJob(jobName, requirement) {
  switch (jobName) {
    case "risk_sentinel": {
      const val = validateRiskSentinel(requirement || {});
      return buildRiskSentinelDeliverable(requirement || {}, val);
    }
    case "gas_execution_optimizer": {
      const val = validateGasExecution(requirement || {});
      return buildGasExecutionDeliverable(requirement || {}, val);
    }
    case "strategy_safety_audit": {
      const val = validateStrategyAudit(requirement || {});
      return buildStrategyAuditDeliverable(requirement || {}, val);
    }
    case "market_intelligence_feed": {
      const val = validateMarketIntel(requirement || {});
      return buildMarketIntelDeliverable(requirement || {}, val);
    }
    case "portfolio_rebalancer": {
      const val = validatePortfolioRebalancer(requirement || {});
      return buildPortfolioRebalancerDeliverable(requirement || {}, val);
    }
    default: {
      const timestamp = new Date().toISOString();
      return {
        job_name: jobName || "unknown",
        validation_passed: false,
        validation_errors: ["Unknown or unsupported job_name."],
        error: true,
        message:
          "The provider could not match this job to a known offering. Please ensure you're using one of the supported jobs for this agent.",
        summary: {
          overall_status: "unsupported_job",
          job_name: jobName || "unknown"
        },
        timestamp_utc: timestamp
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
      "Missing environment variables. Check .env: WHITELISTED_WALLET_PRIVATE_KEY, SELLER_ENTITY_ID, SELLER_AGENT_WALLET_ADDRESS"
    );
  }

  console.log("🔑 Seller Entity:", sellerEntityId);
  console.log("👛 Seller Wallet:", sellerWalletAddress);

  // ⬇️ Use AcpContractClientV2
  const acpContractClient = await AcpContractClientV2.build(
    privateKey,
    sellerEntityId,
    sellerWalletAddress,
    process.env.CUSTOM_RPC_URL || undefined,
    undefined
  );

  const acpClient = new AcpClient({
    acpContractClient,

    /**
     * onNewTask(job, memoToSign)
     * Handles both negotiation and delivery phases via memoToSign.nextPhase.
     */
    onNewTask: async (job, memoToSign) => {
      console.log("🟢 New job received:", job.id);
      console.log("📌 Job phase:", job.phase);
      if (job.input) {
        try {
          const keys = Object.keys(job.input || {});
          console.log("📥 Job input keys:", keys);
          console.log("📥 Job input full:", job.input);
        } catch {
          console.log("📥 Job input: (could not stringify)");
        }
      } else {
        console.log("📥 Job input: undefined");
      }

      console.log("📝 Memo to sign:", memoToSign);

      if (!memoToSign || memoToSign.status !== "PENDING") {
        console.log("⚪ No pending memo to act on.");
        return;
      }

      // Phase 0 -> 1: Accept or reject
      if (memoToSign.nextPhase === 1) {
        let jobName = "unknown";
        let requirement = {};

        if (memoToSign.structuredContent && typeof memoToSign.structuredContent === "object") {
          jobName = memoToSign.structuredContent.name || jobName;
          requirement = memoToSign.structuredContent.requirement || {};
        } else if (job.input && typeof job.input === "object") {
          // fallback: maybe job.input has { name, requirement }
          jobName = job.input.name || jobName;
          requirement = job.input.requirement || job.input;
        }

        console.log("📛 Inferred job_name at negotiation:", jobName);
        console.log("📦 Cached requirement for job:", requirement);

        // Cache for later delivery phase
        jobCache.set(job.id, {
          jobName,
          requirement
        });

        console.log("🤝 Responding to job (accepting)...");
        await job.respond(
          true,
          "Accepted by AegisAI provider — validation and risk logic will be applied at delivery."
        );
        console.log("✅ Job accepted:", job.id);
        return;
      }

      // Phase 2 -> 3: Deliver result
      if (memoToSign.nextPhase === 3) {
        console.log("📦 Preparing deliverable for job...");

        const cached = jobCache.get(job.id) || {};
        const jobName = cached.jobName || "unknown";
        const requirement = cached.requirement || {};

        console.log("📛 Job type (from cache):", jobName);
        console.log("📦 Requirement (from cache):", requirement);

        const deliverable = buildDeliverableForJob(jobName, requirement);

        console.log("📤 Deliverable built:", deliverable);

        await job.deliver(deliverable);
        console.log("✅ Job delivered:", job.id);
        return;
      }

      console.log(
        "⚪ Memo nextPhase not handled in this script:",
        memoToSign.nextPhase
      );
    },

    onEvaluate: async (job) => {
      console.log("📊 onEvaluate fired for job:", job.id, "phase:", job.phase);
      // This provider is not acting as an evaluator; simply acknowledge.
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
