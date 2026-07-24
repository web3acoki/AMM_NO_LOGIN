export type BatchTransferMode = 'oneToMany' | 'manyToOne' | 'manyToMany';
export type BatchTransferTokenType = 'native' | 'token' | 'aster';

export type RetryableBatchTransferResult = {
  source?: string;
  target?: string;
  _tokenType?: BatchTransferTokenType;
  _transferMode?: BatchTransferMode;
  [key: string]: unknown;
};

export type BatchTransferRetryPlan = {
  tokenType: BatchTransferTokenType;
  mode: BatchTransferMode;
  sourceAddresses: string[];
  targetAddresses: string[];
  results: RetryableBatchTransferResult[];
};

type RetryPlanFallback = {
  tokenType: BatchTransferTokenType;
  mode: BatchTransferMode;
};

function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  return addresses.filter((address) => {
    const normalized = address.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/**
 * Preserve the payment shape that produced each failed result.
 *
 * A single remaining source does not imply one-to-many: it can also be a
 * partial retry from many-to-one or many-to-many. Inferring the mode from the
 * number of failed sources would change both ownership rules and pairing.
 */
export function buildBatchTransferRetryPlans(
  results: RetryableBatchTransferResult[],
  fallback: RetryPlanFallback,
): BatchTransferRetryPlan[] {
  const groups = new Map<string, {
    tokenType: BatchTransferTokenType;
    mode: BatchTransferMode;
    results: RetryableBatchTransferResult[];
  }>();

  for (const result of results) {
    const tokenType = result._tokenType ?? fallback.tokenType;
    const mode = result._transferMode ?? fallback.mode;
    const key = `${tokenType}:${mode}`;
    const group = groups.get(key) ?? { tokenType, mode, results: [] };
    group.results.push(result);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const pairs = group.results
      .filter((result): result is RetryableBatchTransferResult & { source: string; target: string } => (
        typeof result.source === 'string' &&
        result.source.length > 0 &&
        typeof result.target === 'string' &&
        result.target.length > 0
      ));
    const sources = pairs.map(result => result.source);
    const targets = pairs.map(result => result.target);

    if (group.mode === 'oneToMany') {
      const uniqueSources = uniqueAddresses(sources);
      if (uniqueSources.length !== 1) {
        throw new Error('一对多重试数据包含多个源钱包，已停止重试以避免改变原始付款关系');
      }
      return {
        tokenType: group.tokenType,
        mode: group.mode,
        sourceAddresses: uniqueSources,
        targetAddresses: targets,
        results: pairs,
      };
    }

    if (group.mode === 'manyToOne') {
      const uniqueTargets = uniqueAddresses(targets);
      if (uniqueTargets.length !== 1) {
        throw new Error('多对一重试数据包含多个目标钱包，已停止重试以避免改变原始付款关系');
      }
      return {
        tokenType: group.tokenType,
        mode: group.mode,
        sourceAddresses: sources,
        targetAddresses: uniqueTargets,
        results: pairs,
      };
    }

    return {
      tokenType: group.tokenType,
      mode: group.mode,
      sourceAddresses: sources,
      targetAddresses: targets,
      results: pairs,
    };
  }).filter(plan => plan.sourceAddresses.length > 0 && plan.targetAddresses.length > 0);
}
