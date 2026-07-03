// NOTE: model-pricing.json 是自动生成的，唯一真实来源在 shared/model-pricing.json
// 修改定价请编辑 shared/model-pricing.json，然后运行 npm run build 或 node scripts/sync-pricing.js
import pricingData from '../data/model-pricing.json';

export function estimateNeurons(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  promptTokens = promptTokens || 0;
  completionTokens = completionTokens || 0;
  const rate = pricingData.models[model as keyof typeof pricingData.models] ?? pricingData.default;
  const neurons = (promptTokens / 1000) * rate.input
                + (completionTokens / 1000) * rate.output;
  return Math.max(1, Math.round(neurons));
}
